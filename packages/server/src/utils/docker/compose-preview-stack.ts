import { createHash } from "node:crypto";
import { quote } from "shell-quote";
import type { Domain } from "../../services/domain";
import type { Registry } from "../../services/registry";
import { ComposePreviewError } from "./compose-preview";
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

/** Docker reports Docker Hub references in their short ("familiar") form. */
function familiarRepository(reference: string) {
	return reference
		.replace(/^(?:docker\.io|index\.docker\.io|registry-1\.docker\.io)\//, "")
		.replace(/^library\//, "");
}

/**
 * Pick the immutable digest of a pushed image from `RepoDigests`. The image
 * may be named `docker.io/team/app:tag` while Docker reports `team/app@sha…`.
 */
export function findPushedImageDigest(image: string, repoDigests: string[]) {
	const colon = image.lastIndexOf(":");
	const repository = familiarRepository(
		colon > image.lastIndexOf("/") ? image.slice(0, colon) : image,
	);
	const digest = repoDigests.find(
		(value) =>
			familiarRepository(value.slice(0, value.indexOf("@"))) === repository,
	);
	return digest ? `${repository}${digest.slice(digest.indexOf("@"))}` : null;
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
			throw new ComposePreviewError(
				"Preview domain refers to a missing Compose service",
			);
	delete spec.name;
	// 3.12 is the first stack schema with deploy.resources.limits.pids
	// (Docker CLI 25+), so the process limit applies from the first task.
	spec.version = "3.12";
	spec.networks = {
		default: {
			driver: "overlay",
			attachable: true,
			driver_opts: { "com.docker.network.driver.mtu": "1200" },
		},
	};
	for (const [name, service] of Object.entries(spec.services || {})) {
		if (!service.image)
			throw new ComposePreviewError(`Preview service ${name} has no image`);
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
			replicas: 1,
			placement: { constraints: [`node.id==${options.nodeId}`] },
			labels: {
				"com.dokploy.compose-preview": options.previewId,
				"traefik.enable": "false",
			},
			update_config: {
				parallelism: 1,
				order: "stop-first",
				// Roll a service back when its new tasks fail to start, so a broken
				// commit does not take down a working PR environment.
				failure_action: "rollback",
				// Shorter than the controller's stability window (20 s), so a
				// rollback always happens before a deploy is reported ready.
				monitor: "15s",
			},
			restart_policy: { condition: "any", delay: "5s" },
		};
		// Keep the developer's own labels (isolation already removed reserved
		// prefixes), then add the ownership labels cleanup relies on.
		const ownLabels = Array.isArray(service.labels)
			? service.labels
			: Object.entries(service.labels || {}).map(
					([key, value]) => `${key}=${value ?? ""}`,
				);
		service.labels = [
			...ownLabels.filter(
				(label) => !/^(traefik\.|com\.docker\.|com\.dokploy\.)/.test(label),
			),
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

const PREVIEW_TASKS_TITLE = "Diagnostics: Swarm tasks";
const PREVIEW_TASK_SUMMARY_LIMIT = 8;

interface PreviewStackTask {
	Name?: string;
	Node?: string;
	CurrentState?: string;
	DesiredState?: string;
	Error?: string;
}

/** Swarm task history, including tasks that never got a container. */
export function getPreviewStackTasksCommand(appName: string) {
	return `docker stack ps --no-trunc --format '{{json .}}' ${quote([appName])}`;
}

export function previewServiceName(appName: string, name: string) {
	return name.startsWith(`${appName}_`) ? name.slice(appName.length + 1) : name;
}

export function formatPreviewStackTasks(stdout: string, appName: string) {
	const tasks = stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const parsed: unknown = JSON.parse(line);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
				throw new TypeError("Unexpected docker stack ps output");
			return parsed as PreviewStackTask;
		});
	if (!tasks.length)
		return {
			section: `\n===== ${PREVIEW_TASKS_TITLE} =====\nNo Swarm tasks were found for this preview.\n`,
			summary: "",
		};
	const rows = tasks.map((task) => {
		const state = task.CurrentState || "unknown";
		return {
			// History rows are indented with "\_" by the Docker CLI.
			name: previewServiceName(
				appName,
				(task.Name || "unknown").replace(/^[\s\\_]+/, ""),
			),
			state,
			failing: Boolean(task.Error) || /^(Failed|Rejected)/.test(state),
			running: state.startsWith("Running"),
			task,
		};
	});
	const width = Math.max(...rows.map((row) => row.name.length));
	const lines = rows.map(
		(row) =>
			`${row.failing ? "✗" : row.running ? "✓" : "!"} ${row.name.padEnd(width)}  ${row.state} (desired: ${row.task.DesiredState || "unknown"})${row.task.Node ? ` on ${row.task.Node}` : ""}${row.task.Error ? `\n    ${row.task.Error}` : ""}`,
	);
	const errors = [
		...new Set(
			rows
				.filter((row) => row.failing)
				.map(
					(row) =>
						`- ${row.name}: ${row.state} — ${row.task.Error || "no error reported"}`,
				),
		),
	];
	return {
		section: `\n===== ${PREVIEW_TASKS_TITLE} =====\n${lines.join("\n")}\n`,
		summary: errors.length
			? [
					"Swarm tasks with errors:",
					...errors.slice(0, PREVIEW_TASK_SUMMARY_LIMIT),
					...(errors.length > PREVIEW_TASK_SUMMARY_LIMIT
						? [
								`  …and ${errors.length - PREVIEW_TASK_SUMMARY_LIMIT} more in the deployment log`,
							]
						: []),
				].join("\n")
			: "",
	};
}
