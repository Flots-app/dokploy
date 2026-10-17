import { db } from "@dokploy/server/db";
import {
	applications,
	compose,
	libsql,
	type MigratableServiceType,
	mariadb,
	mongo,
	type mounts,
	mysql,
	postgres,
	redis,
	rollbacks as rollbacksTable,
	schedules,
	volumeBackups,
} from "@dokploy/server/db/schema";
import type {
	EndpointSpecSwarm,
	NetworkSwarm,
	PlacementSwarm,
} from "@dokploy/server/db/schema/shared";
import type { Domain } from "@dokploy/server/services/domain";
import { TRPCError } from "@trpc/server";
import { eq, inArray } from "drizzle-orm";

type Mount = typeof mounts.$inferSelect;
type ServiceStatus = "idle" | "running" | "done" | "error";

export interface MigrationPublishedPort {
	publishedPort: number;
	targetPort: number;
	protocol: "tcp" | "udp";
	publishMode: "ingress" | "host";
	label: string;
}

export interface MigrationPreview {
	previewDeploymentId: string;
	appName: string;
	status: ServiceStatus;
	domainHost: string | null;
}

interface NamedResource {
	appName: string;
	label: string;
}

/** A Dokploy service reduced to what a server migration needs to know. */
export interface MigrationService {
	type: MigratableServiceType;
	id: string;
	name: string;
	appName: string;
	serverId: string | null;
	organizationId: string;
	status: ServiceStatus;
	mounts: Mount[];
	domains: Domain[];
	ports: MigrationPublishedPort[];
	networks: string[];
	placementConstraints: string[];
	replicas: number;
	dockerImage: string | null;
	buildServerId: string | null;
	registryIds: string[];
	composeType: "docker-compose" | "stack" | null;
	/**
	 * Releases may run side by side (Swarm start-first applications and Compose
	 * projects deployed in zero-downtime Build Server mode, which are overlap-safe).
	 */
	supportsZeroDowntime: boolean;
	previews: MigrationPreview[];
	redirects: number;
	securityRules: number;
	backups: NamedResource[];
	volumeBackups: NamedResource[];
	schedules: NamedResource[];
	rollbacks: number;
	deployments: number;
	environmentVariables: number;
}

const countVariables = (env: string | null | undefined) =>
	(env || "")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("#")).length;

const swarmNetworks = (networks: NetworkSwarm[] | null | undefined) =>
	networks?.length
		? networks
				.map((network) => network.Target)
				.filter((target): target is string => Boolean(target))
		: ["dokploy-network"];

const swarmConstraints = (placement: PlacementSwarm | null | undefined) =>
	placement?.Constraints ?? [];

const endpointPorts = (
	endpoint: EndpointSpecSwarm | null | undefined,
): MigrationPublishedPort[] =>
	(endpoint?.Ports ?? [])
		.filter((port) => port.PublishedPort)
		.map((port) => ({
			publishedPort: port.PublishedPort as number,
			targetPort: port.TargetPort ?? 0,
			protocol: port.Protocol === "udp" ? "udp" : "tcp",
			publishMode: port.PublishMode === "ingress" ? "ingress" : "host",
			label: "Custom endpoint port",
		}));

const databasePorts = (
	ports: Array<[number | null | undefined, number, string]>,
	endpoint: EndpointSpecSwarm | null | undefined,
): MigrationPublishedPort[] => {
	if (endpoint) return endpointPorts(endpoint);
	return ports
		.filter(([published]) => Boolean(published))
		.map(([published, target, label]) => ({
			publishedPort: published as number,
			targetPort: target,
			protocol: "tcp",
			publishMode: "host",
			label,
		}));
};

const loadAutomation = async (
	column: "applicationId" | "composeId" | null,
	volumeBackupColumn: keyof typeof volumeBackups.$inferSelect,
	id: string,
) => {
	const scheduleRows = column
		? await db.query.schedules.findMany({
				where: eq(schedules[column], id),
				columns: { appName: true, name: true },
			})
		: [];
	const volumeBackupRows = await db.query.volumeBackups.findMany({
		where: eq(volumeBackups[volumeBackupColumn as "applicationId"], id),
		columns: { appName: true, name: true },
	});
	return {
		schedules: scheduleRows.map((row) => ({
			appName: row.appName,
			label: row.name,
		})),
		volumeBackups: volumeBackupRows.map((row) => ({
			appName: row.appName,
			label: row.name,
		})),
	};
};

const notFound = (type: string) =>
	new TRPCError({ code: "NOT_FOUND", message: `${type} not found` });

const loadApplication = async (id: string): Promise<MigrationService> => {
	const app = await db.query.applications.findFirst({
		where: eq(applications.applicationId, id),
		with: {
			environment: { with: { project: true } },
			mounts: true,
			domains: true,
			ports: true,
			redirects: true,
			security: true,
			previewDeployments: { with: { domain: true } },
			deployments: { columns: { deploymentId: true } },
		},
	});
	if (!app) throw notFound("Application");
	const deploymentIds = app.deployments.map(
		(deployment) => deployment.deploymentId,
	);
	const rollbacks = deploymentIds.length
		? await db.query.rollbacks.findMany({
				where: inArray(rollbacksTable.deploymentId, deploymentIds),
				columns: { rollbackId: true },
			})
		: [];
	const automation = await loadAutomation("applicationId", "applicationId", id);
	return {
		type: "application",
		id,
		name: app.name,
		appName: app.appName,
		serverId: app.serverId,
		organizationId: app.environment.project.organizationId,
		status: app.applicationStatus,
		mounts: app.mounts,
		domains: app.domains,
		ports: app.endpointSpecSwarm
			? endpointPorts(app.endpointSpecSwarm)
			: app.ports.map((port) => ({
					publishedPort: port.publishedPort,
					targetPort: port.targetPort,
					protocol: port.protocol,
					publishMode: port.publishMode,
					label: `Port ${port.publishedPort} → ${port.targetPort}`,
				})),
		networks: swarmNetworks(app.networkSwarm),
		placementConstraints: swarmConstraints(app.placementSwarm),
		replicas: app.replicas,
		dockerImage: app.sourceType === "docker" ? app.dockerImage : null,
		buildServerId: app.buildServerId,
		registryIds: [app.registryId, app.buildRegistryId].filter(
			(value): value is string => Boolean(value),
		),
		composeType: null,
		supportsZeroDowntime: true,
		previews: app.previewDeployments.map((preview) => ({
			previewDeploymentId: preview.previewDeploymentId,
			appName: preview.appName,
			status: preview.previewStatus,
			domainHost: preview.domain?.host ?? null,
		})),
		redirects: app.redirects.length,
		securityRules: app.security.length,
		backups: [],
		rollbacks: rollbacks.length,
		deployments: app.deployments.length,
		environmentVariables: countVariables(app.env),
		...automation,
	};
};

const loadCompose = async (id: string): Promise<MigrationService> => {
	const service = await db.query.compose.findFirst({
		where: eq(compose.composeId, id),
		with: {
			environment: { with: { project: true } },
			mounts: true,
			domains: true,
			backups: { columns: { appName: true, database: true } },
			deployments: { columns: { deploymentId: true } },
		},
	});
	if (!service) throw notFound("Compose");
	const automation = await loadAutomation("composeId", "composeId", id);
	return {
		type: "compose",
		id,
		name: service.name,
		appName: service.appName,
		serverId: service.serverId,
		organizationId: service.environment.project.organizationId,
		status: service.composeStatus,
		mounts: service.mounts,
		domains: service.domains,
		ports: [],
		networks: [],
		placementConstraints: [],
		replicas: 1,
		dockerImage: null,
		buildServerId: service.buildServerId,
		registryIds: service.buildRegistryId ? [service.buildRegistryId] : [],
		composeType: service.composeType,
		supportsZeroDowntime: Boolean(
			service.buildServerId &&
				service.buildRegistryId &&
				service.composeType === "docker-compose",
		),
		previews: [],
		redirects: 0,
		securityRules: 0,
		backups: service.backups.map((backup) => ({
			appName: backup.appName,
			label: `Backup of ${backup.database}`,
		})),
		rollbacks: 0,
		deployments: service.deployments.length,
		environmentVariables: countVariables(service.env),
		...automation,
	};
};

type DatabaseType = Exclude<MigratableServiceType, "application" | "compose">;

const databaseDefaults: Record<
	DatabaseType,
	{ label: string; targetPort: number }
> = {
	postgres: { label: "PostgreSQL", targetPort: 5432 },
	mysql: { label: "MySQL", targetPort: 3306 },
	mariadb: { label: "MariaDB", targetPort: 3306 },
	mongo: { label: "MongoDB", targetPort: 27017 },
	redis: { label: "Redis", targetPort: 6379 },
	libsql: { label: "libSQL", targetPort: 8080 },
};

const findDatabase = async (type: DatabaseType, id: string) => {
	const withRelations = {
		environment: { with: { project: true } },
		mounts: true,
	} as const;
	switch (type) {
		case "postgres":
			return await db.query.postgres.findFirst({
				where: eq(postgres.postgresId, id),
				with: { ...withRelations, backups: true },
			});
		case "mysql":
			return await db.query.mysql.findFirst({
				where: eq(mysql.mysqlId, id),
				with: { ...withRelations, backups: true },
			});
		case "mariadb":
			return await db.query.mariadb.findFirst({
				where: eq(mariadb.mariadbId, id),
				with: { ...withRelations, backups: true },
			});
		case "mongo":
			return await db.query.mongo.findFirst({
				where: eq(mongo.mongoId, id),
				with: { ...withRelations, backups: true },
			});
		case "libsql":
			return await db.query.libsql.findFirst({
				where: eq(libsql.libsqlId, id),
				with: { ...withRelations, backups: true },
			});
		case "redis": {
			const result = await db.query.redis.findFirst({
				where: eq(redis.redisId, id),
				with: withRelations,
			});
			return result ? { ...result, backups: [] } : undefined;
		}
	}
};

const loadDatabase = async (
	type: DatabaseType,
	id: string,
): Promise<MigrationService> => {
	const database = await findDatabase(type, id);
	const defaults = databaseDefaults[type];
	if (!database) throw notFound(defaults.label);
	const automation = await loadAutomation(null, `${type}Id` as never, id);
	const extraPorts: Array<[number | null | undefined, number, string]> =
		"externalGRPCPort" in database
			? [
					[database.externalGRPCPort, 5001, "External gRPC port"],
					[database.externalAdminPort, 5000, "External admin port"],
				]
			: [];
	return {
		type,
		id,
		name: database.name,
		appName: database.appName,
		serverId: database.serverId,
		organizationId: database.environment.project.organizationId,
		status: database.applicationStatus,
		mounts: database.mounts,
		domains: [],
		ports: databasePorts(
			[
				[database.externalPort, defaults.targetPort, "External port"],
				...extraPorts,
			],
			database.endpointSpecSwarm,
		),
		networks: swarmNetworks(database.networkSwarm),
		placementConstraints: swarmConstraints(database.placementSwarm),
		replicas: database.replicas,
		dockerImage: database.dockerImage,
		buildServerId: null,
		registryIds: [],
		composeType: null,
		supportsZeroDowntime: false,
		previews: [],
		redirects: 0,
		securityRules: 0,
		backups: database.backups.map((backup) => ({
			appName: backup.appName,
			label: `Backup of ${backup.database}`,
		})),
		rollbacks: 0,
		deployments: 0,
		environmentVariables: countVariables(database.env),
		...automation,
	};
};

export const loadMigrationService = async (
	type: MigratableServiceType,
	id: string,
): Promise<MigrationService> => {
	if (type === "application") return await loadApplication(id);
	if (type === "compose") return await loadCompose(id);
	return await loadDatabase(type, id);
};

export const databaseLabel = (type: MigratableServiceType) =>
	type === "application"
		? "Application"
		: type === "compose"
			? "Compose"
			: databaseDefaults[type].label;

export const setServiceServerId = async (
	type: MigratableServiceType,
	id: string,
	serverId: string | null,
) => {
	switch (type) {
		case "application":
			await db
				.update(applications)
				.set({ serverId })
				.where(eq(applications.applicationId, id));
			return;
		case "compose":
			await db
				.update(compose)
				.set({ serverId })
				.where(eq(compose.composeId, id));
			return;
		case "postgres":
			await db
				.update(postgres)
				.set({ serverId })
				.where(eq(postgres.postgresId, id));
			return;
		case "mysql":
			await db.update(mysql).set({ serverId }).where(eq(mysql.mysqlId, id));
			return;
		case "mariadb":
			await db
				.update(mariadb)
				.set({ serverId })
				.where(eq(mariadb.mariadbId, id));
			return;
		case "mongo":
			await db.update(mongo).set({ serverId }).where(eq(mongo.mongoId, id));
			return;
		case "redis":
			await db.update(redis).set({ serverId }).where(eq(redis.redisId, id));
			return;
		case "libsql":
			await db.update(libsql).set({ serverId }).where(eq(libsql.libsqlId, id));
			return;
	}
};

export const setServiceStatus = async (
	type: MigratableServiceType,
	id: string,
	status: ServiceStatus,
) => {
	switch (type) {
		case "application":
			await db
				.update(applications)
				.set({ applicationStatus: status })
				.where(eq(applications.applicationId, id));
			return;
		case "compose":
			await db
				.update(compose)
				.set({ composeStatus: status })
				.where(eq(compose.composeId, id));
			return;
		case "postgres":
			await db
				.update(postgres)
				.set({ applicationStatus: status })
				.where(eq(postgres.postgresId, id));
			return;
		case "mysql":
			await db
				.update(mysql)
				.set({ applicationStatus: status })
				.where(eq(mysql.mysqlId, id));
			return;
		case "mariadb":
			await db
				.update(mariadb)
				.set({ applicationStatus: status })
				.where(eq(mariadb.mariadbId, id));
			return;
		case "mongo":
			await db
				.update(mongo)
				.set({ applicationStatus: status })
				.where(eq(mongo.mongoId, id));
			return;
		case "redis":
			await db
				.update(redis)
				.set({ applicationStatus: status })
				.where(eq(redis.redisId, id));
			return;
		case "libsql":
			await db
				.update(libsql)
				.set({ applicationStatus: status })
				.where(eq(libsql.libsqlId, id));
			return;
	}
};
