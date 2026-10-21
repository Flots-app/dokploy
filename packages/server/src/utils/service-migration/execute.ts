import path from "node:path";
import { db } from "@dokploy/server/db";
import {
	deployments,
	type ServiceMigrationOptions,
	type ServiceMigrationSourceCleanup,
} from "@dokploy/server/db/schema";
import { findApplicationById } from "@dokploy/server/services/application";
import { rebuildCompose } from "@dokploy/server/services/compose";
import { deployLibsql } from "@dokploy/server/services/libsql";
import { deployMariadb } from "@dokploy/server/services/mariadb";
import { deployMongo } from "@dokploy/server/services/mongo";
import { createFileMount } from "@dokploy/server/services/mount";
import { deployMySql } from "@dokploy/server/services/mysql";
import { deployPostgres } from "@dokploy/server/services/postgres";
import { findPreviewDeploymentById } from "@dokploy/server/services/preview-deployment";
import { deployRedis } from "@dokploy/server/services/redis";
import { findRegistryByIdWithCredentials } from "@dokploy/server/services/registry";
import { getDefaultMiddlewares } from "@dokploy/server/setup/traefik-setup";
import { desc, eq } from "drizzle-orm";
import { quote } from "shell-quote";
import { parse, stringify } from "yaml";
import { mechanizeDockerContainer } from "../builders";
import {
	getComposeRegistryLoginCommand,
	getWaitTraefikRoutersCommand,
} from "../builders/compose-build-server";
import { execAsyncRemote } from "../process/execAsync";
import { removeTraefikConfig } from "../traefik/application";
import { manageDomain } from "../traefik/domain";
import type { FileConfig } from "../traefik/file-types";
import { deleteAllMiddlewares } from "../traefik/middleware";
import { createRedirectMiddleware } from "../traefik/redirect";
import { createSecurityMiddleware } from "../traefik/security";
import { formatBytes, type ServiceMigrationAnalysis } from "./analyze";
import {
	mapWithConcurrency,
	SSH_PROBE_CONCURRENCY,
	sequentially,
} from "./concurrency";
import {
	type AnonymousVolumeMount,
	type BindSnapshot,
	composeContainerIdsCommand,
	type DirectorySnapshot,
	describeAnonymousVolume,
	isAnonymousVolume,
	keepsAnonymousVolumes,
	MIGRATION_HELPER_IMAGE,
	readMiddlewares,
	requiresDowntime,
	type SwarmServiceSnapshot,
	type TraefikSnapshot,
	type VolumeSnapshot,
} from "./discovery";
import { type HostExecutor, pipeBetweenHosts } from "./host";
import {
	type ContainerProbe,
	composeProbeCommand,
	parseContainerProbes,
	waitForComposeContainers,
} from "./readiness";
import {
	type MigrationService,
	setServiceServerId,
	setServiceStatus,
} from "./service";

export type MigrationLog = (message: string) => Promise<void>;

interface Compensation {
	label: string;
	run: () => Promise<void>;
}

export interface MigrationContext {
	analysis: ServiceMigrationAnalysis;
	service: MigrationService;
	source: HostExecutor;
	target: HostExecutor;
	options: ServiceMigrationOptions;
	log: MigrationLog;
	/** Undo actions for the changes made so far, run in reverse order on failure. */
	compensations: Compensation[];
}

const helper = (options: string[], command: string[]) =>
	[
		"docker run --rm --log-driver none --network none",
		...options,
		MIGRATION_HELPER_IMAGE,
		quote(command),
	].join(" ");

const withoutDigest = (image: string) => image.split("@")[0] as string;

const progressLogger = (log: MigrationLog, label: string) => {
	let last = Date.now();
	return (bytes: number) => {
		if (Date.now() - last < 5000) return;
		last = Date.now();
		void log(`  ${label}: ${formatBytes(bytes)} transferred…`);
	};
};

const transfer = async (
	context: MigrationContext,
	label: string,
	sourceCommand: string,
	targetCommand: string,
) => {
	const started = Date.now();
	const bytes = await pipeBetweenHosts(
		context.source,
		sourceCommand,
		context.target,
		targetCommand,
		progressLogger(context.log, label),
	);
	const seconds = Math.max((Date.now() - started) / 1000, 0.001);
	await context.log(
		`  ${label}: ${formatBytes(bytes)} in ${seconds.toFixed(1)}s (${formatBytes(bytes / seconds)}/s)`,
	);
};

/* --------------------------------- images --------------------------------- */

const loginRegistries = async (context: MigrationContext) => {
	await sequentially(context.service.registryIds, async (registryId) => {
		const registry = await findRegistryByIdWithCredentials(registryId);
		await context.log(
			`Logging ${context.target.host.name} in to ${registry.registryUrl || "Docker Hub"}`,
		);
		await context.target.run(getComposeRegistryLoginCommand(registry), {
			input: registry.password,
		});
	});
};

/**
 * Makes an image available on the target: pulled when the target can reach its
 * registry, streamed from the source with docker save/load otherwise.
 * Returns the reference to run on the target.
 */
const provideImage = async (context: MigrationContext, image: string) => {
	const pull = await context.target.run(
		`env HOME="$HOME" docker pull ${quote([image])}`,
		{ allowFailure: true },
	);
	if (pull.exitCode === 0) {
		await context.log(`  Pulled ${withoutDigest(image)} on the target`);
		return image;
	}
	const reference = withoutDigest(image);
	await context.log(
		`  ${context.target.host.name} cannot pull ${reference}; streaming it from ${context.source.host.name}`,
	);
	await transfer(
		context,
		`image ${reference}`,
		`docker save ${quote([reference])}`,
		"docker load",
	);
	return reference;
};

/* ---------------------------------- data ---------------------------------- */

const emptyVolume = async (executor: HostExecutor, name: string) => {
	await executor.run(
		helper(
			[`--mount ${quote([`type=volume,source=${name},target=/migration`])}`],
			["find", "/migration", "-mindepth", "1", "-delete"],
		),
	);
};

/** Streams the content of a source volume into a target volume. */
const streamVolume = async (
	context: MigrationContext,
	label: string,
	sourceVolume: string,
	targetVolume: string,
) => {
	await transfer(
		context,
		label,
		helper(
			[
				`--mount ${quote([`type=volume,source=${sourceVolume},target=/migration,readonly`])}`,
			],
			["tar", "--numeric-owner", "-C", "/migration", "-cf", "-", "."],
		),
		helper(
			[
				"-i",
				`--mount ${quote([`type=volume,source=${targetVolume},target=/migration`])}`,
			],
			["tar", "--numeric-owner", "-C", "/migration", "-xpf", "-"],
		),
	);
};

const copyVolume = async (
	context: MigrationContext,
	volume: VolumeSnapshot,
) => {
	const { target } = context;
	const existed = context.analysis.targetSnapshot?.existingVolumes.includes(
		volume.name,
	);
	if (existed) {
		await context.log(
			`Volume ${volume.name}: emptying the existing target volume`,
		);
		await emptyVolume(target, volume.name);
	} else {
		const flags = [
			`--driver ${quote([volume.driver])}`,
			...Object.entries(volume.options).map(
				([key, value]) => `--opt ${quote([`${key}=${value}`])}`,
			),
			...Object.entries(volume.labels).map(
				([key, value]) => `--label ${quote([`${key}=${value}`])}`,
			),
		];
		await target.run(
			`docker volume create ${flags.join(" ")} ${quote([volume.name])}`,
		);
		context.compensations.push({
			label: `Remove volume ${volume.name} from the target`,
			run: async () => {
				await target.run(`docker volume rm -f ${quote([volume.name])}`);
			},
		});
	}
	if (volume.externalStorage) {
		await context.log(
			`Volume ${volume.name}: definition recreated (data on ${volume.driver} storage)`,
		);
		return;
	}
	await context.log(
		`Volume ${volume.name}: copying ${formatBytes(volume.sizeBytes)}`,
	);
	await streamVolume(context, volume.name, volume.name, volume.name);
};

export interface AnonymousVolumeCopy {
	volume: VolumeSnapshot;
	mount: AnonymousVolumeMount;
	container: ContainerProbe;
	/** The volume Docker created for the same mount of the redeployed container. */
	targetVolume: string;
}

/**
 * Pairs each anonymous source volume with the anonymous volume of the target
 * container running the same Compose service replica at the same path.
 */
export const matchAnonymousVolumes = (
	volumes: VolumeSnapshot[],
	containers: ContainerProbe[],
) => {
	const copies: AnonymousVolumeCopy[] = [];
	const problems: string[] = [];
	for (const volume of volumes) {
		const mount = volume.anonymous;
		if (!mount || volume.skipReason) continue;
		const label = describeAnonymousVolume(mount);
		const container = containers.find(
			(item) =>
				item.service === mount.service &&
				item.containerNumber === mount.containerNumber,
		);
		if (!container) {
			problems.push(
				`${label}: no container of ${mount.service} #${mount.containerNumber} on the target`,
			);
			continue;
		}
		const targetVolume = container.mounts.find(
			(item) =>
				item.type === "volume" && item.destination === mount.destination,
		)?.name;
		if (!targetVolume) {
			problems.push(
				`${label}: ${container.name} mounts no volume at ${mount.destination}`,
			);
			continue;
		}
		if (!isAnonymousVolume(targetVolume)) {
			problems.push(
				`${label}: ${container.name} mounts the named volume ${targetVolume} there, which is never overwritten`,
			);
			continue;
		}
		copies.push({ volume, mount, container, targetVolume });
	}
	return { copies, problems };
};

/**
 * Anonymous volumes only exist once the redeployed containers do: each one is
 * stopped, its new volume replaced by the source data, then started again.
 */
const copyAnonymousVolumes = async (context: MigrationContext) => {
	const { target, service } = context;
	const volumes =
		context.analysis.snapshot?.volumes.filter(
			(volume) => volume.anonymous && !volume.skipReason,
		) ?? [];
	if (volumes.length === 0) return;
	const probe = await target.run(composeProbeCommand(service), {
		allowFailure: true,
	});
	const { copies, problems } = matchAnonymousVolumes(
		volumes,
		parseContainerProbes(probe.stdout),
	);
	if (problems.length > 0) {
		throw new Error(
			`Anonymous volumes cannot be carried over: ${problems.join("; ")}`,
		);
	}
	const byContainer = new Map<string, AnonymousVolumeCopy[]>();
	for (const copy of copies) {
		byContainer.set(copy.container.id, [
			...(byContainer.get(copy.container.id) ?? []),
			copy,
		]);
	}
	await sequentially([...byContainer.values()], async (group) => {
		const { container } = group[0] as AnonymousVolumeCopy;
		const started =
			container.status === "running" || container.status === "restarting";
		if (started) {
			await context.log(
				`Stopping ${container.name} to copy its anonymous volume(s)`,
			);
			await target.run(
				`docker stop --time 30 ${quote([container.id])} >/dev/null`,
			);
		}
		await sequentially(group, async (copy) => {
			const label = `Anonymous volume ${describeAnonymousVolume(copy.mount)}`;
			await context.log(
				`${label}: copying ${formatBytes(copy.volume.sizeBytes)} into ${copy.targetVolume.slice(0, 12)}…`,
			);
			// The new volume holds the image content, replaced by the source data.
			await emptyVolume(target, copy.targetVolume);
			await streamVolume(context, label, copy.volume.name, copy.targetVolume);
		});
		if (started) {
			await target.run(`docker start ${quote([container.id])} >/dev/null`);
			await context.log(`${container.name} started again`);
		}
	});
};

const copyBind = async (context: MigrationContext, bind: BindSnapshot) => {
	const parent = path.posix.dirname(bind.path);
	const base = path.posix.basename(bind.path);
	const existed =
		(
			await context.target.run(`[ -e ${quote([bind.path])} ]`, {
				allowFailure: true,
			})
		).exitCode === 0;
	await context.log(
		`Host path ${bind.path}: copying ${formatBytes(bind.sizeBytes)}`,
	);
	if (!existed) {
		context.compensations.push({
			label: `Remove ${bind.path} from the target`,
			run: async () => {
				await context.target.run(
					helper(
						[`-v ${quote([`${parent}:/migration`])}`],
						["rm", "-rf", `/migration/${base}`],
					),
				);
			},
		});
	}
	await transfer(
		context,
		bind.path,
		helper(
			[
				`--mount ${quote([`type=bind,source=${parent},target=/migration,readonly`])}`,
			],
			["tar", "--numeric-owner", "-C", "/migration", "-cf", "-", base],
		),
		helper(
			["-i", `-v ${quote([`${parent}:/migration`])}`],
			["tar", "--numeric-owner", "-C", "/migration", "-xpf", "-"],
		),
	);
};

const copyDirectory = async (
	context: MigrationContext,
	directory: DirectorySnapshot,
) => {
	const { source, target, analysis } = context;
	const existed = analysis.targetSnapshot?.existingDirectories.includes(
		directory.targetPath,
	);
	await context.log(
		`${directory.label}: copying ${formatBytes(directory.sizeBytes)}`,
	);
	const targetMount = `-v ${quote([`${directory.targetPath}:/migration`])}`;
	// Created by the SSH user so Dokploy keeps write access to the directory.
	await target.run(`mkdir -p ${quote([directory.targetPath])}`);
	if (existed) {
		await target.run(
			helper(
				[targetMount],
				["find", "/migration", "-mindepth", "1", "-delete"],
			),
		);
	} else {
		context.compensations.push({
			label: `Remove ${directory.targetPath} from the target`,
			run: async () => {
				await target.run(
					helper(
						[
							`-v ${quote([`${path.posix.dirname(directory.targetPath)}:/migration`])}`,
						],
						[
							"rm",
							"-rf",
							`/migration/${path.posix.basename(directory.targetPath)}`,
						],
					),
				);
			},
		});
	}
	await transfer(
		context,
		directory.label,
		helper(
			[`-v ${quote([`${directory.sourcePath}:/migration:ro`])}`],
			[
				"tar",
				"--numeric-owner",
				"-C",
				"/migration",
				"--anchored",
				...directory.exclude.map((entry) => `--exclude=./${entry}`),
				"-cf",
				"-",
				".",
			],
		),
		helper(
			["-i", targetMount],
			["tar", "--numeric-owner", "-C", "/migration", "-xpf", "-"],
		),
	);
	const snapshot = analysis.snapshot;
	const targetSnapshot = analysis.targetSnapshot;
	if (
		snapshot &&
		targetSnapshot &&
		(snapshot.uid !== targetSnapshot.uid || snapshot.gid !== targetSnapshot.gid)
	) {
		// Files Dokploy wrote as the source SSH user belong to the target SSH user.
		await target.run(
			helper(
				[targetMount],
				[
					"sh",
					"-c",
					`find /migration -uid ${Number(snapshot.uid)} -exec chown -h ${Number(targetSnapshot.uid)} {} + && find /migration -gid ${Number(snapshot.gid)} -exec chgrp -h ${Number(targetSnapshot.gid)} {} +`,
				],
			),
		);
	}
};

const copyData = async (context: MigrationContext) => {
	const snapshot = context.analysis.snapshot;
	if (!snapshot) return;
	await sequentially(
		snapshot.volumes.filter((volume) => volume.skipReason),
		(volume) =>
			context.log(
				`⚠️ Anonymous volume ${volume.anonymous ? describeAnonymousVolume(volume.anonymous) : volume.name} (${formatBytes(volume.sizeBytes)}) is not carried over: ${volume.skipReason}.${
					keepsAnonymousVolumes(context.service)
						? ` It stays on ${context.source.host.name} as ${volume.name}`
						: ""
				}`,
			),
	);
	// One transfer at a time: they share the bandwidth and the undo order.
	// Anonymous volumes are copied once the redeployed containers exist.
	await sequentially(
		snapshot.volumes.filter((volume) => !volume.anonymous),
		(volume) => copyVolume(context, volume),
	);
	await sequentially(
		snapshot.binds.filter((bind) => !bind.skipReason),
		(bind) => copyBind(context, bind),
	);
	await sequentially(snapshot.directories, (directory) =>
		copyDirectory(context, directory),
	);
};

/* --------------------------------- server --------------------------------- */

const switchServer = async (context: MigrationContext) => {
	const { service } = context;
	await setServiceServerId(
		service.type,
		service.id,
		context.target.host.serverId,
	);
	await context.log(
		`Dokploy now assigns ${service.appName} to ${context.target.host.name}`,
	);
	context.compensations.push({
		label: `Assign ${service.appName} back to ${context.source.host.name}`,
		run: async () => {
			await setServiceServerId(
				service.type,
				service.id,
				context.source.host.serverId,
			);
		},
	});
	await sequentially(
		service.mounts.filter((item) => item.type === "file"),
		async (mount) => {
			await createFileMount(mount.mountId);
			await context.log(`File mount ${mount.mountPath} written on the target`);
		},
	);
};

/* ---------------------------------- swarm --------------------------------- */

const waitForNoTasks = async (executor: HostExecutor, name: string) => {
	await executor.run(
		`deadline=$(( $(date +%s) + 180 )); while [ -n "$(docker ps -q --filter ${quote([`label=com.docker.swarm.service.name=${name}`])})" ]; do [ "$(date +%s)" -ge "$deadline" ] && { echo "Containers of ${name} are still running" >&2; exit 1; }; sleep 1; done`,
	);
};

const scaleService = async (
	executor: HostExecutor,
	name: string,
	replicas: number,
) => {
	await executor.run(
		`docker service scale --detach ${quote([`${name}=${replicas}`])} >/dev/null`,
	);
	if (replicas === 0) await waitForNoTasks(executor, name);
};

/**
 * Waits until every replica (or one task per node for global services) runs and
 * no task gets replaced during a short stabilization: a crash-looping service is
 * sampled as running between two restarts.
 */
const waitForSwarmService = async (executor: HostExecutor, name: string) => {
	const service = quote([name]);
	await executor.run(`set -e
deadline=$(( $(date +%s) + 300 ))
healthy() {
  state="$(docker service inspect --format '{{if .UpdateStatus}}{{.UpdateStatus.State}}{{end}}' ${service})"
  case "$state" in paused|rollback_started|rollback_paused|rollback_completed) echo "Swarm update state: $state" >&2; return 2;; esac
  desired="$(docker service inspect --format '{{if .Spec.Mode.Replicated}}{{.Spec.Mode.Replicated.Replicas}}{{else}}1{{end}}' ${service})"
  running="$(docker service ps ${service} --filter desired-state=running --format '{{.CurrentState}}' | grep -c '^Running' || true)"
  failed="$(docker service ps ${service} --format '{{.CurrentState}}' | grep -cE '^(Rejected|Failed)' || true)"
  if [ "$running" -eq 0 ] && [ "$failed" -ge 3 ]; then
    docker service ps ${service} --no-trunc --format '{{.CurrentState}}: {{.Error}}' | head -3 >&2
    return 2
  fi
  [ "$running" -ge "$desired" ]
}
tasks() { docker service ps -q --no-trunc --filter desired-state=running ${service} | sort; }
while true; do
  status=0
  if healthy; then
    before="$(tasks)"
    sleep 10
    if healthy; then
      [ "$(tasks)" = "$before" ] && exit 0
      reason="${name} restarted during stabilization"
    else
      status=$?
      reason="${name} stopped during stabilization"
    fi
  else
    status=$?
    reason="${name} did not become healthy on the target"
  fi
  if [ "$status" -eq 2 ] || [ "$(date +%s)" -ge "$deadline" ]; then
    docker service ps ${service} --no-trunc >&2 || true
    echo "$reason" >&2
    exit 1
  fi
  sleep 2
done`);
};

/** Waits for every service of a stack like for a Swarm service. */
const waitForStack = async (executor: HostExecutor, appName: string) => {
	const services = (
		await executor.run(
			`docker stack services --format '{{.Name}}' ${quote([appName])}`,
		)
	).stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	if (services.length === 0) {
		throw new Error(`Stack ${appName} has no service on ${executor.host.name}`);
	}
	await mapWithConcurrency(services, SSH_PROBE_CONCURRENCY, (name) =>
		waitForSwarmService(executor, name),
	);
};

const stopSwarmSource = async (
	context: MigrationContext,
	snapshot: SwarmServiceSnapshot,
	redeploy: () => Promise<void>,
) => {
	const { source } = context;
	if (snapshot.desiredReplicas === null) {
		await source.run(`docker service rm ${quote([snapshot.name])}`);
		await waitForNoTasks(source, snapshot.name);
		context.compensations.push({
			label: `Redeploy ${snapshot.name} on ${source.host.name}`,
			run: redeploy,
		});
		return;
	}
	if (snapshot.desiredReplicas === 0) return;
	await scaleService(source, snapshot.name, 0);
	context.compensations.push({
		label: `Restart ${snapshot.name} on ${source.host.name}`,
		run: async () => {
			await scaleService(
				source,
				snapshot.name,
				snapshot.desiredReplicas as number,
			);
			await waitForSwarmService(source, snapshot.name);
		},
	});
};

const deployDatabase = async (context: MigrationContext) => {
	const { service } = context;
	const onData = (data: unknown) => {
		void context.log(`  ${String(data).trim()}`);
	};
	switch (service.type) {
		case "postgres":
			return await deployPostgres(service.id, onData);
		case "mysql":
			return await deployMySql(service.id, onData);
		case "mariadb":
			return await deployMariadb(service.id, onData);
		case "mongo":
			return await deployMongo(service.id, onData);
		case "redis":
			return await deployRedis(service.id, onData);
		case "libsql":
			return await deployLibsql(service.id, onData);
	}
};

const writeTargetFile = async (
	executor: HostExecutor,
	file: string,
	content: string,
) => {
	await executor.run(
		`mkdir -p ${quote([path.posix.dirname(file)])} && cat > ${quote([`${file}.migration`])} && mv ${quote([`${file}.migration`])} ${quote([file])}`,
		{ input: content },
	);
};

/** Waits until the target Traefik has loaded the copied routers (file provider reload). */
const waitForTraefikRoutes = async (
	context: MigrationContext,
	configs: { config: string }[],
) => {
	const routers: Record<string, string> = {};
	for (const { config } of configs) {
		const parsed = parse(config) as FileConfig | null;
		for (const [name, router] of Object.entries(parsed?.http?.routers ?? {})) {
			routers[name] = router.service;
		}
	}
	if (Object.keys(routers).length === 0) return;
	const result = await context.target.run(
		getWaitTraefikRoutersCommand(routers, 30),
		{ allowFailure: true },
	);
	await context.log(
		result.exitCode === 0
			? `Traefik on ${context.target.host.name} serves ${Object.keys(routers).length} router(s)`
			: `⚠️ Could not confirm that Traefik on ${context.target.host.name} loaded the routes: ${result.stderr.trim()}`,
	);
};

const migrateTraefik = async (
	context: MigrationContext,
	routes: TraefikSnapshot[],
) => {
	if (routes.length === 0) return;
	const { target } = context;
	const dynamic = target.paths.DYNAMIC_TRAEFIK_PATH;
	const middlewaresFile = path.posix.join(dynamic, "middlewares.yml");
	const current = (await readMiddlewares(target)) ?? {};
	current.http = current.http ?? {};
	current.http.middlewares = current.http.middlewares ?? {};
	const previous = { ...current.http.middlewares };
	const added = new Set<string>();

	await sequentially(routes, async (traefik) => {
		const file = path.posix.join(dynamic, `${traefik.appName}.yml`);
		await writeTargetFile(target, file, traefik.config);
		await context.log(
			`Traefik routes of ${traefik.appName} written on the target`,
		);
		context.compensations.push({
			label: `Remove ${traefik.appName}.yml from the target`,
			run: async () => {
				await target.run(`rm -f ${quote([file])}`);
			},
		});
	});
	const middlewares = current.http.middlewares;
	for (const traefik of routes) {
		for (const [name, definition] of Object.entries(traefik.middlewares)) {
			// Shared middlewares (redirect-to-https…) keep the target definition.
			if (name in previous && !name.includes(traefik.appName)) continue;
			middlewares[name] = definition as never;
			added.add(name);
		}
	}
	if (added.size > 0) {
		await writeTargetFile(target, middlewaresFile, stringify(current));
		await context.log(`Traefik middlewares copied: ${[...added].join(", ")}`);
	}
	await waitForTraefikRoutes(context, routes);
	if (added.size === 0) return;
	context.compensations.push({
		label: "Restore the target Traefik middlewares",
		run: async () => {
			const latest = (await readMiddlewares(target)) ?? {};
			latest.http = latest.http ?? {};
			latest.http.middlewares = latest.http.middlewares ?? {};
			for (const name of added) {
				if (name in previous) {
					latest.http.middlewares[name] = previous[name] as never;
				} else {
					delete latest.http.middlewares[name];
				}
			}
			await writeTargetFile(target, middlewaresFile, stringify(latest));
		},
	});
};

/**
 * The source holds no Traefik file for the application (lost or never written):
 * the routes are rebuilt on the target from the domains, redirects and basic
 * auth stored in Dokploy, exactly like the domain settings would.
 */
const regenerateTraefik = async (context: MigrationContext) => {
	const { target, service } = context;
	const middlewaresFile = path.posix.join(
		target.paths.DYNAMIC_TRAEFIK_PATH,
		"middlewares.yml",
	);
	if (!(await readMiddlewares(target))) {
		await writeTargetFile(target, middlewaresFile, getDefaultMiddlewares());
	}
	const application = await findApplicationById(service.id);
	context.compensations.push({
		label: `Remove the regenerated Traefik routes of ${service.appName}`,
		run: async () => {
			await deleteAllMiddlewares(application);
			await removeTraefikConfig(application.appName, application.serverId);
		},
	});
	// Each step rewrites the same Traefik files: they must not overlap.
	await sequentially(application.domains, (domain) =>
		manageDomain(application, domain),
	);
	await sequentially(application.redirects, (redirect) =>
		createRedirectMiddleware(application, redirect),
	);
	await sequentially(application.security, (security) =>
		createSecurityMiddleware(application, security),
	);
	await context.log(
		`No Traefik configuration on ${context.source.host.name}: routes regenerated on the target from ${application.domains.length} domain(s), ${application.redirects.length} redirect(s) and ${application.security.length} basic auth rule(s)`,
	);
	const config = await target.run(
		`cat ${quote([path.posix.join(target.paths.DYNAMIC_TRAEFIK_PATH, `${service.appName}.yml`)])}`,
		{ allowFailure: true },
	);
	if (config.exitCode === 0) {
		await waitForTraefikRoutes(context, [{ config: config.stdout }]);
	}
};

/** Recreates the preview deployments; returns those that could not be recreated. */
const migratePreviews = async (context: MigrationContext) => {
	const failed = new Set<string>();
	const previews = context.analysis.snapshot?.previews ?? [];
	await sequentially(previews, async (preview) => {
		if (!preview.image) {
			failed.add(preview.name);
			return;
		}
		try {
			const [application, previewDeployment, image] = await Promise.all([
				findApplicationById(context.service.id),
				findPreviewDeploymentById(preview.previewDeploymentId),
				provideImage(context, preview.image),
			]);
			application.appName = previewDeployment.appName;
			application.env = `${application.previewEnv}\nDOKPLOY_DEPLOY_URL=${previewDeployment.domain?.host}`;
			application.rollbackActive = false;
			application.rollbackRegistry = null;
			application.registry = null;
			application.domains = previewDeployment.domain
				? [previewDeployment.domain]
				: [];
			await mechanizeDockerContainer(application, {
				runtimeImage: image,
				...(preview.deploymentId && { deploymentId: preview.deploymentId }),
			});
			context.compensations.push({
				label: `Remove preview ${preview.name} from the target`,
				run: async () => {
					await context.target.run(
						`docker service rm ${quote([preview.name])}`,
					);
				},
			});
			await waitForSwarmService(context.target, preview.name);
			await context.log(`Preview deployment ${preview.name} recreated`);
		} catch (error) {
			failed.add(preview.name);
			await context.log(
				`⚠️ Preview deployment ${preview.name} could not be recreated: ${
					error instanceof Error ? error.message : String(error)
				}. Redeploy it from its pull request.`,
			);
		}
	});
	return failed;
};

const migrateSwarmService = async (context: MigrationContext) => {
	const { service, analysis, target } = context;
	const snapshot = analysis.snapshot;
	if (!snapshot) throw new Error("Missing source snapshot");
	const sourceService = snapshot.service;
	const stateful = requiresDowntime(
		service,
		snapshot,
		context.options.zeroDowntime,
	);

	let runtimeImage: string | null = null;
	if (service.type === "application") {
		if (!sourceService?.image) throw new Error("No running release to migrate");
		await context.log("Making the running release available on the target");
		runtimeImage = await provideImage(context, sourceService.image);
	} else if (service.dockerImage) {
		await context.log(`Pulling ${service.dockerImage} on the target`);
		await provideImage(context, service.dockerImage);
	}

	const redeployOnSource = async () => {
		if (service.type === "application" && runtimeImage) {
			const application = await findApplicationById(service.id);
			await mechanizeDockerContainer(application, {
				runtimeImage: sourceService?.image ?? runtimeImage,
			});
		} else {
			await deployDatabase(context);
		}
	};

	if (stateful) {
		const quiesced = [
			...(sourceService?.exists ? [sourceService] : []),
			...snapshot.previews,
		];
		// Sequential so the undo steps restart them in reverse order.
		await sequentially(quiesced, async (item) => {
			await context.log(`Stopping ${item.name} on ${context.source.host.name}`);
			await stopSwarmSource(context, item, redeployOnSource);
		});
	}

	await copyData(context);
	await switchServer(context);

	await context.log(`Creating ${service.appName} on ${target.host.name}`);
	context.compensations.push({
		label: `Remove ${service.appName} from the target`,
		run: async () => {
			await target.run(`docker service rm ${quote([service.appName])}`, {
				allowFailure: true,
			});
		},
	});
	if (service.type === "application") {
		const application = await findApplicationById(service.id);
		// Releases built by the zero-downtime pipeline keep their start-first spec.
		await mechanizeDockerContainer(application, {
			runtimeImage: runtimeImage as string,
			...(sourceService?.deploymentId && {
				deploymentId: sourceService.deploymentId,
				enforceZeroDowntime: true,
			}),
		});
	} else {
		await deployDatabase(context);
	}

	let status: "idle" | "done" = "done";
	if (sourceService?.exists && sourceService.desiredReplicas === 0) {
		await context.log(
			"The service was stopped on the source: keeping it stopped",
		);
		await scaleService(target, service.appName, 0);
		status = "idle";
	} else {
		await context.log(
			`Waiting for ${service.appName} to be healthy on the target`,
		);
		await waitForSwarmService(target, service.appName);
		await context.log(`${service.appName} is running on ${target.host.name}`);
	}
	if (service.type === "application") {
		// Routes are published once the releases are healthy so the target never
		// answers 502; routes of previews that could not be recreated are skipped.
		const failedPreviews = await migratePreviews(context);
		await migrateTraefik(
			context,
			snapshot.traefik.filter(
				(traefik) => !failedPreviews.has(traefik.appName),
			),
		);
		const copied = snapshot.traefik.some(
			(traefik) => traefik.appName === service.appName,
		);
		if (!copied && service.domains.length > 0) {
			await regenerateTraefik(context);
		}
	}
	return status;
};

/* --------------------------------- compose -------------------------------- */

const stopComposeSource = async (context: MigrationContext) => {
	const { source, service, analysis } = context;
	const compose = analysis.snapshot?.compose;
	if (!compose) return;
	if (service.composeType === "stack") {
		if (compose.stackServices.length === 0) return;
		await context.log(
			`Removing stack ${service.appName} on ${source.host.name}`,
		);
		await source.run(`docker stack rm ${quote([service.appName])}`);
		await source.run(
			`deadline=$(( $(date +%s) + 180 )); while [ -n "$(docker ps -q --filter ${quote([`label=com.docker.stack.namespace=${service.appName}`])})" ]; do [ "$(date +%s)" -ge "$deadline" ] && exit 1; sleep 1; done`,
		);
		context.compensations.push({
			label: `Redeploy stack ${service.appName} on ${source.host.name}`,
			run: async () => {
				await rebuildCompose({
					composeId: service.id,
					titleLog: "Server migration rollback",
					descriptionLog: `Restored on ${source.host.name}`,
				});
			},
		});
		return;
	}
	const running = compose.containers
		.filter((container) => container.state === "running")
		.map((container) => container.id);
	if (running.length === 0) return;
	await context.log(
		`Stopping ${running.length} container(s) on ${source.host.name}`,
	);
	await source.run(`docker stop --time 30 ${quote(running)} >/dev/null`);
	context.compensations.push({
		label: `Restart the containers on ${source.host.name}`,
		run: async () => {
			await source.run(`docker start ${quote(running)} >/dev/null`);
		},
	});
};

const removeComposeRuntime = async (
	executor: HostExecutor,
	service: Pick<MigrationService, "id" | "appName" | "composeType">,
	/** Only for runtimes this migration created: on the source they hold data. */
	removeAnonymousVolumes = false,
) => {
	const script = `set -e
ids="$(${composeContainerIdsCommand(service)})"
projects=""
if [ -n "$ids" ]; then
  projects="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' $ids | sort -u)"
  docker rm -f ${removeAnonymousVolumes ? "-v " : ""}$ids >/dev/null
fi
for project in $projects; do
  networks="$(docker network ls -q --filter label=com.docker.compose.project="$project")"
  if [ -n "$networks" ]; then docker network rm $networks >/dev/null 2>&1 || true; fi
done
find ${quote([executor.paths.DYNAMIC_TRAEFIK_PATH])} -maxdepth 1 -type f -name ${quote([`${service.appName}.zdt.*.yml`])} -delete 2>/dev/null || true`;
	if (service.composeType === "stack") {
		await executor.run(`docker stack rm ${quote([service.appName])}`, {
			allowFailure: true,
		});
	}
	await executor.run(script);
};

const latestComposeDeploymentLog = async (
	context: MigrationContext,
	since: string,
) => {
	const deployment = await db.query.deployments.findFirst({
		where: eq(deployments.composeId, context.service.id),
		orderBy: desc(deployments.createdAt),
	});
	if (!deployment?.logPath || deployment.createdAt < since) return null;
	const command = `tail -n 40 ${quote([deployment.logPath])}`;
	// Build Server deployments keep their logs on the Build Server.
	const output = context.service.buildServerId
		? await execAsyncRemote(context.service.buildServerId, command)
				.then((result) => result.stdout)
				.catch(() => "")
		: (await context.target.run(command, { allowFailure: true })).stdout;
	return output.trim() || null;
};

const migrateCompose = async (context: MigrationContext) => {
	const { service, analysis, target } = context;
	const compose = analysis.snapshot?.compose;
	const wasRunning =
		(compose?.runningContainers ?? 0) > 0 ||
		(compose?.stackServices.some((item) => item.replicas !== 0) ?? false);

	const zeroDowntime = analysis.snapshot
		? !requiresDowntime(
				service,
				analysis.snapshot,
				context.options.zeroDowntime,
			)
		: false;
	if (zeroDowntime) {
		await context.log(
			`Zero-downtime migration: ${context.source.host.name} keeps serving until the target is healthy`,
		);
	} else {
		await stopComposeSource(context);
	}
	await copyData(context);
	await switchServer(context);

	await context.log(
		`Deploying ${service.appName} on ${target.host.name} (see the "Server migration" deployment for the build logs)`,
	);
	context.compensations.push({
		label: `Remove ${service.appName} containers from the target`,
		run: async () => {
			await removeComposeRuntime(target, service, true);
		},
	});
	const started = new Date().toISOString();
	try {
		await rebuildCompose({
			composeId: service.id,
			titleLog: "Server migration",
			descriptionLog: `Migrated from ${context.source.host.name} to ${target.host.name}`,
		});
	} catch (error) {
		const tail = await latestComposeDeploymentLog(context, started);
		if (tail) await context.log(`Deployment log (last lines):\n${tail}`);
		throw error;
	}

	if (!wasRunning) {
		await context.log(
			"The project was stopped on the source: stopping it on the target",
		);
		if (service.composeType === "stack") {
			await target.run(`docker stack rm ${quote([service.appName])}`);
		} else {
			await target.run(
				`ids="$(${composeContainerIdsCommand(service)})"; [ -z "$ids" ] || docker stop $ids >/dev/null`,
			);
		}
		await copyAnonymousVolumes(context);
		return "idle" as const;
	}
	await copyAnonymousVolumes(context);

	await context.log("Checking the containers on the target");
	if (service.composeType === "stack") {
		await waitForStack(target, service.appName);
	} else {
		await waitForComposeContainers(target, service, {
			expectedServices: new Set(
				compose?.containers
					.filter((container) => container.state === "running")
					.flatMap((container) =>
						container.service ? [container.service] : [],
					),
			),
			log: context.log,
		});
	}
	return "done" as const;
};

/* --------------------------------- driver --------------------------------- */

export const prepareTarget = async (context: MigrationContext) => {
	const { target } = context;
	await context.log(`Preparing ${target.host.name}`);
	await target.run(
		`mkdir -p ${quote([
			target.paths.APPLICATIONS_PATH,
			target.paths.COMPOSE_PATH,
			target.paths.LOGS_PATH,
			target.paths.DYNAMIC_TRAEFIK_PATH,
		])}`,
	);
	await loginRegistries(context);
};

export const executeMigration = async (context: MigrationContext) => {
	await prepareTarget(context);
	return context.service.type === "compose"
		? await migrateCompose(context)
		: await migrateSwarmService(context);
};

/** Everything left on the source once the target serves the service. */
export const buildSourceCleanup = (
	context: MigrationContext,
): ServiceMigrationSourceCleanup => {
	const { service, analysis, options } = context;
	const snapshot = analysis.snapshot;
	return {
		serviceType: service.type,
		serviceId: service.id,
		appName: service.appName,
		composeType: service.composeType,
		swarmServices:
			service.type === "compose"
				? []
				: [
						...(snapshot?.service?.exists ? [service.appName] : []),
						...(snapshot?.previews.map((preview) => preview.name) ?? []),
					],
		traefik: (snapshot?.traefik ?? []).map((traefik) => ({
			appName: traefik.appName,
			// Shared middlewares (redirect-to-https…) stay on the source.
			middlewares: Object.keys(traefik.middlewares).filter((name) =>
				name.includes(traefik.appName),
			),
		})),
		// Anonymous volumes left behind stay the only copy of their data.
		volumes:
			snapshot?.volumes
				.filter((volume) => !volume.skipReason)
				.map((volume) => volume.name) ?? [],
		directories:
			snapshot?.directories.map((directory) => directory.sourcePath) ?? [],
		removeSourceData: options.removeSourceData,
	};
};

/** Removes the runtime (and optionally the data) left on the source. Never undoes the migration. */
export const cleanupSource = async (
	source: HostExecutor,
	cleanup: ServiceMigrationSourceCleanup,
	log: MigrationLog,
) => {
	if (cleanup.serviceType === "compose") {
		await removeComposeRuntime(source, {
			id: cleanup.serviceId,
			appName: cleanup.appName,
			composeType: cleanup.composeType,
		});
		await log(`Removed the containers from ${source.host.name}`);
	}
	await mapWithConcurrency(
		cleanup.swarmServices,
		SSH_PROBE_CONCURRENCY,
		async (name) => {
			await source.run(`docker service rm ${quote([name])}`, {
				allowFailure: true,
			});
			await log(`Removed ${name} from ${source.host.name}`);
		},
	);
	if (cleanup.traefik.length > 0) {
		const dynamic = source.paths.DYNAMIC_TRAEFIK_PATH;
		await source.run(
			`rm -f ${quote(
				cleanup.traefik.map((traefik) =>
					path.posix.join(dynamic, `${traefik.appName}.yml`),
				),
			)}`,
		);
		const owned = cleanup.traefik.flatMap((traefik) => traefik.middlewares);
		const middlewares = await readMiddlewares(source);
		if (middlewares?.http?.middlewares && owned.length > 0) {
			for (const name of owned) delete middlewares.http.middlewares[name];
			await writeTargetFile(
				source,
				path.posix.join(dynamic, "middlewares.yml"),
				stringify(middlewares),
			);
		}
		await log(`Traefik routes removed from ${source.host.name}`);
	}

	if (!cleanup.removeSourceData) {
		await log(
			`Volumes and directories are kept on ${source.host.name} as a backup`,
		);
		return;
	}
	// Removed services leave exited task containers that still hold the volumes.
	await mapWithConcurrency(
		cleanup.swarmServices,
		SSH_PROBE_CONCURRENCY,
		async (name) => {
			const label = quote([`label=com.docker.swarm.service.name=${name}`]);
			await source.run(
				`deadline=$(( $(date +%s) + 30 )); while [ -n "$(docker ps -aq --filter ${label})" ] && [ "$(date +%s)" -lt "$deadline" ]; do sleep 1; done; ids="$(docker ps -aq --filter ${label})"; [ -z "$ids" ] || docker rm -f $ids >/dev/null`,
				{ allowFailure: true },
			);
		},
	);
	await mapWithConcurrency(
		cleanup.volumes,
		SSH_PROBE_CONCURRENCY,
		async (volume) => {
			const result = await source.run(`docker volume rm ${quote([volume])}`, {
				allowFailure: true,
			});
			await log(
				result.exitCode === 0
					? `Removed volume ${volume} from ${source.host.name}`
					: `⚠️ Volume ${volume} could not be removed from ${source.host.name}: ${result.stderr.trim()}`,
			);
		},
	);
	await mapWithConcurrency(
		cleanup.directories,
		SSH_PROBE_CONCURRENCY,
		async (directory) => {
			await source.run(
				helper(
					[`-v ${quote([`${path.posix.dirname(directory)}:/migration`])}`],
					["rm", "-rf", `/migration/${path.posix.basename(directory)}`],
				),
				{ allowFailure: true },
			);
			await log(`Removed ${directory} from ${source.host.name}`);
		},
	);
};

export const rollbackMigration = async (context: MigrationContext) => {
	let failures = 0;
	// Undo in reverse order: later changes depend on the earlier ones.
	await sequentially([...context.compensations].reverse(), async (step) => {
		try {
			await context.log(`↩ ${step.label}`);
			await step.run();
		} catch (error) {
			failures += 1;
			await context.log(
				`  ⚠️ ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	});
	return failures;
};

export const restoreServiceStatus = async (
	service: MigrationService,
	status: MigrationService["status"],
) => {
	await setServiceStatus(service.type, service.id, status);
};
