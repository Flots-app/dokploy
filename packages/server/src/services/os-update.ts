/**
 * OS updates of the remote servers: maintenance configurations, their
 * servers, assessments and runs. The controller (utils/os-updates) does the
 * work; this service records what users ask for.
 */
import { db } from "@dokploy/server/db";
import {
	type apiCreateOsUpdateConfiguration,
	type apiInstallOsUpdatesNow,
	type apiUpdateOsUpdateConfiguration,
	type OsUpdateConfiguration,
	osUpdateConfigurations,
	osUpdateRuns,
	osUpdateServers,
	server,
} from "@dokploy/server/db/schema";
import { requestOsUpdatesTick } from "@dokploy/server/utils/os-updates/controller";
import { osUpdateSettingsSchema } from "@dokploy/server/utils/os-updates/filters";
import {
	nextWindow,
	openWindow,
} from "@dokploy/server/utils/os-updates/schedule";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, getTableColumns, inArray } from "drizzle-orm";
import type { z } from "zod";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

const notFound = (what: string) =>
	new TRPCError({ code: "NOT_FOUND", message: `${what} not found` });

const findServer = async (serverId: string, organizationId: string) => {
	const row = await db.query.server.findFirst({
		where: and(
			eq(server.serverId, serverId),
			eq(server.organizationId, organizationId),
		),
		columns: { serverId: true, name: true, serverStatus: true },
	});
	if (!row) throw notFound("Server");
	return row;
};

export const findOsUpdateConfiguration = async (
	osUpdateConfigurationId: string,
	organizationId: string,
) => {
	const configuration = await db.query.osUpdateConfigurations.findFirst({
		where: and(
			eq(
				osUpdateConfigurations.osUpdateConfigurationId,
				osUpdateConfigurationId,
			),
			eq(osUpdateConfigurations.organizationId, organizationId),
		),
	});
	if (!configuration) throw notFound("Maintenance configuration");
	return configuration;
};

/** The window open now, or the next one. */
const windowOf = (configuration: OsUpdateConfiguration, now: Date) => {
	if (!configuration.enabled) return { open: null, next: null };
	const open = openWindow(configuration.schedule, now);
	const next = nextWindow(configuration.schedule, now);
	return {
		open: open
			? { start: open.start.toISOString(), end: open.end.toISOString() }
			: null,
		next: next
			? { start: next.start.toISOString(), end: next.end.toISOString() }
			: null,
	};
};

export const listOsUpdateConfigurations = async (organizationId: string) => {
	const rows = await db.query.osUpdateConfigurations.findMany({
		where: eq(osUpdateConfigurations.organizationId, organizationId),
		with: {
			servers: {
				with: { server: { columns: { serverId: true, name: true } } },
			},
		},
		orderBy: (table, { asc }) => asc(table.name),
	});
	const now = new Date();
	return rows.map(({ servers, ...configuration }) => ({
		...configuration,
		servers: servers.flatMap((row) => (row.server ? [row.server] : [])),
		window: windowOf(configuration, now),
	}));
};

/**
 * Assigns the servers of a configuration: those listed join it (leaving any
 * other), the others it had leave it.
 */
const assignServers = async (
	tx: Transaction,
	configurationId: string,
	serverIds: string[],
	organizationId: string,
) => {
	const wantedIds = new Set(serverIds);
	const wanted = [...wantedIds];
	if (wanted.length) {
		const owned = await tx
			.select({ serverId: server.serverId })
			.from(server)
			.where(
				and(
					inArray(server.serverId, wanted),
					eq(server.organizationId, organizationId),
				),
			);
		if (owned.length !== wanted.length) throw notFound("Server");
	}
	const current = await tx
		.select({
			serverId: osUpdateServers.serverId,
			configurationId: osUpdateServers.osUpdateConfigurationId,
		})
		.from(osUpdateServers)
		.where(eq(osUpdateServers.osUpdateConfigurationId, configurationId));
	const currentIds = new Set(current.map((row) => row.serverId));
	const leaving = [...currentIds].filter(
		(serverId) => !wantedIds.has(serverId),
	);
	if (leaving.length) {
		await tx
			.update(osUpdateServers)
			.set({ osUpdateConfigurationId: null, assignedAt: null })
			.where(inArray(osUpdateServers.serverId, leaving));
	}
	const joining = wanted.filter((serverId) => !currentIds.has(serverId));
	if (!joining.length) return;
	// Joining from another configuration, or for the first time.
	const now = new Date().toISOString();
	await tx
		.insert(osUpdateServers)
		.values(
			joining.map((serverId) => ({
				serverId,
				osUpdateConfigurationId: configurationId,
				assignedAt: now,
			})),
		)
		.onConflictDoUpdate({
			target: osUpdateServers.serverId,
			set: { osUpdateConfigurationId: configurationId, assignedAt: now },
		});
};

const configurationValues = (
	input: z.infer<typeof apiCreateOsUpdateConfiguration>,
) => ({
	name: input.name,
	description: input.description,
	enabled: input.enabled,
	schedule: input.schedule,
	classification: input.classification,
	includePackages: input.includePackages,
	excludePackages: input.excludePackages,
	reboot: input.reboot,
	allowDockerUpdates: input.allowDockerUpdates,
	notifyOnSuccess: input.notifyOnSuccess,
});

const nameTaken = (error: unknown) =>
	(error as { cause?: { code?: string } }).cause?.code === "23505" ||
	(error as { code?: string }).code === "23505";

export const createOsUpdateConfiguration = async (
	input: z.infer<typeof apiCreateOsUpdateConfiguration>,
	organizationId: string,
) => {
	try {
		return await db.transaction(async (tx) => {
			const [configuration] = await tx
				.insert(osUpdateConfigurations)
				.values({ ...configurationValues(input), organizationId })
				.returning();
			if (!configuration) throw new Error("The configuration was not created");
			await assignServers(
				tx,
				configuration.osUpdateConfigurationId,
				input.serverIds,
				organizationId,
			);
			return configuration;
		});
	} catch (error) {
		if (nameTaken(error)) {
			throw new TRPCError({
				code: "CONFLICT",
				message: `A configuration named ${input.name} already exists`,
			});
		}
		throw error;
	}
};

export const updateOsUpdateConfiguration = async (
	input: z.infer<typeof apiUpdateOsUpdateConfiguration>,
	organizationId: string,
) => {
	await findOsUpdateConfiguration(
		input.osUpdateConfigurationId,
		organizationId,
	);
	try {
		const configuration = await db.transaction(async (tx) => {
			const [row] = await tx
				.update(osUpdateConfigurations)
				.set({
					...configurationValues(input),
					// Windows before a change are never reported missed.
					updatedAt: new Date().toISOString(),
				})
				.where(
					eq(
						osUpdateConfigurations.osUpdateConfigurationId,
						input.osUpdateConfigurationId,
					),
				)
				.returning();
			if (!row) throw notFound("Maintenance configuration");
			await assignServers(
				tx,
				row.osUpdateConfigurationId,
				input.serverIds,
				organizationId,
			);
			return row;
		});
		requestOsUpdatesTick();
		return configuration;
	} catch (error) {
		if (nameTaken(error)) {
			throw new TRPCError({
				code: "CONFLICT",
				message: `A configuration named ${input.name} already exists`,
			});
		}
		throw error;
	}
};

export const removeOsUpdateConfiguration = async (
	osUpdateConfigurationId: string,
	organizationId: string,
) => {
	const configuration = await findOsUpdateConfiguration(
		osUpdateConfigurationId,
		organizationId,
	);
	// Its servers leave it (set null); its runs keep their history.
	await db
		.delete(osUpdateConfigurations)
		.where(
			eq(
				osUpdateConfigurations.osUpdateConfigurationId,
				osUpdateConfigurationId,
			),
		);
	return configuration;
};

/** Every server of the organization, with what OS updates know of it. */
export const listOsUpdateServers = async (organizationId: string) => {
	const servers = await db.query.server.findMany({
		where: eq(server.organizationId, organizationId),
		columns: {
			serverId: true,
			name: true,
			ipAddress: true,
			serverStatus: true,
			serverType: true,
			username: true,
		},
		orderBy: (table, { asc }) => asc(table.name),
	});
	if (!servers.length) return [];
	const ids = servers.map((row) => row.serverId);
	const [states, runs] = await Promise.all([
		db.query.osUpdateServers.findMany({
			where: inArray(osUpdateServers.serverId, ids),
			with: { configuration: true },
		}),
		db
			.selectDistinctOn([osUpdateRuns.serverId], {
				serverId: osUpdateRuns.serverId,
				osUpdateRunId: osUpdateRuns.osUpdateRunId,
				status: osUpdateRuns.status,
				trigger: osUpdateRuns.trigger,
				createdAt: osUpdateRuns.createdAt,
				startedAt: osUpdateRuns.startedAt,
				finishedAt: osUpdateRuns.finishedAt,
				message: osUpdateRuns.message,
			})
			.from(osUpdateRuns)
			.where(inArray(osUpdateRuns.serverId, ids))
			.orderBy(osUpdateRuns.serverId, desc(osUpdateRuns.createdAt)),
	]);
	const now = new Date();
	return servers.map((row) => {
		const state = states.find((item) => item.serverId === row.serverId);
		const configuration = state?.configuration ?? null;
		return {
			...row,
			periodicAssessment: state?.periodicAssessment ?? false,
			assessment: state?.assessment ?? null,
			assessedAt: state?.assessedAt ?? null,
			assessmentError: state?.assessmentError ?? null,
			assessmentRequested: Boolean(state?.assessmentRequestedAt),
			configuration: configuration
				? {
						osUpdateConfigurationId: configuration.osUpdateConfigurationId,
						name: configuration.name,
						enabled: configuration.enabled,
						window: windowOf(configuration, now),
					}
				: null,
			lastRun: runs.find((run) => run.serverId === row.serverId) ?? null,
		};
	});
};

/** A server's row, created on first use (not assessed periodically by default). */
const ensureServerRow = (serverId: string) =>
	db
		.insert(osUpdateServers)
		.values({ serverId, periodicAssessment: false })
		.onConflictDoNothing();

export const assignOsUpdateConfiguration = async (
	input: { serverId: string; osUpdateConfigurationId: string | null },
	organizationId: string,
) => {
	const target = await findServer(input.serverId, organizationId);
	const configuration = input.osUpdateConfigurationId
		? await findOsUpdateConfiguration(
				input.osUpdateConfigurationId,
				organizationId,
			)
		: null;
	await ensureServerRow(input.serverId);
	const current = await db.query.osUpdateServers.findFirst({
		where: eq(osUpdateServers.serverId, input.serverId),
	});
	if (current?.osUpdateConfigurationId !== input.osUpdateConfigurationId) {
		await db
			.update(osUpdateServers)
			.set({
				osUpdateConfigurationId: input.osUpdateConfigurationId,
				assignedAt: configuration ? new Date().toISOString() : null,
				// A server with a schedule is assessed every day.
				...(configuration ? { periodicAssessment: true } : {}),
			})
			.where(eq(osUpdateServers.serverId, input.serverId));
	}
	requestOsUpdatesTick();
	return { server: target, configuration };
};

export const setOsUpdatePeriodicAssessment = async (
	input: { serverId: string; periodicAssessment: boolean },
	organizationId: string,
) => {
	const target = await findServer(input.serverId, organizationId);
	await ensureServerRow(input.serverId);
	await db
		.update(osUpdateServers)
		.set({ periodicAssessment: input.periodicAssessment })
		.where(eq(osUpdateServers.serverId, input.serverId));
	requestOsUpdatesTick();
	return target;
};

/** "Check now": the controller assesses the server within seconds. */
export const requestOsUpdateAssessment = async (
	serverId: string,
	organizationId: string,
) => {
	const target = await findServer(serverId, organizationId);
	if (target.serverStatus !== "active") {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `${target.name} is inactive in Dokploy`,
		});
	}
	await ensureServerRow(serverId);
	await db
		.update(osUpdateServers)
		.set({ assessmentRequestedAt: new Date().toISOString() })
		.where(eq(osUpdateServers.serverId, serverId));
	requestOsUpdatesTick();
	return target;
};

/** "Install now": a one-time run, queued for the controller. */
export const installOsUpdatesNow = async (
	input: z.infer<typeof apiInstallOsUpdatesNow>,
	organizationId: string,
	requestedBy: string,
) => {
	const target = await findServer(input.serverId, organizationId);
	if (target.serverStatus !== "active") {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `${target.name} is inactive in Dokploy`,
		});
	}
	const queued = await db.query.osUpdateRuns.findFirst({
		where: and(
			eq(osUpdateRuns.serverId, input.serverId),
			eq(osUpdateRuns.trigger, "manual"),
			inArray(osUpdateRuns.status, ["pending", "running"]),
		),
		columns: { osUpdateRunId: true },
	});
	if (queued) {
		throw new TRPCError({
			code: "CONFLICT",
			message: `An installation is already queued or running on ${target.name}`,
		});
	}
	const { serverId, maxDurationMinutes, ...rest } = input;
	const now = new Date();
	const [run] = await db
		.insert(osUpdateRuns)
		.values({
			organizationId,
			serverId,
			trigger: "manual",
			deadline: new Date(
				now.getTime() + maxDurationMinutes * 60_000,
			).toISOString(),
			settings: osUpdateSettingsSchema.parse(rest),
			requestedBy,
		})
		.returning();
	if (!run) throw new Error("The run was not queued");
	await ensureServerRow(serverId);
	requestOsUpdatesTick();
	return { run, server: target };
};

/** Cancels a run that has not started: one that runs cannot stop halfway. */
export const cancelOsUpdateRun = async (
	osUpdateRunId: string,
	organizationId: string,
) => {
	const [run] = await db
		.update(osUpdateRuns)
		.set({
			status: "cancelled",
			finishedAt: new Date().toISOString(),
			message: "Cancelled before it started.",
		})
		.where(
			and(
				eq(osUpdateRuns.osUpdateRunId, osUpdateRunId),
				eq(osUpdateRuns.organizationId, organizationId),
				eq(osUpdateRuns.status, "pending"),
			),
		)
		.returning();
	if (!run) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Only a run that has not started can be cancelled",
		});
	}
	return run;
};

/** The history, newest first, without the logs. */
export const listOsUpdateRuns = async (
	input: { serverId?: string; limit: number },
	organizationId: string,
) => {
	const { log: _log, ...columns } = getTableColumns(osUpdateRuns);
	return db
		.select({
			...columns,
			serverName: server.name,
			configurationName: osUpdateConfigurations.name,
		})
		.from(osUpdateRuns)
		.leftJoin(server, eq(server.serverId, osUpdateRuns.serverId))
		.leftJoin(
			osUpdateConfigurations,
			eq(
				osUpdateConfigurations.osUpdateConfigurationId,
				osUpdateRuns.osUpdateConfigurationId,
			),
		)
		.where(
			and(
				eq(osUpdateRuns.organizationId, organizationId),
				input.serverId ? eq(osUpdateRuns.serverId, input.serverId) : undefined,
			),
		)
		.orderBy(desc(osUpdateRuns.createdAt))
		.limit(input.limit);
};

export const findOsUpdateRun = async (
	osUpdateRunId: string,
	organizationId: string,
) => {
	const run = await db.query.osUpdateRuns.findFirst({
		where: and(
			eq(osUpdateRuns.osUpdateRunId, osUpdateRunId),
			eq(osUpdateRuns.organizationId, organizationId),
		),
		with: {
			server: { columns: { name: true } },
			configuration: { columns: { name: true } },
		},
	});
	if (!run) throw notFound("Run");
	return run;
};
