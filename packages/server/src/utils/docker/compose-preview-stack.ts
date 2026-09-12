import { createHash } from "node:crypto";
import type { Domain } from "../../services/domain";
import type { Registry } from "../../services/registry";
import { createDomainLabels } from "./domain";
import type { ComposeSpecification } from "./types";

export function previewImageRemovalReferences(
	image: { Id: string; RepoTags?: string[]; Labels?: Record<string, string> },
	appName: string,
	inUse: Set<string>,
) {
	if (
		image.Labels?.["com.dokploy.preview-app"] !== appName ||
		inUse.has(image.Id)
	)
		return [];
	const tags = (image.RepoTags || []).filter((tag) => tag !== "<none>:<none>");
	if (!tags.length) return [image.Id];
	return tags.filter((tag) => {
		const leaf = tag.slice(tag.lastIndexOf("/") + 1);
		return (
			leaf.startsWith(`${appName}-`) &&
			/^[a-f0-9]{8}:[^/]+$/.test(leaf.slice(appName.length + 1))
		);
	});
}

export function assignPreviewImages(
	spec: ComposeSpecification,
	appName: string,
	generation: string,
	registry: Pick<Registry, "registryUrl" | "imagePrefix" | "username">,
) {
	const namespace = `${registry.registryUrl?.replace(/\/+$/, "") || "docker.io"}/${(registry.imagePrefix || registry.username).toLowerCase()}`;
	const images = new Map<string, string>();
	for (const [name, service] of Object.entries(spec.services || {})) {
		if (!service.build) continue;
		const suffix = createHash("sha256").update(name).digest("hex").slice(0, 8);
		const image = `${namespace}/${appName}-${suffix}:${generation}`;
		service.build = {
			...(typeof service.build === "string"
				? { context: service.build }
				: service.build),
			labels: { "com.dokploy.preview-app": appName },
		};
		if (service.image) images.set(service.image, image);
		else service.image = image;
	}
	for (const service of Object.values(spec.services || {})) {
		if (service.image && images.has(service.image))
			service.image = images.get(service.image);
	}
	return spec;
}

/** Swarm consumes the v3 schema; build happens separately on the worker.
 * Every service is pinned to the selected node, including stateful services. */
export function createPreviewStack(
	input: ComposeSpecification,
	options: {
		appName: string;
		previewId: string;
		nodeId: string;
		generation: string;
		domains: Domain[];
	},
): ComposeSpecification {
	const spec = structuredClone(input);
	for (const domain of options.domains)
		if (!domain.serviceName || !spec.services?.[domain.serviceName])
			throw new Error("Preview domain refers to a missing Compose service");
	delete spec.name;
	spec.version = "3.8";
	spec.networks = {
		default: {
			driver: "overlay",
			attachable: true,
			driver_opts: { "com.docker.network.driver.mtu": "1200" },
		},
	};
	for (const [name, service] of Object.entries(spec.services || {})) {
		if (!service.image) throw new Error(`Preview service ${name} has no image`);
		if (service.command === null) delete service.command;
		if (service.entrypoint === null) delete service.entrypoint;
		service.networks = ["default"];
		for (const key of [
			"build",
			"restart",
			"depends_on",
			"pull_policy",
			"cpus",
			"mem_limit",
			"pids_limit",
			"security_opt",
			"platform",
			"develop",
			"profiles",
		])
			delete service[key];
		service.deploy = {
			...service.deploy,
			resources: {
				...service.deploy?.resources,
				limits: {
					...service.deploy?.resources?.limits,
					cpus: String(service.deploy?.resources?.limits?.cpus),
					memory: String(service.deploy?.resources?.limits?.memory),
				},
			},
			mode: "replicated",
			// Start only after the controller applies Swarm-only process limits.
			replicas: 0,
			placement: { constraints: [`node.id==${options.nodeId}`] },
			labels: {
				"com.dokploy.compose-preview": options.previewId,
				"traefik.enable": "false",
			},
			update_config: {
				parallelism: 1,
				order: "stop-first",
				failure_action: "pause",
			},
			restart_policy: { condition: "any", delay: "5s" },
		};
		// The legacy stack schema cannot represent this Swarm API option.
		if (service.deploy.resources?.limits)
			delete service.deploy.resources.limits.pids;
		service.labels = [
			`com.dokploy.preview-id=${options.previewId}`,
			`com.dokploy.preview-generation=${options.generation}`,
			"com.dokploy.preview=true",
		];
		for (const domain of options.domains.filter(
			(domain) => domain.serviceName === name,
		)) {
			service.labels.push(
				"traefik.enable=true",
				`traefik.docker.network=${options.appName}_default`,
				...createDomainLabels(
					options.appName,
					{ ...domain, https: false, certificateType: "none" },
					"web",
				),
			);
		}
		service.labels = [...new Set(service.labels)];
		// Config rendering resolves relative paths on the build worker. Local
		// bind mounts stay on that same pinned worker; configs/secrets must be
		// converted to inline contents before transmitting to the manager.
	}
	for (const [name, volume] of Object.entries(spec.volumes || {})) {
		if (spec.volumes)
			spec.volumes[name] = {
				...volume,
				labels: { "com.dokploy.preview-id": options.previewId },
			};
	}
	// Swarm configs/secrets are immutable. A new generation must use new
	// resource names while service references keep their logical Compose keys.
	for (const [kind, entries] of Object.entries({
		configs: spec.configs,
		secrets: spec.secrets,
	})) {
		for (const [name, entry] of Object.entries(entries || {})) {
			if (!entry) continue;
			const suffix = createHash("sha256")
				.update(`${kind}:${name}:${options.generation}`)
				.digest("hex")
				.slice(0, 16);
			entry.name = `${options.appName}-${suffix}`;
			entry.labels = { "com.dokploy.preview-id": options.previewId };
		}
	}
	return spec;
}
