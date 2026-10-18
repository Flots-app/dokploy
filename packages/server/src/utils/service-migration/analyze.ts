import { IS_CLOUD } from "@dokploy/server/constants";
import { db } from "@dokploy/server/db";
import {
	certificates,
	forwardAuthSettings,
	type MigratableServiceType,
	type ServiceMigrationCheck,
	type ServiceMigrationCheckStatus,
	type ServiceMigrationOptions,
	type ServiceMigrationPlanItem,
	server,
	serviceMigrations,
} from "@dokploy/server/db/schema";
import { getWebServerSettings } from "@dokploy/server/services/web-server-settings";
import { TRPCError } from "@trpc/server";
import { and, eq, isNotNull, isNull, ne } from "drizzle-orm";
import { quote } from "shell-quote";
import { mapWithConcurrency, SSH_PROBE_CONCURRENCY } from "./concurrency";
import {
	composeContainerIdsCommand,
	discoverSource,
	ensureHelperImage,
	hasDataToCopy,
	MIGRATION_HELPER_IMAGE,
	requiresDowntime,
	type SourceSnapshot,
} from "./discovery";
import {
	describeDomainDns,
	type PublicAddresses,
	probePublicAddresses,
	resolveDomainRecords,
} from "./dns";
import {
	createHostExecutor,
	type HostExecutor,
	type MigrationHost,
	resolveMigrationHost,
} from "./host";
import {
	databaseLabel,
	loadMigrationService,
	type MigrationService,
} from "./service";

export interface TargetSnapshot {
	platform: string | null;
	swarmState: string | null;
	swarmManager: boolean;
	composeAvailable: boolean;
	uid: string;
	gid: string;
	missingNetworks: string[];
	traefikRunning: boolean;
	conflictingServices: string[];
	conflictingContainers: number;
	/** Volumes already present on the target, empty or not. */
	existingVolumes: string[];
	/** Existing target volumes holding data, overwritten only with replaceTargetData. */
	nonEmptyVolumes: string[];
	busyPorts: string[];
	freeDockerBytes: number | null;
	freeBaseBytes: number | null;
	existingDirectories: string[];
	missingSystemPaths: string[];
	helperImagePresent: boolean;
	/** Problems writing to the Dokploy directory or the Docker storage of the target. */
	storageErrors: string[];
	/** Probed only when the service has domains. */
	publicAddresses: PublicAddresses;
}

export interface ServiceMigrationAnalysis {
	service: MigrationService;
	source: MigrationHost;
	target: MigrationHost;
	checks: ServiceMigrationCheck[];
	plan: ServiceMigrationPlanItem[];
	canMigrate: boolean;
	requiresDowntime: boolean;
	totalBytes: number;
	snapshot: SourceSnapshot | null;
	targetSnapshot: TargetSnapshot | null;
}

export interface AnalyzeServiceMigrationInput {
	serviceType: MigratableServiceType;
	serviceId: string;
	targetServerId: string | null;
	organizationId: string;
	options: ServiceMigrationOptions;
	/** Reuse already opened sessions (the migration keeps them for its whole run). */
	executors?: { source: HostExecutor; target: HostExecutor };
	/** The migration running this analysis, which must not count as a concurrent one. */
	migrationId?: string;
}

class CheckList {
	readonly items: ServiceMigrationCheck[] = [];

	add(
		id: string,
		label: string,
		status: ServiceMigrationCheckStatus,
		message: string,
	) {
		this.items.push({ id, label, status, message });
	}

	get failed() {
		return this.items.some((item) => item.status === "fail");
	}
}

export const formatBytes = (bytes: number | null | undefined) => {
	if (bytes === null || bytes === undefined) return "unknown size";
	const units = ["B", "KB", "MB", "GB", "TB"];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
};

const lines = (output: string) =>
	output
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);

const portKey = (port: { publishedPort: number; protocol: string }) =>
	`${port.publishedPort}/${port.protocol}`;

/** Extracts the published ports of `docker ps` / `docker service ls` output. */
export const parsePublishedPorts = (output: string) => {
	const ports = new Set<string>();
	for (const match of output.matchAll(
		/(?:[\d.]+|\[::\]|\*):(\d+)->\d+\/(tcp|udp)/g,
	)) {
		ports.add(`${match[1]}/${match[2]}`);
	}
	return ports;
};

/** Ports with a listening socket on the host (`ss -Htuln`). */
export const parseListeningPorts = (output: string) => {
	const ports = new Set<string>();
	for (const line of lines(output)) {
		const [protocol, , , , local] = line.split(/\s+/);
		const port = local?.split(":").pop();
		if (
			port &&
			/^\d+$/.test(port) &&
			(protocol === "tcp" || protocol === "udp")
		) {
			ports.add(`${port}/${protocol}`);
		}
	}
	return ports;
};

const freeBytes = async (executor: HostExecutor, directory: string) => {
	const result = await executor.run(
		`d=${quote([directory])}; while [ ! -e "$d" ]; do d="$(dirname "$d")"; done; df -Pk "$d" | tail -1`,
		{ allowFailure: true },
	);
	const available = Number(result.stdout.trim().split(/\s+/)[3]);
	return Number.isFinite(available) ? available * 1024 : null;
};

/** Domains whose DNS must follow the service (wildcards cannot be checked). */
const domainHosts = (service: MigrationService) => [
	...new Set(
		[
			...service.domains.map((domain) => domain.host),
			...service.previews
				.map((preview) => preview.domainHost)
				.filter((host): host is string => Boolean(host)),
		].filter((host) => !host.includes("*")),
	),
];

const probeTarget = async (
	service: MigrationService,
	snapshot: SourceSnapshot,
	target: HostExecutor,
): Promise<TargetSnapshot> => {
	const info = await target.run(
		"docker info --format '{{.OSType}}/{{.Architecture}}|{{.Swarm.LocalNodeState}}|{{.Swarm.ControlAvailable}}|{{.DockerRootDir}}'; id -u; id -g",
	);
	const [infoLine = "", uid = "0", gid = "0"] = lines(info.stdout);
	const [platform, swarmState, controlAvailable, dockerRootDir] =
		infoLine.split("|");

	const composeAvailable =
		service.type !== "compose" ||
		(await target.run("docker compose version", { allowFailure: true }))
			.exitCode === 0;

	/** Runs a probe per item and keeps the items for which it succeeded. */
	const probe = async <T>(
		items: readonly T[],
		command: (item: T) => string,
	) => {
		const results = await mapWithConcurrency(
			items,
			SSH_PROBE_CONCURRENCY,
			(item) => target.run(command(item), { allowFailure: true }),
		);
		return items.filter((_, index) => results[index]?.exitCode === 0);
	};

	const networks = [...new Set(service.networks)];
	const availableNetworks = new Set(
		await probe(
			networks,
			(network) =>
				`docker network inspect ${quote([network])} --format '{{.Name}}'`,
		),
	);
	const missingNetworks = networks.filter(
		(network) => !availableNetworks.has(network),
	);

	const traefik = await target.run(
		"docker ps --filter name=dokploy-traefik --format '{{.Names}}'; docker service ls --filter name=dokploy-traefik --format '{{.Name}}' 2>/dev/null",
		{ allowFailure: true },
	);

	const conflictingContainers =
		service.type === "compose"
			? lines(
					(
						await target.run(composeContainerIdsCommand(service), {
							allowFailure: true,
						})
					).stdout,
				).length
			: 0;
	const conflictingServices =
		service.type === "compose"
			? []
			: await probe(
					[service.appName, ...snapshot.previews.map((item) => item.name)],
					(name) =>
						`docker service inspect ${quote([name])} --format '{{.ID}}'`,
				);

	const existingVolumes = await probe(
		snapshot.volumes.map((volume) => volume.name),
		(name) => `docker volume inspect ${quote([name])} --format '{{.Name}}'`,
	);
	// Pre-provisioned empty volumes (external Compose volumes) are simply filled.
	const emptyVolumes = new Set(
		await probe(
			existingVolumes,
			(name) =>
				`docker run --rm --log-driver none --network none --mount ${quote([`type=volume,source=${name},target=/migration,readonly`])} ${MIGRATION_HELPER_IMAGE} sh -c '[ -z "$(ls -A /migration)" ]'`,
		),
	);
	const nonEmptyVolumes = existingVolumes.filter(
		(name) => !emptyVolumes.has(name),
	);

	const busyPorts: string[] = [];
	if (service.ports.length > 0) {
		const published = await target.run(
			"docker ps --format '{{.Ports}}'; docker service ls --format '{{.Ports}}' 2>/dev/null",
			{ allowFailure: true },
		);
		const listening = await target.run("ss -Htuln 2>/dev/null || true", {
			allowFailure: true,
		});
		const used = new Set([
			...parsePublishedPorts(published.stdout),
			...parseListeningPorts(listening.stdout),
		]);
		for (const port of service.ports) {
			if (used.has(portKey(port))) busyPorts.push(portKey(port));
		}
	}

	const existingDirectories = await probe(
		snapshot.directories.map((directory) => directory.targetPath),
		(directory) => `[ -e ${quote([directory])} ]`,
	);

	const systemPaths = snapshot.binds
		.filter((bind) => bind.skipReason?.startsWith("Host system path"))
		.map((bind) => bind.path);
	const presentSystemPaths = new Set(
		await probe(systemPaths, (hostPath) => `[ -e ${quote([hostPath])} ]`),
	);
	const missingSystemPaths = systemPaths.filter(
		(hostPath) => !presentSystemPaths.has(hostPath),
	);

	const needsHelper =
		snapshot.volumes.some((volume) => !volume.externalStorage) ||
		snapshot.binds.some((bind) => !bind.skipReason) ||
		snapshot.directories.length > 0;

	// A full or read-only disk only shows up when something is written.
	const storageErrors: string[] = [];
	const marker = `dokploy-migration-probe-${Date.now()}`;
	const baseWrite = await target.run(
		`mkdir -p ${quote([target.paths.BASE_PATH])} && touch ${quote([`${target.paths.BASE_PATH}/.${marker}`])} && rm -f ${quote([`${target.paths.BASE_PATH}/.${marker}`])}`,
		{ allowFailure: true },
	);
	if (baseWrite.exitCode !== 0) {
		storageErrors.push(
			`${target.paths.BASE_PATH}: ${(baseWrite.stderr || baseWrite.stdout).trim()}`,
		);
	}
	const dockerWrite = await target.run(
		`docker volume create ${marker} >/dev/null && docker volume rm ${marker} >/dev/null`,
		{ allowFailure: true },
	);
	if (dockerWrite.exitCode !== 0) {
		storageErrors.push(
			`Docker storage: ${(dockerWrite.stderr || dockerWrite.stdout).trim()}`,
		);
	}

	return {
		platform: platform || null,
		swarmState: swarmState || null,
		swarmManager: controlAvailable === "true",
		composeAvailable,
		uid,
		gid,
		missingNetworks,
		traefikRunning: lines(traefik.stdout).length > 0,
		conflictingServices,
		conflictingContainers,
		existingVolumes,
		nonEmptyVolumes,
		busyPorts,
		freeDockerBytes: dockerRootDir
			? await freeBytes(target, dockerRootDir)
			: null,
		freeBaseBytes: await freeBytes(target, target.paths.BASE_PATH),
		existingDirectories,
		missingSystemPaths,
		helperImagePresent: needsHelper ? await ensureHelperImage(target) : true,
		storageErrors,
		publicAddresses:
			domainHosts(service).length > 0
				? await probePublicAddresses(target)
				: { ipv4: null, ipv6: null },
	};
};

const checkTargetServer = async (
	checks: CheckList,
	service: MigrationService,
	targetServerId: string | null,
	organizationId: string,
) => {
	const label = "Target server";
	if (targetServerId === service.serverId) {
		checks.add(
			"target-server",
			label,
			"fail",
			"The service already runs on this server.",
		);
		return false;
	}
	if (!targetServerId) {
		const settings = await getWebServerSettings();
		if (IS_CLOUD || settings?.remoteServersOnly) {
			checks.add(
				"target-server",
				label,
				"fail",
				"Services cannot run on the Dokploy server (remote servers only).",
			);
			return false;
		}
		checks.add(
			"target-server",
			label,
			"pass",
			"The service will run on the Dokploy server.",
		);
		return true;
	}
	const targetServer = await db.query.server.findFirst({
		where: eq(server.serverId, targetServerId),
	});
	if (!targetServer || targetServer.organizationId !== organizationId) {
		checks.add("target-server", label, "fail", "Server not found.");
		return false;
	}
	const problems: string[] = [];
	if (targetServer.serverType !== "deploy") {
		problems.push("it is a Build Server, not a Deploy Server");
	}
	if (targetServer.serverStatus !== "active") problems.push("it is inactive");
	if (!targetServer.sshKeyId) problems.push("it has no SSH key");
	if (service.buildServerId === targetServer.serverId) {
		problems.push("it is the Build Server of this service");
	}
	if (problems.length > 0) {
		checks.add(
			"target-server",
			label,
			"fail",
			`${targetServer.name} cannot host this service: ${problems.join(", ")}.`,
		);
		return false;
	}
	checks.add(
		"target-server",
		label,
		"pass",
		`${targetServer.name} (${targetServer.ipAddress}) is an active Deploy Server.`,
	);
	return true;
};

const checkServiceState = async (
	checks: CheckList,
	service: MigrationService,
	migrationId?: string,
) => {
	const running = await db.query.serviceMigrations.findFirst({
		where: and(
			eq(serviceMigrations.serviceId, service.id),
			eq(serviceMigrations.status, "running"),
			migrationId
				? ne(serviceMigrations.serviceMigrationId, migrationId)
				: undefined,
		),
		columns: { serviceMigrationId: true },
	});
	if (running) {
		checks.add(
			"service-state",
			"Service state",
			"fail",
			"A migration of this service is already running.",
		);
		return;
	}
	const pending = await db.query.serviceMigrations.findFirst({
		where: and(
			eq(serviceMigrations.serviceId, service.id),
			isNotNull(serviceMigrations.pendingCleanup),
		),
		columns: { sourceServerName: true },
	});
	if (pending) {
		checks.add(
			"service-state",
			"Service state",
			"fail",
			`The previous migration still keeps a copy running on ${pending.sourceServerName}. Finish it first.`,
		);
		return;
	}
	if (service.status === "running") {
		checks.add(
			"service-state",
			"Service state",
			"fail",
			"A deployment is in progress. Wait for it to finish.",
		);
		return;
	}
	checks.add(
		"service-state",
		"Service state",
		"pass",
		"No deployment or migration is in progress.",
	);
};

const checkRuntime = (
	checks: CheckList,
	service: MigrationService,
	snapshot: SourceSnapshot,
	targetSnapshot: TargetSnapshot,
) => {
	if (service.type === "compose") {
		checks.add(
			"target-docker",
			"Docker on target",
			targetSnapshot.composeAvailable ? "pass" : "fail",
			targetSnapshot.composeAvailable
				? "Docker Compose is installed."
				: "Docker Compose is missing on the target.",
		);
		if (service.composeType === "stack") {
			const ok =
				targetSnapshot.swarmState === "active" && targetSnapshot.swarmManager;
			checks.add(
				"target-swarm",
				"Docker Swarm on target",
				ok ? "pass" : "fail",
				ok
					? "The target is a Swarm manager."
					: "Stacks require the target to be a Docker Swarm manager.",
			);
		}
	} else {
		const ok =
			targetSnapshot.swarmState === "active" && targetSnapshot.swarmManager;
		checks.add(
			"target-docker",
			"Docker Swarm on target",
			ok ? "pass" : "fail",
			ok
				? "The target is a Docker Swarm manager."
				: `Docker Swarm is ${targetSnapshot.swarmState || "unknown"} on the target; Dokploy services need an active Swarm manager.`,
		);
	}

	if (service.networks.length > 0) {
		checks.add(
			"networks",
			"Networks",
			targetSnapshot.missingNetworks.length ? "fail" : "pass",
			targetSnapshot.missingNetworks.length
				? `Missing on the target: ${targetSnapshot.missingNetworks.join(", ")}.`
				: `${service.networks.join(", ")} available on the target.`,
		);
	}

	const sameArchitecture =
		!snapshot.platform ||
		!targetSnapshot.platform ||
		snapshot.platform === targetSnapshot.platform;
	checks.add(
		"platform",
		"CPU architecture",
		sameArchitecture
			? "pass"
			: service.type === "application"
				? "fail"
				: "warn",
		sameArchitecture
			? `Both servers run ${targetSnapshot.platform}.`
			: service.type === "application"
				? `The image was built for ${snapshot.platform} but the target runs ${targetSnapshot.platform}. Rebuild for the target instead.`
				: `Source runs ${snapshot.platform}, target runs ${targetSnapshot.platform}: images are pulled for the target, check that the data format is portable.`,
	);

	if (service.type === "application") {
		if (!snapshot.service?.exists || !snapshot.service.image) {
			checks.add(
				"runtime-image",
				"Running release",
				"fail",
				"The application is not deployed on the source server. Deploy it first or change its server in the settings.",
			);
		} else {
			checks.add(
				"runtime-image",
				"Running release",
				"pass",
				`${snapshot.service.image.split("@")[0]} will run unchanged on the target${
					service.registryIds.length
						? " (pulled with the registry credentials, streamed from the source as a fallback)."
						: " (pulled by the target, streamed from the source as a fallback)."
				}`,
			);
		}
	} else if (service.type !== "compose" && !snapshot.service?.exists) {
		checks.add(
			"runtime-image",
			"Running service",
			"warn",
			"The database service does not exist on the source; it will be created on the target from its settings.",
		);
	}

	const conflicts = [
		...targetSnapshot.conflictingServices,
		...(targetSnapshot.conflictingContainers
			? [
					`${targetSnapshot.conflictingContainers} container(s) of this Compose project`,
				]
			: []),
	];
	checks.add(
		"name-conflicts",
		"Name conflicts",
		conflicts.length ? "fail" : "pass",
		conflicts.length
			? `Already present on the target: ${conflicts.join(", ")}. Remove them before migrating.`
			: "No service with the same name exists on the target.",
	);
};

const checkData = (
	checks: CheckList,
	snapshot: SourceSnapshot,
	targetSnapshot: TargetSnapshot,
	options: ServiceMigrationOptions,
	totalBytes: number,
) => {
	const nonEmptyVolumes = new Set(targetSnapshot.nonEmptyVolumes);
	const emptyVolumes = targetSnapshot.existingVolumes.filter(
		(name) => !nonEmptyVolumes.has(name),
	);
	if (targetSnapshot.nonEmptyVolumes.length > 0) {
		checks.add(
			"volume-conflicts",
			"Volumes on target",
			options.replaceTargetData ? "warn" : "fail",
			options.replaceTargetData
				? `Will be wiped and replaced: ${targetSnapshot.nonEmptyVolumes.join(", ")}.`
				: `Already exist with data on the target: ${targetSnapshot.nonEmptyVolumes.join(", ")}. Enable "Replace existing data on the target" to overwrite them.`,
		);
	} else if (emptyVolumes.length > 0) {
		checks.add(
			"volume-conflicts",
			"Volumes on target",
			"pass",
			`Already created and empty on the target, they will be filled: ${emptyVolumes.join(", ")}.`,
		);
	} else if (snapshot.volumes.length > 0) {
		checks.add(
			"volume-conflicts",
			"Volumes on target",
			"pass",
			"None of the volumes exist on the target yet.",
		);
	}

	const external = snapshot.volumes.filter((volume) => volume.externalStorage);
	if (external.length > 0) {
		checks.add(
			"external-storage",
			"External storage",
			"warn",
			`${external.map((volume) => `${volume.name} (${volume.driver})`).join(", ")} keep their data outside the server: only the volume definition is recreated, the target must reach the same storage.`,
		);
	}

	const needsHelper = totalBytes > 0 || snapshot.directories.length > 0;
	if (needsHelper) {
		const ok = snapshot.helperImagePresent && targetSnapshot.helperImagePresent;
		checks.add(
			"helper-image",
			"Transfer helper",
			ok ? "pass" : "fail",
			ok
				? "The ubuntu image used to stream data is available on both servers."
				: `The ubuntu image is unavailable on the ${
						snapshot.helperImagePresent ? "target" : "source"
					} server and could not be pulled.`,
		);
	}

	const missingBinds = snapshot.binds.filter(
		(bind) => bind.skipReason === "Missing on the source server",
	);
	if (missingBinds.length > 0) {
		checks.add(
			"bind-mounts",
			"Bind mounts",
			"warn",
			`Missing on the source, nothing to copy: ${missingBinds.map((bind) => bind.path).join(", ")}.`,
		);
	}
	if (targetSnapshot.missingSystemPaths.length > 0) {
		checks.add(
			"system-paths",
			"Host paths",
			"warn",
			`Mounted from the host but missing on the target: ${targetSnapshot.missingSystemPaths.join(", ")}.`,
		);
	}

	checks.add(
		"storage",
		"Target storage writable",
		targetSnapshot.storageErrors.length ? "fail" : "pass",
		targetSnapshot.storageErrors.length
			? `Writing on the target failed (full or read-only disk?): ${targetSnapshot.storageErrors.join(" | ")}`
			: "The Dokploy directory and the Docker storage accept writes.",
	);

	const volumeBytes = snapshot.volumes
		.filter((volume) => !volume.externalStorage)
		.reduce((sum, volume) => sum + (volume.sizeBytes ?? 0), 0);
	const fileBytes = totalBytes - volumeBytes;
	const margin = 512 * 1024 * 1024;
	const shortages: string[] = [];
	if (
		targetSnapshot.freeDockerBytes !== null &&
		volumeBytes + margin > targetSnapshot.freeDockerBytes
	) {
		shortages.push(
			`Docker data needs ${formatBytes(volumeBytes)}, ${formatBytes(targetSnapshot.freeDockerBytes)} free`,
		);
	}
	if (
		targetSnapshot.freeBaseBytes !== null &&
		fileBytes + margin > targetSnapshot.freeBaseBytes
	) {
		shortages.push(
			`files need ${formatBytes(fileBytes)}, ${formatBytes(targetSnapshot.freeBaseBytes)} free`,
		);
	}
	checks.add(
		"disk-space",
		"Disk space on target",
		shortages.length ? "fail" : "pass",
		shortages.length
			? `${shortages.join("; ")} (512 MB margin).`
			: `${formatBytes(totalBytes)} to copy, ${formatBytes(targetSnapshot.freeDockerBytes)} free for Docker data.`,
	);
};

const checkNetworkExposure = async (
	checks: CheckList,
	service: MigrationService,
	snapshot: SourceSnapshot,
	source: MigrationHost,
	target: MigrationHost,
	targetSnapshot: TargetSnapshot,
) => {
	if (service.ports.length > 0) {
		checks.add(
			"ports",
			"Published ports",
			targetSnapshot.busyPorts.length ? "fail" : "pass",
			targetSnapshot.busyPorts.length
				? `Already used on the target: ${targetSnapshot.busyPorts.join(", ")}.`
				: `${service.ports.map(portKey).join(", ")} free on the target.`,
		);
	}

	const routed = service.domains.length > 0 || snapshot.traefik.length > 0;
	if (routed) {
		checks.add(
			"traefik",
			"Traefik on target",
			targetSnapshot.traefikRunning ? "pass" : "fail",
			targetSnapshot.traefikRunning
				? "dokploy-traefik is running on the target."
				: "dokploy-traefik is not running on the target: the domains would stop routing.",
		);
	}

	if (service.domains.some((domain) => domain.forwardAuthEnabled)) {
		const settings = await db.query.forwardAuthSettings.findFirst({
			where: target.serverId
				? eq(forwardAuthSettings.serverId, target.serverId)
				: isNull(forwardAuthSettings.serverId),
		});
		checks.add(
			"forward-auth",
			"SSO forward auth",
			settings ? "pass" : "fail",
			settings
				? `Forward auth is configured on the target (${settings.authDomain}).`
				: "Some domains are protected by SSO forward auth, which is not configured on the target. They would become public.",
		);
	}

	const customCertificates = service.domains.filter(
		(domain) => domain.certificateType === "custom",
	);
	const sourceCertificates = source.serverId
		? await db.query.certificates.findMany({
				where: eq(certificates.serverId, source.serverId),
				columns: { name: true },
			})
		: [];
	if (customCertificates.length > 0 || sourceCertificates.length > 0) {
		checks.add(
			"certificates",
			"Custom certificates",
			"warn",
			[
				customCertificates.length
					? `Custom certificate resolvers (${customCertificates
							.map((domain) => domain.customCertResolver || domain.host)
							.join(", ")}) must exist in the target Traefik.`
					: "",
				sourceCertificates.length
					? `Certificates uploaded to the source server are not copied: ${sourceCertificates
							.map((certificate) => certificate.name)
							.join(", ")}.`
					: "",
			]
				.filter(Boolean)
				.join(" "),
		);
	}

	const hosts = domainHosts(service);
	if (hosts.length > 0) {
		const records = await Promise.all(hosts.map(resolveDomainRecords));
		const dnsCheck = describeDomainDns(records, {
			name: target.name,
			registeredAddress: target.ipAddress,
			publicAddresses: targetSnapshot.publicAddresses,
		});
		checks.add("dns", "Domain DNS", dnsCheck.status, dnsCheck.message);
	}

	if (service.placementConstraints.length > 0) {
		checks.add(
			"placement",
			"Placement constraints",
			"warn",
			`Check that the target Swarm satisfies: ${service.placementConstraints.join(", ")}.`,
		);
	}

	if (snapshot.previews.length > 0) {
		checks.add(
			"previews",
			"Preview deployments",
			"warn",
			`${snapshot.previews.length} preview deployment(s) will be recreated on the target; preview domains generated from the source IP keep pointing to it.`,
		);
	}
};

const checkZeroDowntime = (
	checks: CheckList,
	service: MigrationService,
	snapshot: SourceSnapshot,
	options: ServiceMigrationOptions,
) => {
	if (!options.zeroDowntime) return;
	if (!service.supportsZeroDowntime) {
		checks.add(
			"zero-downtime",
			"Zero-downtime migration",
			"fail",
			service.type === "compose"
				? "Only Compose projects deployed in zero-downtime Build Server mode declare overlap-safe releases. Disable zero-downtime migration."
				: "Databases cannot run on two servers at once. Disable zero-downtime migration.",
		);
		return;
	}
	const messages = [
		`The target starts and becomes healthy before the source stops${
			service.type === "compose"
				? " (overlap-safe zero-downtime release)"
				: " (start-first release)"
		}.`,
	];
	if (hasDataToCopy(snapshot)) {
		messages.push(
			"Volumes are copied while the source keeps running: data written on the source after its copy is not migrated.",
		);
	}
	if (options.keepSourceRunning) {
		messages.push(
			"The source keeps running after the migration: switch the DNS, then finish the migration to remove it. Until then both copies run, including background jobs (schedulers, workers).",
		);
	}
	checks.add(
		"zero-downtime",
		"Zero-downtime migration",
		messages.length > 1 ? "warn" : "pass",
		messages.join(" "),
	);
};

const buildPlan = (
	service: MigrationService,
	snapshot: SourceSnapshot,
	source: MigrationHost,
	target: MigrationHost,
	options: ServiceMigrationOptions,
	downtime: boolean,
	targetSnapshot: TargetSnapshot | null,
): ServiceMigrationPlanItem[] => {
	const plan: ServiceMigrationPlanItem[] = [];
	const add = (item: ServiceMigrationPlanItem) => plan.push(item);

	if (service.type === "compose") {
		add({
			category: "runtime",
			action: "recreate",
			label: `Compose project ${service.appName}`,
			detail: `${snapshot.compose?.containers.length ?? 0} container(s) on ${source.name}; redeployed on ${target.name} from the copied code${
				service.buildServerId ? " through its Build Server" : ""
			} (a "Server migration" deployment).`,
		});
		if (service.supportsZeroDowntime) {
			add({
				category: "routing",
				action: "recreate",
				label: "Zero-downtime release routing",
				detail:
					"The target activates a fresh blue/green release: Traefik zero-downtime routers, readiness checks and shared volumes. The release state of the source is not copied.",
			});
		}
	} else {
		const replicas = snapshot.service?.exists
			? snapshot.service.desiredReplicas === null
				? "global"
				: `${snapshot.service.desiredReplicas} replica(s)${
						snapshot.service.desiredReplicas === 0 ? ", kept stopped" : ""
					}`
			: `${service.replicas} replica(s)`;
		add({
			category: "runtime",
			action: "recreate",
			label: `Swarm service ${service.appName}`,
			detail: `${databaseLabel(service.type)} recreated with the same environment, resources, mounts and Swarm settings (${replicas})${
				snapshot.service?.deploymentId
					? "; zero-downtime start-first updates and deployment labels kept"
					: ""
			}.`,
		});
		const image =
			service.type === "application"
				? snapshot.service?.image?.split("@")[0]
				: service.dockerImage;
		if (image) {
			add({
				category: "runtime",
				action: "pull",
				label: image,
				detail:
					service.type === "application"
						? snapshot.service?.deploymentId
							? "Exact image of the running release (same deployment id)."
							: "Exact image of the running release."
						: "Database image.",
			});
		}
		for (const preview of snapshot.previews) {
			add({
				category: "runtime",
				action: "recreate",
				label: `Preview deployment ${preview.name}`,
				detail: preview.image ? preview.image.split("@")[0] : undefined,
			});
		}
	}

	const targetExistingVolumes = new Set(targetSnapshot?.existingVolumes);
	const targetNonEmptyVolumes = new Set(targetSnapshot?.nonEmptyVolumes);
	for (const volume of snapshot.volumes) {
		add({
			category: "data",
			action: volume.externalStorage ? "recreate" : "copy",
			label: `Volume ${volume.name}`,
			detail: volume.externalStorage
				? `Driver ${volume.driver}: definition recreated, data stays on the external storage.`
				: targetNonEmptyVolumes.has(volume.name)
					? "Already holds data on the target: wiped, then filled."
					: targetExistingVolumes.has(volume.name)
						? "Already exists (empty) on the target: filled."
						: "Recreated with the same driver, labels and options, then filled.",
			sizeBytes: volume.externalStorage ? undefined : (volume.sizeBytes ?? 0),
		});
	}
	for (const name of snapshot.missingVolumes) {
		add({
			category: "data",
			action: "recreate",
			label: `Volume ${name}`,
			detail: "Declared but absent on the source: created empty by the deploy.",
		});
	}
	for (const bind of snapshot.binds) {
		add({
			category: "data",
			action: bind.skipReason ? "skip" : "copy",
			label: `Host path ${bind.path}`,
			detail: bind.skipReason ?? "Copied to the same path on the target.",
			sizeBytes: bind.skipReason ? undefined : (bind.sizeBytes ?? 0),
		});
	}
	for (const directory of snapshot.directories) {
		add({
			category: "data",
			action: "copy",
			label: directory.label,
			detail:
				directory.sourcePath === directory.targetPath
					? directory.sourcePath
					: `${directory.sourcePath} → ${directory.targetPath}`,
			sizeBytes: directory.sizeBytes,
		});
	}

	if (service.environmentVariables > 0) {
		add({
			category: "configuration",
			action: "follow",
			label: `${service.environmentVariables} environment variable(s)`,
			detail: "Stored in Dokploy, applied to the target service.",
		});
	}
	const fileMounts = service.mounts.filter((mount) => mount.type === "file");
	if (fileMounts.length > 0) {
		add({
			category: "configuration",
			action: "recreate",
			label: `${fileMounts.length} file mount(s)`,
			detail: fileMounts.map((mount) => mount.mountPath).join(", "),
		});
	}
	for (const port of service.ports) {
		add({
			category: "configuration",
			action: "recreate",
			label: `Published port ${portKey(port)}`,
			detail: `${port.label} (${port.publishMode} mode).`,
		});
	}
	if (service.registryIds.length > 0) {
		add({
			category: "configuration",
			action: "recreate",
			label: "Registry login",
			detail: "The target logs in to the service registry to pull its images.",
		});
	}

	for (const domain of service.domains) {
		add({
			category: "routing",
			action: "recreate",
			label: `${domain.https ? "https" : "http"}://${domain.host}${domain.path && domain.path !== "/" ? domain.path : ""}`,
			detail:
				service.type === "compose"
					? `Routed by the target Traefik (service ${domain.serviceName ?? "?"}).`
					: "Routed by the target Traefik.",
		});
	}
	for (const traefik of snapshot.traefik) {
		const middlewares = Object.keys(traefik.middlewares);
		add({
			category: "routing",
			action: "copy",
			label: `Traefik configuration ${traefik.appName}.yml`,
			detail: middlewares.length
				? `Including middlewares: ${middlewares.join(", ")}.`
				: "Routers and services as currently deployed (manual edits included).",
		});
	}
	if (
		service.type === "application" &&
		service.domains.length > 0 &&
		!snapshot.traefik.some((traefik) => traefik.appName === service.appName)
	) {
		add({
			category: "routing",
			action: "recreate",
			label: `Traefik configuration ${service.appName}.yml`,
			detail:
				"Not found on the source: regenerated on the target from the Dokploy domains, redirects and basic auth.",
		});
	}
	if (service.redirects > 0 || service.securityRules > 0) {
		add({
			category: "routing",
			action: "follow",
			label: `${service.redirects} redirect(s), ${service.securityRules} basic auth rule(s)`,
			detail: "Copied with the Traefik middlewares.",
		});
	}

	const automation: Array<[string, { label: string }[]]> = [
		["Database backup", service.backups],
		["Volume backup", service.volumeBackups],
		["Schedule", service.schedules],
	];
	for (const [kind, items] of automation) {
		for (const item of items) {
			add({
				category: "automation",
				action: "follow",
				label: `${kind}: ${item.label}`,
				detail: `Runs on ${target.name} after the migration.`,
			});
		}
	}

	if (service.deployments > 0) {
		add({
			category: "history",
			action: "follow",
			label: `${service.deployments} deployment(s)`,
			detail:
				"History kept; logs stored on the source are copied with the log directories.",
		});
	}
	if (service.rollbacks > 0) {
		add({
			category: "history",
			action: "follow",
			label: `${service.rollbacks} rollback point(s)`,
			detail: "Rollback images live in the rollback registry.",
		});
	}

	add({
		category: "history",
		action: "remove",
		label: `Runtime on ${source.name}`,
		detail: `${
			service.type === "compose" ? "Containers" : "Swarm service"
		}${service.type === "application" ? " and Traefik routes" : ""} ${
			!downtime && options.keepSourceRunning
				? "kept running until you finish the migration after switching the DNS"
				: "removed once the target is healthy"
		}${downtime ? "; the service is stopped during the copy" : ""}.`,
	});
	add({
		category: "history",
		action: options.removeSourceData ? "remove" : "skip",
		label: `Data on ${source.name}`,
		detail: options.removeSourceData
			? "Volumes and service directories deleted after a successful migration."
			: "Volumes and directories are kept on the source as a backup.",
	});

	return plan;
};

const sumBytes = (snapshot: SourceSnapshot) =>
	snapshot.volumes
		.filter((volume) => !volume.externalStorage)
		.reduce((sum, volume) => sum + (volume.sizeBytes ?? 0), 0) +
	snapshot.binds
		.filter((bind) => !bind.skipReason)
		.reduce((sum, bind) => sum + (bind.sizeBytes ?? 0), 0) +
	snapshot.directories.reduce((sum, directory) => sum + directory.sizeBytes, 0);

/**
 * Runs every pre-flight check and computes the list of what will be migrated.
 * It only reads from both servers (except pulling the small helper image).
 */
export const analyzeServiceMigration = async (
	input: AnalyzeServiceMigrationInput,
): Promise<ServiceMigrationAnalysis> => {
	const service = await loadMigrationService(
		input.serviceType,
		input.serviceId,
	);
	if (service.organizationId !== input.organizationId) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You are not authorized to access this service",
		});
	}
	const checks = new CheckList();
	const [source, targetValid] = await Promise.all([
		resolveMigrationHost(service.serverId),
		checkTargetServer(
			checks,
			service,
			input.targetServerId,
			input.organizationId,
		),
	]);
	const target = targetValid
		? await resolveMigrationHost(input.targetServerId)
		: {
				serverId: input.targetServerId,
				name: "Target server",
				ipAddress: null,
			};
	await checkServiceState(checks, service, input.migrationId);

	const result = (
		snapshot: SourceSnapshot | null,
		targetSnapshot: TargetSnapshot | null,
	): ServiceMigrationAnalysis => {
		const downtime = snapshot
			? requiresDowntime(service, snapshot, input.options.zeroDowntime)
			: true;
		return {
			service,
			source,
			target,
			checks: checks.items,
			plan: snapshot
				? buildPlan(
						service,
						snapshot,
						source,
						target,
						input.options,
						downtime,
						targetSnapshot,
					)
				: [],
			canMigrate: !checks.failed && Boolean(snapshot && targetSnapshot),
			requiresDowntime: downtime,
			totalBytes: snapshot ? sumBytes(snapshot) : 0,
			snapshot,
			targetSnapshot,
		};
	};
	if (!targetValid) return result(null, null);

	const openExecutor = async (host: MigrationHost) => {
		try {
			const executor = await createHostExecutor(host);
			await executor.run("docker version --format '{{.Server.Version}}'");
			return { executor, error: null };
		} catch (error) {
			return {
				executor: null,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	};

	const owned = !input.executors;
	const [opened, openedTarget] = input.executors
		? [
				{ executor: input.executors.source, error: null },
				{ executor: input.executors.target, error: null },
			]
		: await Promise.all([openExecutor(source), openExecutor(target)]);
	for (const [role, host, result] of [
		["source", source, opened],
		["target", target, openedTarget],
	] as const) {
		checks.add(
			`${role}-connection`,
			role === "source" ? "Source server reachable" : "Target server reachable",
			result.executor ? "pass" : "fail",
			result.executor
				? `Connected to ${host.name} and its Docker daemon.`
				: (result.error ?? "Unreachable"),
		);
	}
	const sourceExecutor = opened.executor;
	const targetExecutor = openedTarget.executor;
	try {
		if (!sourceExecutor || !targetExecutor) return result(null, null);
		const snapshot = await discoverSource(
			service,
			sourceExecutor,
			targetExecutor,
		);
		const targetSnapshot = await probeTarget(service, snapshot, targetExecutor);
		const totalBytes = sumBytes(snapshot);
		checkRuntime(checks, service, snapshot, targetSnapshot);
		checkData(checks, snapshot, targetSnapshot, input.options, totalBytes);
		await checkNetworkExposure(
			checks,
			service,
			snapshot,
			source,
			target,
			targetSnapshot,
		);
		checkZeroDowntime(checks, service, snapshot, input.options);
		const downtime = requiresDowntime(
			service,
			snapshot,
			input.options.zeroDowntime,
		);
		checks.add(
			"downtime",
			"Downtime",
			downtime ? "warn" : "pass",
			downtime
				? `The service is stopped on ${source.name} while ${formatBytes(totalBytes)} are copied, then started on ${target.name}.`
				: `${source.name} keeps serving until ${target.name} is healthy${
						input.options.keepSourceRunning
							? " and until you finish the migration"
							: ""
					}.`,
		);
		return result(snapshot, targetSnapshot);
	} finally {
		if (owned) {
			sourceExecutor?.close();
			targetExecutor?.close();
		}
	}
};
