import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import AdmZip from "adm-zip";
import { and, desc, eq, gt, inArray } from "drizzle-orm";
import { IS_CLOUD } from "../constants";
import { db } from "../db";
import {
	type DatabaseAlertRuleInputType,
	databaseAlertDestinations,
	databaseAlertEvents,
	databaseAlertRules,
	notifications,
	observabilityAgents,
	observabilitySettings,
	postgres,
	redis,
	server,
} from "../db/schema";
import {
	compileMetricQuery,
	DATABASE_ALERT_PRESETS,
	DATABASE_METRIC_CATALOG,
	DATABASE_METRICS,
	type DatabaseKind,
	validateDatabaseAlertInput,
} from "./catalog";
import {
	generateAgentConfig,
	generateAlertRules,
	POSTGRES_DASHBOARD,
	REDIS_DASHBOARD,
} from "./config";
import {
	getObservabilityPrometheusUrl,
	OBSERVABILITY,
	OBSERVABILITY_COMMON_LABELS,
} from "./constants";
import {
	cleanupUnexpectedExporters,
	disableObservabilityComponents,
	reconcileCentralObservabilityStack,
	reconcileDatabaseExporter,
	reconcileObservabilityAgent,
	removeDatabaseExporter,
} from "./orchestration";

type DatabaseDeployment = {
	serviceId: string;
	name: string;
	appName: string;
	databaseType: DatabaseKind;
	organizationId: string;
	serverId: string;
	projectId: string;
	projectName: string;
	environmentId: string;
	environmentName: string;
	databaseName?: string;
	databaseUser?: string;
	databasePassword: string;
	monitoringEnabled: boolean;
	applicationStatus: "idle" | "running" | "done" | "error";
};

const tokenHash = (token: string) =>
	createHash("sha256").update(token).digest("hex");

const constantTimeHashMatch = (token: string, expectedHash: string) => {
	const actual = Buffer.from(tokenHash(token), "hex");
	const expected = Buffer.from(expectedHash, "hex");
	return actual.length === expected.length && timingSafeEqual(actual, expected);
};

const newToken = () => randomBytes(32).toString("base64url");

const getSettings = async (organizationId: string) =>
	db.query.observabilitySettings.findFirst({
		where: eq(observabilitySettings.organizationId, organizationId),
	});

export const ensureObservabilitySettings = async (organizationId: string) => {
	await db
		.insert(observabilitySettings)
		.values({ organizationId })
		.onConflictDoNothing({
			target: observabilitySettings.organizationId,
		});
	const settings = await getSettings(organizationId);
	if (!settings) throw new Error("Unable to create observability settings");
	return settings;
};

export const getObservabilityState = async (organizationId: string) => {
	const settings = await ensureObservabilitySettings(organizationId);
	const agents = await db.query.observabilityAgents.findMany({
		where: eq(observabilityAgents.organizationId, organizationId),
		columns: {
			observabilityAgentId: true,
			serverId: true,
			serverKey: true,
			status: true,
			lastSeenAt: true,
			lastReconciledAt: true,
			walBacklogBytes: true,
			lastError: true,
			createdAt: true,
			updatedAt: true,
			// Explicitly omit authToken and tokenHash.
		},
		with: {
			server: {
				columns: {
					serverId: true,
					name: true,
					serverStatus: true,
				},
			},
		},
	});
	return {
		enabled: settings.enabled,
		status: settings.status,
		publicUrl: settings.publicUrl,
		grafanaPath: settings.grafanaPath,
		lastReconciledAt: settings.lastReconciledAt,
		lastError: settings.lastError,
		agents,
	};
};

export const findDatabaseDeployment = async (
	serviceId: string,
): Promise<DatabaseDeployment | null> => {
	const pg = await db.query.postgres.findFirst({
		where: eq(postgres.postgresId, serviceId),
		with: {
			environment: { with: { project: true } },
		},
	});
	if (pg) {
		return {
			serviceId: pg.postgresId,
			name: pg.name,
			appName: pg.appName,
			databaseType: "postgres",
			organizationId: pg.environment.project.organizationId,
			serverId: pg.serverId ?? "local",
			projectId: pg.environment.projectId,
			projectName: pg.environment.project.name,
			environmentId: pg.environmentId,
			environmentName: pg.environment.name,
			databaseName: pg.databaseName,
			databaseUser: pg.databaseUser,
			databasePassword: pg.databasePassword,
			monitoringEnabled: pg.monitoringEnabled,
			applicationStatus: pg.applicationStatus,
		};
	}

	const rd = await db.query.redis.findFirst({
		where: eq(redis.redisId, serviceId),
		with: {
			environment: { with: { project: true } },
		},
	});
	if (!rd) return null;
	return {
		serviceId: rd.redisId,
		name: rd.name,
		appName: rd.appName,
		databaseType: "redis",
		organizationId: rd.environment.project.organizationId,
		serverId: rd.serverId ?? "local",
		projectId: rd.environment.projectId,
		projectName: rd.environment.project.name,
		environmentId: rd.environmentId,
		environmentName: rd.environment.name,
		databasePassword: rd.databasePassword,
		monitoringEnabled: rd.monitoringEnabled,
		applicationStatus: rd.applicationStatus,
	};
};

const findOrganizationDatabases = async (
	organizationId: string,
): Promise<DatabaseDeployment[]> => {
	const [postgresDatabases, redisDatabases] = await Promise.all([
		db.query.postgres.findMany({
			with: {
				environment: { with: { project: true } },
			},
		}),
		db.query.redis.findMany({
			with: {
				environment: { with: { project: true } },
			},
		}),
	]);

	return [
		...postgresDatabases
			.filter(
				(database) =>
					database.environment.project.organizationId === organizationId,
			)
			.map(
				(database): DatabaseDeployment => ({
					serviceId: database.postgresId,
					name: database.name,
					appName: database.appName,
					databaseType: "postgres",
					organizationId,
					serverId: database.serverId ?? "local",
					projectId: database.environment.projectId,
					projectName: database.environment.project.name,
					environmentId: database.environmentId,
					environmentName: database.environment.name,
					databaseName: database.databaseName,
					databaseUser: database.databaseUser,
					databasePassword: database.databasePassword,
					monitoringEnabled: database.monitoringEnabled,
					applicationStatus: database.applicationStatus,
				}),
			),
		...redisDatabases
			.filter(
				(database) =>
					database.environment.project.organizationId === organizationId,
			)
			.map(
				(database): DatabaseDeployment => ({
					serviceId: database.redisId,
					name: database.name,
					appName: database.appName,
					databaseType: "redis",
					organizationId,
					serverId: database.serverId ?? "local",
					projectId: database.environment.projectId,
					projectName: database.environment.project.name,
					environmentId: database.environmentId,
					environmentName: database.environment.name,
					databasePassword: database.databasePassword,
					monitoringEnabled: database.monitoringEnabled,
					applicationStatus: database.applicationStatus,
				}),
			),
	];
};

const ensureAgentRecord = async ({
	organizationId,
	serverId,
	serverKey,
}: {
	organizationId: string;
	serverId: string | null;
	serverKey: string;
}) => {
	let agent = await db.query.observabilityAgents.findFirst({
		where: and(
			eq(observabilityAgents.organizationId, organizationId),
			eq(observabilityAgents.serverKey, serverKey),
		),
	});
	if (agent) return agent;

	const token = newToken();
	[agent] = await db
		.insert(observabilityAgents)
		.values({
			organizationId,
			serverId,
			serverKey,
			authToken: token,
			tokenHash: tokenHash(token),
			status: "pending",
		})
		.returning();
	if (!agent) throw new Error(`Unable to create agent for ${serverKey}`);
	return agent;
};

const getAgentTargets = async (organizationId: string) => {
	const remoteServers = await db.query.server.findMany({
		where: and(
			eq(server.organizationId, organizationId),
			eq(server.serverType, "deploy"),
		),
		columns: { serverId: true },
	});
	return [
		{ serverId: null, serverKey: "local" },
		...remoteServers.map((item) => ({
			serverId: item.serverId,
			serverKey: item.serverId,
		})),
	];
};

const getEnabledAlertRules = async (organizationId: string) =>
	db.query.databaseAlertRules.findMany({
		where: and(
			eq(databaseAlertRules.organizationId, organizationId),
			eq(databaseAlertRules.enabled, true),
		),
	});

export const reconcileManagedObservability = async (organizationId: string) => {
	const settings = await ensureObservabilitySettings(organizationId);
	if (!settings.enabled) return { skipped: true, errors: [] as string[] };
	if (
		!settings.publicUrl ||
		!settings.gatewayToken ||
		!settings.alertmanagerToken
	) {
		throw new Error(
			"Observability installation is missing its public URL or tokens",
		);
	}

	const errors: string[] = [];
	const databases = await findOrganizationDatabases(organizationId);
	const enabledDatabases = databases.filter(
		(database) => database.monitoringEnabled,
	);
	const agentTargets = await getAgentTargets(organizationId);
	const enabledRules = await getEnabledAlertRules(organizationId);

	try {
		await reconcileCentralObservabilityStack({
			organizationId,
			publicUrl: settings.publicUrl,
			gatewayToken: settings.gatewayToken,
			alertmanagerToken: settings.alertmanagerToken,
			databases: enabledDatabases,
			rules: enabledRules,
		});
		await db
			.update(databaseAlertRules)
			.set({
				syncStatus: "synced",
				syncError: null,
				updatedAt: new Date(),
			})
			.where(eq(databaseAlertRules.organizationId, organizationId));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await db
			.update(databaseAlertRules)
			.set({
				syncStatus: "error",
				syncError: message,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(databaseAlertRules.organizationId, organizationId),
					eq(databaseAlertRules.syncStatus, "pending"),
				),
			);
		await db
			.update(observabilitySettings)
			.set({
				status: "error",
				lastError: message,
				lastReconciledAt: new Date(),
				updatedAt: new Date(),
			})
			.where(eq(observabilitySettings.organizationId, organizationId));
		throw error;
	}

	for (const target of agentTargets) {
		const agent = await ensureAgentRecord({ organizationId, ...target });
		try {
			await reconcileObservabilityAgent({
				...target,
				organizationId,
				publicUrl: settings.publicUrl,
				authToken: agent.authToken,
			});
			await db
				.update(observabilityAgents)
				.set({
					status: "healthy",
					lastError: null,
					lastReconciledAt: new Date(),
					updatedAt: new Date(),
				})
				.where(
					eq(
						observabilityAgents.observabilityAgentId,
						agent.observabilityAgentId,
					),
				);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			errors.push(`Agent ${target.serverKey}: ${message}`);
			await db
				.update(observabilityAgents)
				.set({
					status: "error",
					lastError: message,
					lastReconciledAt: new Date(),
					updatedAt: new Date(),
				})
				.where(
					eq(
						observabilityAgents.observabilityAgentId,
						agent.observabilityAgentId,
					),
				);
		}
	}

	for (const database of enabledDatabases) {
		try {
			await reconcileDatabaseExporter(database);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			errors.push(`Exporter ${database.serviceId}: ${message}`);
		}
	}

	const databasesByServer = new Map<string, Set<string>>();
	for (const database of enabledDatabases) {
		const current =
			databasesByServer.get(database.serverId) ?? new Set<string>();
		current.add(database.serviceId);
		databasesByServer.set(database.serverId, current);
	}
	for (const target of agentTargets) {
		try {
			await cleanupUnexpectedExporters({
				serverId: target.serverId,
				expectedServiceIds:
					databasesByServer.get(target.serverKey) ?? new Set(),
			});
		} catch (error) {
			errors.push(
				`Cleanup ${target.serverKey}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	await db
		.update(observabilitySettings)
		.set({
			status: errors.length === 0 ? "ready" : "degraded",
			lastError: errors.length === 0 ? null : errors.join("\n"),
			lastReconciledAt: new Date(),
			updatedAt: new Date(),
		})
		.where(eq(observabilitySettings.organizationId, organizationId));

	return { skipped: false, errors };
};

export const installManagedObservability = async ({
	organizationId,
	publicUrl,
}: {
	organizationId: string;
	publicUrl: string;
}) => {
	if (IS_CLOUD)
		throw new Error("Managed database observability is self-hosted only");
	const parsedUrl = new URL(publicUrl);
	if (!["http:", "https:"].includes(parsedUrl.protocol)) {
		throw new Error("Dokploy public URL must use HTTP or HTTPS");
	}
	const targets = await getAgentTargets(organizationId);
	if (
		targets.some((target) => target.serverId !== null) &&
		parsedUrl.protocol !== "https:"
	) {
		throw new Error(
			"An HTTPS Dokploy URL is required before enrolling remote servers",
		);
	}

	const existing = await ensureObservabilitySettings(organizationId);
	await db
		.update(observabilitySettings)
		.set({
			enabled: true,
			status: "installing",
			publicUrl: parsedUrl.toString().replace(/\/$/, ""),
			gatewayToken: existing.gatewayToken || newToken(),
			alertmanagerToken: existing.alertmanagerToken || newToken(),
			lastError: null,
			updatedAt: new Date(),
		})
		.where(eq(observabilitySettings.organizationId, organizationId));

	return reconcileManagedObservability(organizationId);
};

export const disableManagedObservability = async (organizationId: string) => {
	const targets = await getAgentTargets(organizationId);
	await disableObservabilityComponents({
		organizationId,
		serverIds: targets.map((target) => target.serverId),
	});
	await db
		.update(observabilitySettings)
		.set({
			enabled: false,
			status: "disabled",
			lastError: null,
			updatedAt: new Date(),
		})
		.where(eq(observabilitySettings.organizationId, organizationId));
	await db
		.update(observabilityAgents)
		.set({ status: "disabled", updatedAt: new Date() })
		.where(eq(observabilityAgents.organizationId, organizationId));
};

export const setDatabaseMonitoringEnabled = async ({
	serviceId,
	enabled,
}: {
	serviceId: string;
	enabled: boolean;
}) => {
	const database = await findDatabaseDeployment(serviceId);
	if (!database) throw new Error("Database not found");
	if (database.databaseType === "postgres") {
		await db
			.update(postgres)
			.set({ monitoringEnabled: enabled })
			.where(eq(postgres.postgresId, serviceId));
	} else {
		await db
			.update(redis)
			.set({ monitoringEnabled: enabled })
			.where(eq(redis.redisId, serviceId));
	}
	if (!enabled) {
		await removeDatabaseExporter({
			databaseType: database.databaseType,
			serviceId,
			serverId: database.serverId === "local" ? null : database.serverId,
		});
	}
	// The preference has already been persisted (and an opted-out exporter
	// removed). A stack reconciliation failure must not make this successful
	// user action look rolled back; the reconciler records and logs its own
	// error state for an explicit retry.
	await queueObservabilityReconcile(serviceId);
	return { enabled };
};

export const queueObservabilityReconcile = async (serviceId: string) => {
	try {
		const database = await findDatabaseDeployment(serviceId);
		if (!database) return;
		const settings = await getSettings(database.organizationId);
		if (!settings?.enabled) return;
		await reconcileManagedObservability(database.organizationId);
	} catch (error) {
		console.error(
			`Managed observability reconciliation failed for ${serviceId}:`,
			error instanceof Error ? error.message : error,
		);
	}
};

export const queueOrganizationObservabilityReconcile = async (
	organizationId: string,
) => {
	try {
		const settings = await getSettings(organizationId);
		if (!settings?.enabled) return;
		await reconcileManagedObservability(organizationId);
	} catch (error) {
		console.error(
			`Managed observability reconciliation failed for organization ${organizationId}:`,
			error instanceof Error ? error.message : error,
		);
	}
};

export function getMetricCatalog(databaseType: DatabaseKind): {
	metrics: typeof DATABASE_METRICS;
	presets: (typeof DATABASE_ALERT_PRESETS)[DatabaseKind];
};
export function getMetricCatalog(): {
	metrics: typeof DATABASE_METRICS;
	presets: typeof DATABASE_ALERT_PRESETS;
};
export function getMetricCatalog(databaseType?: DatabaseKind) {
	return {
		metrics: databaseType
			? DATABASE_METRICS.filter(
					(metric) => metric.databaseType === databaseType,
				)
			: DATABASE_METRICS,
		presets: databaseType
			? DATABASE_ALERT_PRESETS[databaseType]
			: DATABASE_ALERT_PRESETS,
	};
}

const validateDestinationIds = async (
	organizationId: string,
	notificationIds: string[],
) => {
	if (notificationIds.length === 0) return;
	const found = await db
		.select({ notificationId: notifications.notificationId })
		.from(notifications)
		.where(
			and(
				eq(notifications.organizationId, organizationId),
				inArray(notifications.notificationId, notificationIds),
			),
		);
	if (found.length !== new Set(notificationIds).size) {
		throw new Error("One or more notification destinations are not available");
	}
};

const synchronizeRuleChange = async (
	organizationId: string,
	ruleId: string,
) => {
	try {
		await reconcileManagedObservability(organizationId);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await db
			.update(databaseAlertRules)
			.set({ syncStatus: "error", syncError: message, updatedAt: new Date() })
			.where(eq(databaseAlertRules.databaseAlertRuleId, ruleId));
	}
};

export const createDatabaseAlertRule = async ({
	organizationId,
	input,
}: {
	organizationId: string;
	input: DatabaseAlertRuleInputType;
}) => {
	const database = await findDatabaseDeployment(input.serviceId);
	if (!database || database.organizationId !== organizationId) {
		throw new Error("Database not found");
	}
	validateDatabaseAlertInput(input, database.databaseType);
	await validateDestinationIds(organizationId, input.notificationIds);

	const rule = await db.transaction(async (tx) => {
		const [created] = await tx
			.insert(databaseAlertRules)
			.values({
				organizationId,
				serviceId: input.serviceId,
				databaseType: database.databaseType,
				metricKey: input.metricKey,
				operator: input.operator,
				threshold: input.threshold,
				lookbackWindow: input.lookbackWindow,
				forDuration: input.forDuration,
				severity: input.severity,
				name: input.name,
				description: input.description,
				enabled: input.enabled,
				syncStatus: "pending",
			})
			.returning();
		if (!created) throw new Error("Failed to create alert rule");
		if (input.notificationIds.length > 0) {
			await tx.insert(databaseAlertDestinations).values(
				[...new Set(input.notificationIds)].map((notificationId) => ({
					databaseAlertRuleId: created.databaseAlertRuleId,
					notificationId,
				})),
			);
		}
		return created;
	});
	await synchronizeRuleChange(organizationId, rule.databaseAlertRuleId);
	return db.query.databaseAlertRules.findFirst({
		where: eq(databaseAlertRules.databaseAlertRuleId, rule.databaseAlertRuleId),
		with: { destinations: true },
	});
};

export const updateDatabaseAlertRule = async ({
	organizationId,
	ruleId,
	input,
}: {
	organizationId: string;
	ruleId: string;
	input: DatabaseAlertRuleInputType;
}) => {
	const existing = await db.query.databaseAlertRules.findFirst({
		where: and(
			eq(databaseAlertRules.databaseAlertRuleId, ruleId),
			eq(databaseAlertRules.organizationId, organizationId),
		),
	});
	if (!existing) throw new Error("Alert rule not found");
	const database = await findDatabaseDeployment(input.serviceId);
	if (!database || database.organizationId !== organizationId) {
		throw new Error("Database not found");
	}
	validateDatabaseAlertInput(input, database.databaseType);
	await validateDestinationIds(organizationId, input.notificationIds);

	await db.transaction(async (tx) => {
		await tx
			.update(databaseAlertRules)
			.set({
				serviceId: input.serviceId,
				databaseType: database.databaseType,
				metricKey: input.metricKey,
				operator: input.operator,
				threshold: input.threshold,
				lookbackWindow: input.lookbackWindow,
				forDuration: input.forDuration,
				severity: input.severity,
				name: input.name,
				description: input.description,
				enabled: input.enabled,
				syncStatus: "pending",
				syncError: null,
				updatedAt: new Date(),
			})
			.where(eq(databaseAlertRules.databaseAlertRuleId, ruleId));
		await tx
			.delete(databaseAlertDestinations)
			.where(eq(databaseAlertDestinations.databaseAlertRuleId, ruleId));
		if (input.notificationIds.length > 0) {
			await tx.insert(databaseAlertDestinations).values(
				[...new Set(input.notificationIds)].map((notificationId) => ({
					databaseAlertRuleId: ruleId,
					notificationId,
				})),
			);
		}
	});
	await synchronizeRuleChange(organizationId, ruleId);
	return db.query.databaseAlertRules.findFirst({
		where: eq(databaseAlertRules.databaseAlertRuleId, ruleId),
		with: { destinations: true },
	});
};

export const removeDatabaseAlertRule = async ({
	organizationId,
	ruleId,
}: {
	organizationId: string;
	ruleId: string;
}) => {
	const [rule] = await db
		.update(databaseAlertRules)
		.set({
			enabled: false,
			syncStatus: "pending",
			syncError: null,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(databaseAlertRules.databaseAlertRuleId, ruleId),
				eq(databaseAlertRules.organizationId, organizationId),
			),
		)
		.returning();
	if (!rule) throw new Error("Alert rule not found");
	await reconcileManagedObservability(organizationId);
	await db
		.delete(databaseAlertRules)
		.where(eq(databaseAlertRules.databaseAlertRuleId, ruleId));
};

export const listDatabaseAlertRules = async ({
	organizationId,
	serviceId,
}: {
	organizationId: string;
	serviceId: string;
}) =>
	db.query.databaseAlertRules.findMany({
		where: and(
			eq(databaseAlertRules.organizationId, organizationId),
			eq(databaseAlertRules.serviceId, serviceId),
		),
		orderBy: [desc(databaseAlertRules.createdAt)],
		with: { destinations: true },
	});

const prometheusUrl = (organizationId: string, path: string) =>
	`${getObservabilityPrometheusUrl(organizationId)}${path}`;

const fetchPrometheus = async (
	organizationId: string,
	path: string,
	searchParams?: URLSearchParams,
) => {
	const url = new URL(prometheusUrl(organizationId, path));
	if (searchParams) url.search = searchParams.toString();
	const response = await fetch(url, {
		headers: { Accept: "application/json" },
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) {
		throw new Error(`Prometheus returned ${response.status}`);
	}
	return response.json() as Promise<{
		status: string;
		data?: { result?: unknown[] };
		error?: string;
	}>;
};

export const getCurrentMetricValue = async ({
	serviceId,
	metricKey,
	lookbackWindow,
}: {
	serviceId: string;
	metricKey: string;
	lookbackWindow?: string;
}) => {
	const database = await findDatabaseDeployment(serviceId);
	if (!database) throw new Error("Database not found");
	const metric = DATABASE_METRIC_CATALOG.get(metricKey);
	if (!metric || metric.databaseType !== database.databaseType) {
		throw new Error("Metric is not available for this database");
	}
	const query = compileMetricQuery(
		metric,
		serviceId,
		lookbackWindow ?? metric.defaultLookback,
	);
	const result = await fetchPrometheus(
		database.organizationId,
		"/api/v1/query",
		new URLSearchParams({ query }),
	);
	return { metric, result: result.data?.result ?? [] };
};

export const getDatabaseAlertStates = async (serviceId: string) => {
	const database = await findDatabaseDeployment(serviceId);
	if (!database) throw new Error("Database not found");
	const query = `ALERTS{service_id="${serviceId.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"}`;
	const result = await fetchPrometheus(
		database.organizationId,
		"/api/v1/query",
		new URLSearchParams({ query }),
	);
	return result.data?.result ?? [];
};

export const getDatabaseAlertHistory = async ({
	organizationId,
	serviceId,
}: {
	organizationId: string;
	serviceId: string;
}) =>
	db.query.databaseAlertEvents.findMany({
		where: and(
			eq(databaseAlertEvents.organizationId, organizationId),
			eq(databaseAlertEvents.serviceId, serviceId),
			gt(
				databaseAlertEvents.createdAt,
				new Date(Date.now() - OBSERVABILITY.eventRetentionDays * 86_400_000),
			),
		),
		orderBy: [desc(databaseAlertEvents.createdAt)],
		with: { deliveries: true, rule: true },
	});

type DatabaseAlertTransition = {
	databaseAlertEventId: string;
	organizationId: string;
	fingerprint: string;
	status: "pending" | "firing" | "resolved";
	startsAt: Date;
	createdAt: Date;
};

const databaseAlertCycleKey = (
	event: Pick<
		DatabaseAlertTransition,
		"organizationId" | "fingerprint" | "startsAt"
	>,
) =>
	`${event.organizationId}\u0000${event.fingerprint}\u0000${event.startsAt.toISOString()}`;

export const selectPurgeableDatabaseAlertEventIds = <
	T extends DatabaseAlertTransition,
>(
	events: readonly T[],
	cutoff: Date,
) => {
	const resolvedCycles = new Set(
		events
			.filter((event) => event.status === "resolved")
			.map(databaseAlertCycleKey),
	);

	return events
		.filter(
			(event) =>
				event.createdAt < cutoff &&
				(event.status !== "firing" ||
					resolvedCycles.has(databaseAlertCycleKey(event))),
		)
		.map((event) => event.databaseAlertEventId);
};

export const purgeExpiredDatabaseAlertHistory = async () => {
	const events = await db.query.databaseAlertEvents.findMany({
		columns: {
			databaseAlertEventId: true,
			organizationId: true,
			fingerprint: true,
			status: true,
			startsAt: true,
			createdAt: true,
		},
	});
	const eventIds = selectPurgeableDatabaseAlertEventIds(
		events,
		new Date(Date.now() - OBSERVABILITY.eventRetentionDays * 86_400_000),
	);
	if (eventIds.length === 0) {
		return;
	}
	await db
		.delete(databaseAlertEvents)
		.where(inArray(databaseAlertEvents.databaseAlertEventId, eventIds));
};

export const generateExpectedDatabaseMetrics = async (
	organizationId?: string,
) => {
	const [postgresDatabases, redisDatabases] = await Promise.all([
		db.query.postgres.findMany({
			with: { environment: { with: { project: true } } },
		}),
		db.query.redis.findMany({
			with: { environment: { with: { project: true } } },
		}),
	]);
	const lines = [
		"# HELP dokploy_database_expected_up Whether Dokploy expects this database to be running.",
		"# TYPE dokploy_database_expected_up gauge",
	];
	const escapeMetricLabel = (value: string) =>
		value
			.replaceAll("\\", "\\\\")
			.replaceAll('"', '\\"')
			.replaceAll("\n", "\\n");
	for (const database of [...postgresDatabases, ...redisDatabases]) {
		if (
			organizationId &&
			database.environment.project.organizationId !== organizationId
		) {
			continue;
		}
		const isPostgres = "postgresId" in database;
		const serviceId = isPostgres ? database.postgresId : database.redisId;
		const databaseType = isPostgres ? "postgres" : "redis";
		const labels = {
			organization_id: database.environment.project.organizationId,
			server_id: database.serverId ?? "local",
			project_id: database.environment.projectId,
			environment_id: database.environmentId,
			database_type: databaseType,
			service_id: serviceId,
		};
		lines.push(
			`dokploy_database_expected_up{${Object.entries(labels)
				.map(([key, value]) => `${key}="${escapeMetricLabel(value)}"`)
				.join(
					",",
				)}} ${database.monitoringEnabled && database.applicationStatus === "done" ? 1 : 0}`,
		);
	}
	return `${lines.join("\n")}\n`;
};

export const authorizeRemoteWrite = async ({
	serverKey,
	token,
}: {
	serverKey: string;
	token: string;
}) => {
	const agents = await db.query.observabilityAgents.findMany({
		where: eq(observabilityAgents.serverKey, serverKey),
	});
	const agent = agents.find((candidate) =>
		constantTimeHashMatch(token, candidate.tokenHash),
	);
	if (!agent) return null;
	await db
		.update(observabilityAgents)
		.set({
			status: "healthy",
			lastSeenAt: new Date(),
			lastError: null,
			updatedAt: new Date(),
		})
		.where(
			eq(observabilityAgents.observabilityAgentId, agent.observabilityAgentId),
		);
	return {
		organizationId: agent.organizationId,
		observabilityAgentId: agent.observabilityAgentId,
	};
};

export const authorizeObservabilityToken = async (
	token: string,
	type: "gateway" | "alertmanager",
) => {
	const settings = await db.query.observabilitySettings.findMany({
		where: eq(observabilitySettings.enabled, true),
	});
	return (
		settings.find((candidate) => {
			const expected =
				type === "gateway"
					? candidate.gatewayToken
					: candidate.alertmanagerToken;
			return expected
				? constantTimeHashMatch(token, tokenHash(expected))
				: false;
		}) ?? null
	);
};

export const exportObservabilityArtifacts = async (
	organizationId: string,
	serviceId: string,
) => {
	const settings = await ensureObservabilitySettings(organizationId);
	const rules = (await getEnabledAlertRules(organizationId)).filter(
		(rule) => rule.serviceId === serviceId,
	);
	const zip = new AdmZip();
	zip.addFile(
		"dashboards/postgres.json",
		Buffer.from(JSON.stringify(POSTGRES_DASHBOARD, null, 2)),
	);
	zip.addFile(
		"dashboards/redis.json",
		Buffer.from(JSON.stringify(REDIS_DASHBOARD, null, 2)),
	);
	zip.addFile(
		"rules/database-alerts.yml",
		Buffer.from(generateAlertRules(rules)),
	);
	zip.addFile(
		"agent/prometheus-agent.yml",
		Buffer.from(
			generateAgentConfig({
				publicUrl: settings.publicUrl ?? "https://dokploy.example.com",
				serverKey: "SERVER_ID",
				organizationId,
			}).replace(
				"/run/secrets/dokploy-observability-agent-token",
				"/path/to/remote-write-token",
			),
		),
	);
	zip.addFile(
		"README.md",
		Buffer.from(`# Dokploy managed database observability export

This bundle contains portable Grafana dashboard JSON, Prometheus rule YAML,
and a Prometheus Agent configuration suitable as a starting point for a
Kubernetes migration.

Required labels on every database series:

${OBSERVABILITY_COMMON_LABELS.map((label) => `- \`${label}\``).join("\n")}

Collection interval: ${OBSERVABILITY.scrapeInterval}
Dokploy retention: ${OBSERVABILITY.retention}

Exporter credentials are intentionally not included.
`),
	);
	return {
		filename: `dokploy-observability-${new Date().toISOString().slice(0, 10)}.zip`,
		contentType: "application/zip",
		data: zip.toBuffer().toString("base64"),
	};
};

export const getObservabilityOrganizationForService = async (
	serviceId: string,
) => {
	const database = await findDatabaseDeployment(serviceId);
	return database?.organizationId ?? null;
};
