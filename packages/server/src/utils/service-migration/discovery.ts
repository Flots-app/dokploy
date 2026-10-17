import path from "node:path";
import { quote } from "shell-quote";
import { parse } from "yaml";
import type { FileConfig } from "../traefik/file-types";
import type { HostExecutor } from "./host";
import type { MigrationService } from "./service";

/** Image used to read and write volume data on both servers (same image as volume backups). */
export const MIGRATION_HELPER_IMAGE = "ubuntu";

/** Compose files describing the active zero-downtime release; the target builds its own. */
export const COMPOSE_RUNTIME_STATE_ENTRIES = [
	"releases",
	"runtime.compose.json",
	"active-release.json",
	"activation.json",
	"cleanup-pending.json",
	".cancel-requested",
	".activation.lock",
];

const SYSTEM_PATH_PREFIXES = [
	"/bin",
	"/boot",
	"/dev",
	"/etc",
	"/lib",
	"/lib32",
	"/lib64",
	"/proc",
	"/run",
	"/sbin",
	"/sys",
	"/tmp",
	"/usr",
	"/var/lib/containerd",
	"/var/lib/docker",
	"/var/log",
	"/var/run",
];

export interface SwarmServiceSnapshot {
	name: string;
	exists: boolean;
	image: string | null;
	/** null for global services. */
	desiredReplicas: number | null;
	runningTasks: number;
	deploymentId: string | null;
	volumeNames: string[];
	bindPaths: string[];
}

export interface PreviewSnapshot extends SwarmServiceSnapshot {
	previewDeploymentId: string;
}

export interface ComposeContainerSnapshot {
	id: string;
	name: string;
	state: string;
}

export interface ComposeSnapshot {
	containers: ComposeContainerSnapshot[];
	runningContainers: number;
	stackServices: { name: string; replicas: number | null }[];
}

export interface VolumeSnapshot {
	name: string;
	driver: string;
	labels: Record<string, string>;
	options: Record<string, string>;
	sizeBytes: number | null;
	/** Data lives outside the server (NFS, plugin driver…): only the definition is recreated. */
	externalStorage: boolean;
}

export interface BindSnapshot {
	path: string;
	exists: boolean;
	sizeBytes: number | null;
	/** Set when the path is not copied. */
	skipReason: string | null;
}

export interface DirectorySnapshot {
	label: string;
	sourcePath: string;
	targetPath: string;
	sizeBytes: number;
	exclude: string[];
}

export interface TraefikSnapshot {
	appName: string;
	config: string;
	middlewares: Record<string, unknown>;
}

export interface SourceSnapshot {
	platform: string | null;
	uid: string;
	gid: string;
	service: SwarmServiceSnapshot | null;
	previews: PreviewSnapshot[];
	compose: ComposeSnapshot | null;
	volumes: VolumeSnapshot[];
	/** Declared by Dokploy but never created on the source: created empty by the deploy. */
	missingVolumes: string[];
	binds: BindSnapshot[];
	directories: DirectorySnapshot[];
	traefik: TraefikSnapshot[];
	helperImagePresent: boolean;
}

const lines = (output: string) =>
	output
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);

const parseJson = <T>(value: string): T | null => {
	try {
		return JSON.parse(value) as T;
	} catch {
		return null;
	}
};

export const isPathInside = (child: string, parent: string) => {
	const relative = path.posix.relative(parent, child);
	return (
		relative === "" ||
		(!relative.startsWith("..") && !path.isAbsolute(relative))
	);
};

export const getServiceDirectory = (
	service: Pick<MigrationService, "type" | "appName">,
	executor: HostExecutor,
) =>
	path.posix.join(
		service.type === "compose"
			? executor.paths.COMPOSE_PATH
			: executor.paths.APPLICATIONS_PATH,
		service.appName,
	);

interface ServiceSpec {
	Labels?: Record<string, string>;
	Mode?: { Replicated?: { Replicas?: number }; Global?: object };
	TaskTemplate?: {
		ContainerSpec?: {
			Image?: string;
			Mounts?: Array<{ Type?: string; Source?: string }>;
		};
	};
}

export const inspectSwarmService = async (
	executor: HostExecutor,
	name: string,
): Promise<SwarmServiceSnapshot> => {
	const inspect = await executor.run(
		`docker service inspect ${quote([name])} --format '{{json .Spec}}'`,
		{ allowFailure: true },
	);
	const spec =
		inspect.exitCode === 0
			? parseJson<ServiceSpec>(inspect.stdout.trim())
			: null;
	if (!spec) {
		return {
			name,
			exists: false,
			image: null,
			desiredReplicas: null,
			runningTasks: 0,
			deploymentId: null,
			volumeNames: [],
			bindPaths: [],
		};
	}
	const tasks = await executor.run(
		`docker service ps ${quote([name])} --filter desired-state=running --format '{{.CurrentState}}'`,
		{ allowFailure: true },
	);
	const mounts = spec.TaskTemplate?.ContainerSpec?.Mounts ?? [];
	return {
		name,
		exists: true,
		image: spec.TaskTemplate?.ContainerSpec?.Image ?? null,
		desiredReplicas: spec.Mode?.Global
			? null
			: (spec.Mode?.Replicated?.Replicas ?? 1),
		runningTasks: lines(tasks.stdout).filter((state) =>
			state.startsWith("Running"),
		).length,
		deploymentId: spec.Labels?.["com.dokploy.deployment-id"] ?? null,
		volumeNames: mounts
			.filter((mount) => mount.Type === "volume" && mount.Source)
			.map((mount) => mount.Source as string),
		bindPaths: mounts
			.filter((mount) => mount.Type === "bind" && mount.Source)
			.map((mount) => mount.Source as string),
	};
};

export const composeContainerFilters = (
	service: Pick<MigrationService, "id" | "appName">,
) => [
	`label=com.dokploy.compose-id=${service.id}`,
	`label=com.docker.compose.project=${service.appName}`,
	`label=com.docker.stack.namespace=${service.appName}`,
];

/** Shell snippet printing the ids of every container belonging to the Compose service. */
export const composeContainerIdsCommand = (
	service: Pick<MigrationService, "id" | "appName">,
) =>
	`{ ${composeContainerFilters(service)
		.map((filter) => `docker ps -aq --no-trunc --filter ${quote([filter])};`)
		.join(" ")} } | sort -u`;

const inspectCompose = async (
	executor: HostExecutor,
	service: MigrationService,
) => {
	const ids = lines(
		(await executor.run(composeContainerIdsCommand(service))).stdout,
	);
	const containers: ComposeContainerSnapshot[] = [];
	const volumeNames = new Set<string>();
	const bindPaths = new Set<string>();
	if (ids.length > 0) {
		const inspect = await executor.run(
			`docker inspect --format '{{json .}}' ${quote(ids)}`,
		);
		for (const line of lines(inspect.stdout)) {
			const container = parseJson<{
				Id: string;
				Name: string;
				State?: { Status?: string };
				Mounts?: Array<{ Type?: string; Name?: string; Source?: string }>;
			}>(line);
			if (!container) continue;
			containers.push({
				id: container.Id,
				name: container.Name.replace(/^\//, ""),
				state: container.State?.Status ?? "unknown",
			});
			for (const mount of container.Mounts ?? []) {
				if (mount.Type === "volume" && mount.Name) volumeNames.add(mount.Name);
				if (mount.Type === "bind" && mount.Source) bindPaths.add(mount.Source);
			}
		}
	}
	const projectVolumes = await executor.run(
		[
			`docker volume ls -q --filter ${quote([`label=com.docker.compose.project=${service.appName}`])}`,
			`docker volume ls -q --filter ${quote([`label=com.docker.stack.namespace=${service.appName}`])}`,
		].join("; "),
	);
	for (const name of lines(projectVolumes.stdout)) volumeNames.add(name);

	const stackServices: ComposeSnapshot["stackServices"] = [];
	if (service.composeType === "stack") {
		const services = await executor.run(
			`docker service ls --filter ${quote([`label=com.docker.stack.namespace=${service.appName}`])} --format '{{.Name}}|{{.Mode}}|{{.Replicas}}'`,
			{ allowFailure: true },
		);
		for (const line of lines(services.stdout)) {
			const [name, mode, replicas] = line.split("|");
			if (!name) continue;
			const desired = replicas?.split("/")[1];
			stackServices.push({
				name,
				replicas:
					mode === "global" ? null : Number.parseInt(desired || "0", 10) || 0,
			});
		}
	}

	return {
		snapshot: {
			containers,
			runningContainers: containers.filter(
				(container) => container.state === "running",
			).length,
			stackServices,
		} satisfies ComposeSnapshot,
		volumeNames: [...volumeNames],
		bindPaths: [...bindPaths],
	};
};

export const inspectVolumes = async (
	executor: HostExecutor,
	names: string[],
) => {
	const volumes = new Map<string, Omit<VolumeSnapshot, "sizeBytes"> | null>();
	for (const name of names) {
		const result = await executor.run(
			`docker volume inspect ${quote([name])} --format '{{json .}}'`,
			{ allowFailure: true },
		);
		const volume =
			result.exitCode === 0
				? parseJson<{
						Name: string;
						Driver: string;
						Labels: Record<string, string> | null;
						Options: Record<string, string> | null;
					}>(result.stdout.trim())
				: null;
		volumes.set(
			name,
			volume
				? {
						name: volume.Name,
						driver: volume.Driver,
						labels: volume.Labels ?? {},
						options: volume.Options ?? {},
						externalStorage:
							volume.Driver !== "local" ||
							Boolean(volume.Options?.type || volume.Options?.device),
					}
				: null,
		);
	}
	return volumes;
};

/** Makes sure the helper image is available, pulling it when needed. */
export const ensureHelperImage = async (executor: HostExecutor) => {
	const result = await executor.run(
		`docker image inspect ${MIGRATION_HELPER_IMAGE} >/dev/null 2>&1 || docker pull ${MIGRATION_HELPER_IMAGE} >/dev/null 2>&1`,
		{ allowFailure: true },
	);
	return result.exitCode === 0;
};

const helperRun = (mounts: string[], script: string) =>
	`docker run --rm --log-driver none --network none ${mounts.join(" ")} ${MIGRATION_HELPER_IMAGE} sh -c ${quote([script])}`;

const measureVolumes = async (executor: HostExecutor, names: string[]) => {
	const sizes = new Map<string, number>();
	if (names.length === 0) return sizes;
	const mounts = names.map(
		(name, index) =>
			`--mount ${quote([`type=volume,source=${name},target=/migration/${index},readonly`])}`,
	);
	const script = names
		.map(
			(_, index) =>
				`printf '%s ' ${index}; du -sk /migration/${index} | cut -f1`,
		)
		.join("; ");
	const result = await executor.run(helperRun(mounts, script), {
		allowFailure: true,
	});
	for (const line of lines(result.stdout)) {
		const [index, size] = line.split(" ");
		const name = names[Number(index)];
		if (name && size) sizes.set(name, Number(size) * 1024);
	}
	return sizes;
};

const measureBind = async (executor: HostExecutor, hostPath: string) => {
	const result = await executor.run(
		helperRun(
			[
				`--mount ${quote([`type=bind,source=${hostPath},target=/migration,readonly`])}`,
			],
			"du -sk /migration | cut -f1",
		),
		{ allowFailure: true },
	);
	if (result.exitCode !== 0) return null;
	const size = Number(result.stdout.trim());
	return Number.isFinite(size) ? size * 1024 : null;
};

export const bindSkipReason = (
	hostPath: string,
	serviceDirectory: string,
): string | null => {
	if (!path.posix.isAbsolute(hostPath)) return "Not an absolute host path";
	const normalized = path.posix.normalize(hostPath);
	if (normalized === "/") return "Host root filesystem";
	if (isPathInside(normalized, serviceDirectory)) {
		return "Copied with the service directory";
	}
	if (SYSTEM_PATH_PREFIXES.some((prefix) => isPathInside(normalized, prefix))) {
		return "Host system path: it must already exist on the target";
	}
	return null;
};

const directorySize = async (executor: HostExecutor, directory: string) => {
	const result = await executor.run(
		`if [ -d ${quote([directory])} ]; then du -sk ${quote([directory])} 2>/dev/null | cut -f1; else echo missing; fi`,
		{ allowFailure: true },
	);
	const output = result.stdout.trim().split("\n").pop() || "";
	if (output === "missing" || output === "") return null;
	const size = Number(output);
	return Number.isFinite(size) ? size * 1024 : 0;
};

const readFile = async (executor: HostExecutor, file: string) => {
	const result = await executor.run(`cat ${quote([file])}`, {
		allowFailure: true,
	});
	return result.exitCode === 0 ? result.stdout : null;
};

export const readMiddlewares = async (executor: HostExecutor) => {
	const content = await readFile(
		executor,
		path.posix.join(executor.paths.DYNAMIC_TRAEFIK_PATH, "middlewares.yml"),
	);
	if (!content) return null;
	return (parse(content) as FileConfig | null) ?? {};
};

/** Middlewares referenced by the routers of a Traefik dynamic configuration. */
export const referencedMiddlewares = (config: FileConfig | null) => {
	const names = new Set<string>();
	for (const router of Object.values(config?.http?.routers ?? {})) {
		for (const middleware of router.middlewares ?? []) {
			names.add(middleware.replace(/@file$/, ""));
		}
	}
	return names;
};

const inspectTraefik = async (
	executor: HostExecutor,
	appNames: string[],
): Promise<TraefikSnapshot[]> => {
	const middlewares =
		(await readMiddlewares(executor))?.http?.middlewares ?? {};
	const snapshots: TraefikSnapshot[] = [];
	for (const appName of appNames) {
		const config = await readFile(
			executor,
			path.posix.join(executor.paths.DYNAMIC_TRAEFIK_PATH, `${appName}.yml`),
		);
		if (!config?.trim()) continue;
		const names = referencedMiddlewares(parse(config) as FileConfig | null);
		for (const name of Object.keys(middlewares)) {
			if (name.includes(appName)) names.add(name);
		}
		snapshots.push({
			appName,
			config,
			middlewares: Object.fromEntries(
				[...names]
					.filter((name) => name in middlewares)
					.map((name) => [name, middlewares[name]]),
			),
		});
	}
	return snapshots;
};

/** Reads everything the source server holds for the service. Read-only. */
export const discoverSource = async (
	service: MigrationService,
	source: HostExecutor,
	target: HostExecutor,
): Promise<SourceSnapshot> => {
	const identity = await source.run(
		"docker info --format '{{.OSType}}/{{.Architecture}}'; id -u; id -g",
	);
	const [platform, uid, gid] = lines(identity.stdout);

	const serviceDirectory = getServiceDirectory(service, source);
	const volumeNames = new Set(
		service.mounts
			.filter((mount) => mount.type === "volume" && mount.volumeName)
			.map((mount) => mount.volumeName as string),
	);
	const bindPaths = new Set(
		service.mounts
			.filter((mount) => mount.type === "bind" && mount.hostPath)
			.map((mount) => mount.hostPath as string),
	);

	let swarmService: SwarmServiceSnapshot | null = null;
	let compose: ComposeSnapshot | null = null;
	const previews: PreviewSnapshot[] = [];
	if (service.type === "compose") {
		const result = await inspectCompose(source, service);
		compose = result.snapshot;
		for (const name of result.volumeNames) volumeNames.add(name);
		for (const bind of result.bindPaths) bindPaths.add(bind);
	} else {
		swarmService = await inspectSwarmService(source, service.appName);
		for (const name of swarmService.volumeNames) volumeNames.add(name);
		for (const bind of swarmService.bindPaths) bindPaths.add(bind);
		for (const preview of service.previews) {
			const snapshot = await inspectSwarmService(source, preview.appName);
			if (snapshot.exists) {
				previews.push({
					...snapshot,
					previewDeploymentId: preview.previewDeploymentId,
				});
			}
		}
	}

	const volumeDefinitions = await inspectVolumes(source, [...volumeNames]);
	const existingVolumes = [...volumeDefinitions.values()].filter(
		(volume): volume is Omit<VolumeSnapshot, "sizeBytes"> => volume !== null,
	);
	const missingVolumes = [...volumeDefinitions.entries()]
		.filter(([, volume]) => volume === null)
		.map(([name]) => name);

	// Volume and bind sizes are read through the helper image, like the copy itself.
	const helperImagePresent = await ensureHelperImage(source);
	const sizes = helperImagePresent
		? await measureVolumes(
				source,
				existingVolumes
					.filter((volume) => !volume.externalStorage)
					.map((volume) => volume.name),
			)
		: new Map<string, number>();
	const volumes: VolumeSnapshot[] = existingVolumes.map((volume) => ({
		...volume,
		sizeBytes: sizes.get(volume.name) ?? null,
	}));

	const binds: BindSnapshot[] = [];
	for (const bindPath of bindPaths) {
		const skipReason = bindSkipReason(bindPath, serviceDirectory);
		// File mounts and relative Compose binds travel with the service directory.
		if (isPathInside(path.posix.normalize(bindPath), serviceDirectory))
			continue;
		if (skipReason) {
			binds.push({ path: bindPath, exists: true, sizeBytes: null, skipReason });
			continue;
		}
		if (!helperImagePresent) {
			binds.push({ path: bindPath, exists: true, sizeBytes: null, skipReason });
			continue;
		}
		const sizeBytes = await measureBind(source, bindPath);
		binds.push({
			path: bindPath,
			exists: sizeBytes !== null,
			sizeBytes,
			skipReason: sizeBytes === null ? "Missing on the source server" : null,
		});
	}

	const directories: DirectorySnapshot[] = [];
	const serviceDirectorySize = await directorySize(source, serviceDirectory);
	if (serviceDirectorySize !== null) {
		directories.push({
			label:
				service.type === "compose"
					? "Compose directory (code, files and mounts)"
					: "Service directory (file mounts)",
			sourcePath: serviceDirectory,
			targetPath: getServiceDirectory(service, target),
			sizeBytes: serviceDirectorySize,
			exclude: service.type === "compose" ? COMPOSE_RUNTIME_STATE_ENTRIES : [],
		});
	}
	const logOwners = [
		{ appName: service.appName, label: "Deployment logs" },
		...service.backups.map((item) => ({
			appName: item.appName,
			label: `Logs: ${item.label}`,
		})),
		...service.volumeBackups.map((item) => ({
			appName: item.appName,
			label: `Logs: volume backup ${item.label}`,
		})),
		...service.schedules.map((item) => ({
			appName: item.appName,
			label: `Logs: schedule ${item.label}`,
		})),
	];
	for (const owner of logOwners) {
		const sourcePath = path.posix.join(source.paths.LOGS_PATH, owner.appName);
		const sizeBytes = await directorySize(source, sourcePath);
		if (sizeBytes === null) continue;
		directories.push({
			label: owner.label,
			sourcePath,
			targetPath: path.posix.join(target.paths.LOGS_PATH, owner.appName),
			sizeBytes,
			exclude: [],
		});
	}

	const traefik =
		service.type === "application"
			? await inspectTraefik(source, [
					service.appName,
					...previews.map((preview) => preview.name),
				])
			: [];

	return {
		platform: platform ?? null,
		uid: uid ?? "0",
		gid: gid ?? "0",
		service: swarmService,
		previews,
		compose,
		volumes,
		missingVolumes,
		binds,
		directories,
		traefik,
		helperImagePresent,
	};
};

/** Volumes and host paths whose content is streamed to the target. */
export const hasDataToCopy = (snapshot: SourceSnapshot) =>
	snapshot.volumes.some((volume) => !volume.externalStorage) ||
	snapshot.binds.some((bind) => !bind.skipReason);

/**
 * Whether the target can be started while the source keeps serving. Data is then
 * copied live, which overlap-safe services accept by contract.
 */
export const runsWithoutDowntime = (
	service: MigrationService,
	snapshot: SourceSnapshot,
	zeroDowntime: boolean,
) =>
	(zeroDowntime && service.supportsZeroDowntime) ||
	(service.type === "application" && !hasDataToCopy(snapshot));

/** True when the service is stopped on the source before its data is copied. */
export const requiresDowntime = (
	service: MigrationService,
	snapshot: SourceSnapshot,
	zeroDowntime: boolean,
) => !runsWithoutDowntime(service, snapshot, zeroDowntime);
