import { createHash } from "node:crypto";
import type { z } from "zod";
import type { composePreviewSettingsSchema } from "../../db/validations/compose-preview";
import type { ComposeSpecification, DefinitionsService } from "./types";

export type ComposePreviewSettings = z.infer<
	typeof composePreviewSettingsSchema
>;

export function previewAppName(sourceId: string, pr: number) {
	return `preview-${createHash("sha256").update(sourceId).digest("hex").slice(0, 12)}-pr-${pr}`;
}

export function previewHost(
	appName: string,
	service: string,
	domain: string,
	route = "",
) {
	const slug = service
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.slice(0, 18)
		.replace(/-+$/, "");
	const hash = createHash("sha256")
		.update(`${service}:${route}`)
		.digest("hex")
		.slice(0, 6);
	return `${appName}-${slug}-${hash}.${domain}`;
}

export function repositoryPath(path: string) {
	if (
		!path ||
		[...path].some((character) => character.charCodeAt(0) < 32) ||
		path.startsWith("/") ||
		path.startsWith("~") ||
		path.includes("\\") ||
		path.split("/").includes("..") ||
		path.includes("${")
	) {
		throw new Error(
			"Preview file mounts must use fixed paths inside the repository",
		);
	}
}

function cleanLabels(labels: DefinitionsService["labels"]) {
	return Object.fromEntries(
		(Array.isArray(labels)
			? labels.map((label) => {
					const index = label.indexOf("=");
					return [
						index < 0 ? label : label.slice(0, index),
						index < 0 ? "" : label.slice(index + 1),
					];
				})
			: Object.entries(labels || {})
		).filter(
			([key]) => !/^(traefik\.|com\.docker\.|com\.dokploy\.)/.test(String(key)),
		),
	);
}

/** Normalize before any Docker build/up, so names, host ports and shared
 * resources from staging cannot couple two previews or existing workloads. */
export function isolatePreviewCompose(
	input: ComposeSpecification,
	appName: string,
	settings: ComposePreviewSettings,
): ComposeSpecification {
	const spec = structuredClone(input);
	if (!spec || !spec.services || !Object.keys(spec.services).length)
		throw new Error("Preview Compose requires services");
	if (spec.include)
		throw new Error(
			"Compose include is not supported for previews; use a complete preview file",
		);
	spec.name = appName;
	spec.networks = { default: {} };
	const images = new Map<string, string>();
	for (const [name, service] of Object.entries(spec.services)) {
		if (service.build && service.image)
			images.set(service.image, `${appName}-${name.toLowerCase()}:preview`);
	}
	for (const [name, service] of Object.entries(spec.services)) {
		for (const property of [
			"extends",
			"network_mode",
			"pid",
			"ipc",
			"devices",
			"device_cgroup_rules",
			"volumes_from",
			"external_links",
			"cap_add",
			"use_api_socket",
			"develop",
			"cgroup",
			"cgroup_parent",
			"userns_mode",
			"uts",
			"sysctls",
			"credential_spec",
			"gpus",
			"label_file",
			"post_start",
			"pre_stop",
		]) {
			if (service[property])
				throw new Error(
					`Preview service ${name}: ${property} is not supported`,
				);
		}
		if (service.privileged)
			throw new Error(`Preview service ${name} cannot be privileged`);
		if (
			typeof service.build === "object" &&
			service.build &&
			(service.build.privileged ||
				service.build.entitlements ||
				service.build.network ||
				service.build.additional_contexts ||
				service.build.ssh ||
				service.build.secrets)
		)
			throw new Error(`Preview service ${name} requests a privileged build`);
		delete service.container_name;
		delete service.ports;
		delete service.profiles;
		service.networks = ["default"];
		service.labels = [
			...Object.entries(cleanLabels(service.labels)).map(
				([key, value]) => `${key}=${value}`,
			),
			"com.dokploy.preview=true",
		];
		service.deploy = {
			replicas: 1,
			resources: {
				limits: {
					cpus: String(settings.cpuLimit),
					memory: `${settings.memoryLimitMb}M`,
					pids: 512,
				},
			},
		};
		service.cpus = settings.cpuLimit;
		service.mem_limit = `${settings.memoryLimitMb}M`;
		service.pids_limit = 512;
		service.security_opt = ["no-new-privileges:true"];
		if (service.image && images.has(service.image))
			service.image = images.get(service.image);
		if (service.build) {
			const build =
				typeof service.build === "string"
					? { context: service.build }
					: service.build;
			repositoryPath(build.context || ".");
			if (build.dockerfile) repositoryPath(build.dockerfile);
		}
		for (const entry of Array.isArray(service.env_file)
			? service.env_file
			: service.env_file
				? [service.env_file]
				: [])
			repositoryPath(typeof entry === "string" ? entry : entry.path);
		for (const volume of service.volumes || []) {
			const source =
				typeof volume === "string" ? volume.split(":")[0] : volume.source;
			const anonymous =
				typeof volume === "string" ? !volume.includes(":") : !source;
			if (anonymous)
				throw new Error(
					`Preview service ${name}: use declared named volumes instead of anonymous mounts`,
				);
			if (
				!source ||
				!Object.hasOwn(spec.volumes || {}, source) ||
				(typeof volume !== "string" && volume.type !== "volume")
			)
				throw new Error(
					`Preview service ${name}: only declared named volumes are supported; bake repository files into the image`,
				);
		}
	}
	for (const definitions of [spec.volumes, spec.configs, spec.secrets]) {
		for (const definition of Object.values(definitions || {})) {
			if (!definition) continue;
			if (
				definition.external ||
				definition.driver_opts ||
				(definition.driver && definition.driver !== "local")
			)
				throw new Error(
					"Preview volumes, configs and secrets cannot use external resources or driver options",
				);
			delete definition.name;
			if (typeof definition.file === "string") repositoryPath(definition.file);
		}
	}
	return spec;
}
