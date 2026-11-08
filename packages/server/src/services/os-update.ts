/**
 * OS updates of the remote servers: maintenance configurations, their
 * servers, assessments and runs. The controller (utils/os-updates) does the
 * work; this service records what users ask for.
 *
 * Every call carries the access of the member who asks: the servers they may
 * reach (a member restricted to some servers sees and changes only those),
 * and `requireRun`, the check of the right to make servers run apt as root
 * (osUpdate.run). Assigning servers, enabling a configuration, changing its
 * window or what it installs, and assessing a server all lead to root apt
 * runs: they need it, as Check now and Install now do.
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

export interface OsUpdateAccess {
	organizationId: string;
	/** The servers of the organization the member may access. */
	serverIds: Set<string>;
	/** Throws unless the member may make servers run apt as root. */
	requireRun: () => Promise<void>;
}

const notFound = (what: string) =>
	new TRPCError({ code: "NOT_FOUND", message: `${what} not found` });

const forbiddenServer = () =>
	new TRPCError({
		code: "UNAUTHORIZED",
		message: "You are not authorized to access this server",
	});

const isUniqueViolation = (error: unknown) =>
	(error as { cause?: { code?: string } }).cause?.code === "23505" ||
	(error as { code?: string }).code === "23505";

/** A server of the organization the member may access. */
const findServer = async (serverId: string, access: OsUpdateAccess) => {
	const row = await db.query.server.findFirst({
		where: and(
			eq(server.serverId, serverId),
			eq(server.organizationId, access.organizationId),
		),
		columns: { serverId: true, name: true, serverStatus: true },
	});
	if (!row) throw notFound("Server");
	if (!access.serverIds.has(serverId)) throw forbiddenServer();
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

/** The servers a configuration applies to. */
const serversOf = async (osUpdateConfigurationId: string) =>
	(
		await db.query.osUpdateServers.findMany({
			where: eq(
				osUpdateServers.osUpdateConfigurationId,
				osUpdateConfigurationId,
			),
			columns: { serverId: true },
		})
	).map((row) => row.serverId);

/**
 * A change to a configuration itself (its window, what it installs, whether
 * it runs, its removal) applies to all its servers: the member must access
 * every one of them.
 */
const assertWholeConfiguration = (
	serverIds: string[],
	access: OsUpdateAccess,
) => {
	if (serverIds.some((serverId) => !access.serverIds.has(serverId))) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message:
				"This configuration also applies to servers you cannot access: only its servers can be changed",
		});
	}
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

export const listOsUpdateConfigurations = async (access: OsUpdateAccess) => {
	const rows = await db.query.osUpdateConfigurations.findMany({
		where: eq(osUpdateConfigurations.organizationId, access.organizationId),
		with: {
			servers: {
				with: { server: { columns: { serverId: true, name: true } } },
			},
		},
		orderBy: (table, { asc }) => asc(table.name),
	});
	const now = new Date();
	return rows.map(({ servers, ...configuration }) => {
		const listed = servers.flatMap((row) => (row.server ? [row.server] : []));
		return {
			...configuration,
			servers: listed.filter((item) => access.serverIds.has(item.serverId)),
			/** Servers it applies to that the member cannot access. */
			hiddenServers: listed.filter(
				(item) => !access.serverIds.has(item.serverId),
			).length,
			window: windowOf(configuration, now),
		};
	});
};

/**
 * Assigns the servers a member may access to a configuration: those listed
 * join it (leaving any other, and assessed every day from then on), those
 * it had and are not listed leave it. Servers out of the member's access
 * stay as they are. Returns the servers that joined.
 */
const assignServers = async (
	tx: Transaction,
	configurationId: string,
	serverIds: string[],
	access: OsUpdateAccess,
) => {
	const wantedIds = new Set(serverIds);
	const wanted = [...wantedIds];
	if (wanted.some((serverId) => !access.serverIds.has(serverId))) {
		throw forbiddenServer();
	}
	if (wanted.length) {
		const owned = await tx
			.select({ serverId: server.serverId })
			.from(server)
			.where(
				and(
					inArray(server.serverId, wanted),
					eq(server.organizationId, access.organizationId),
				),
			);
		if (owned.length !== wanted.length) throw notFound("Server");
	}
	const current = await tx
		.select({ serverId: osUpdateServers.serverId })
		.from(osUpdateServers)
		.where(eq(osUpdateServers.osUpdateConfigurationId, configurationId));
	const currentIds = new Set(current.map((row) => row.serverId));
	const leaving = [...currentIds].filter(
		(serverId) => access.serverIds.has(serverId) && !wantedIds.has(serverId),
	);
	if (leaving.length) {
		await tx
			.update(osUpdateServers)
			.set({ osUpdateConfigurationId: null, assignedAt: null })
			.where(inArray(osUpdateServers.serverId, leaving));
	}
	const joining = wanted.filter((serverId) => !currentIds.has(serverId));
	if (!joining.length) return joining;
	// Joining from another configuration, or for the first time.
	const now = new Date().toISOString();
	await tx
		.insert(osUpdateServers)
		.values(
			joining.map((serverId) => ({
				serverId,
				osUpdateConfigurationId: configurationId,
				assignedAt: now,
				periodicAssessment: true,
			})),
		)
		.onConflictDoUpdate({
			target: osUpdateServers.serverId,
			set: {
				osUpdateConfigurationId: configurationId,
				assignedAt: now,
				periodicAssessment: true,
			},
		});
	return joining;
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

/** Keys sorted at every level: jsonb gives a stored object back reordered. */
const canonical = (value: unknown): unknown =>
	Array.isArray(value)
		? value.map(canonical)
		: value && typeof value === "object"
			? Object.fromEntries(
					Object.entries(value)
						.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
						.map(([key, item]) => [key, canonical(item)]),
				)
			: value;

/** When and what its servers install: what osUpdate.run guards. */
export const installSettings = (
	values: Pick<
		OsUpdateConfiguration,
		| "schedule"
		| "classification"
		| "includePackages"
		| "excludePackages"
		| "reboot"
		| "allowDockerUpdates"
	>,
) =>
	JSON.stringify(
		canonical([
			values.schedule,
			values.classification,
			values.includePackages,
			values.excludePackages,
			values.reboot,
			values.allowDockerUpdates,
		]),
	);

const nameConflict = (name: string) =>
	new TRPCError({
		code: "CONFLICT",
		message: `A configuration named ${name} already exists`,
	});

export const createOsUpdateConfiguration = async (
	input: z.infer<typeof apiCreateOsUpdateConfiguration>,
	access: OsUpdateAccess,
) => {
	if (input.serverIds.some((serverId) => !access.serverIds.has(serverId))) {
		throw forbiddenServer();
	}
	// Servers in an enabled configuration install in its windows.
	if (input.enabled && input.serverIds.length) await access.requireRun();
	try {
		const configuration = await db.transaction(async (tx) => {
			const [row] = await tx
				.insert(osUpdateConfigurations)
				.values({
					...configurationValues(input),
					organizationId: access.organizationId,
				})
				.returning();
			if (!row) throw new Error("The configuration was not created");
			await assignServers(
				tx,
				row.osUpdateConfigurationId,
				input.serverIds,
				access,
			);
			return row;
		});
		requestOsUpdatesTick();
		return configuration;
	} catch (error) {
		if (isUniqueViolation(error)) throw nameConflict(input.name);
		throw error;
	}
};

export const updateOsUpdateConfiguration = async (
	input: z.infer<typeof apiUpdateOsUpdateConfiguration>,
	access: OsUpdateAccess,
) => {
	const current = await findOsUpdateConfiguration(
		input.osUpdateConfigurationId,
		access.organizationId,
	);
	const currentServers = await serversOf(current.osUpdateConfigurationId);
	const settingsChanged =
		installSettings(current) !== installSettings(input) ||
		current.enabled !== input.enabled;
	if (settingsChanged) assertWholeConfiguration(currentServers, access);
	if (input.serverIds.some((serverId) => !access.serverIds.has(serverId))) {
		throw forbiddenServer();
	}
	const hidden = currentServers.filter(
		(serverId) => !access.serverIds.has(serverId),
	);
	const assigned = new Set(currentServers);
	const joining = input.serverIds.filter((serverId) => !assigned.has(serverId));
	const serversAfter = hidden.length + input.serverIds.length;
	// Servers that start installing, or install at other times or other updates.
	if (
		input.enabled &&
		serversAfter > 0 &&
		(joining.length > 0 || settingsChanged)
	) {
		await access.requireRun();
	}
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
				access,
			);
			return row;
		});
		requestOsUpdatesTick();
		return configuration;
	} catch (error) {
		if (isUniqueViolation(error)) throw nameConflict(input.name);
		throw error;
	}
};

/** Turns a configuration on or off, nothing else. */
export const setOsUpdateConfigurationEnabled = async (
	input: { osUpdateConfigurationId: string; enabled: boolean },
	access: OsUpdateAccess,
) => {
	const current = await findOsUpdateConfiguration(
		input.osUpdateConfigurationId,
		access.organizationId,
	);
	const servers = await serversOf(current.osUpdateConfigurationId);
	assertWholeConfiguration(servers, access);
	if (input.enabled && !current.enabled && servers.length) {
		await access.requireRun();
	}
	const [row] = await db
		.update(osUpdateConfigurations)
		.set({ enabled: input.enabled, updatedAt: new Date().toISOString() })
		.where(
			eq(
				osUpdateConfigurations.osUpdateConfigurationId,
				input.osUpdateConfigurationId,
			),
		)
		.returning();
	if (!row) throw notFound("Maintenance configuration");
	requestOsUpdatesTick();
	return row;
};

export const removeOsUpdateConfiguration = async (
	osUpdateConfigurationId: string,
	access: OsUpdateAccess,
) => {
	const configuration = await findOsUpdateConfiguration(
		osUpdateConfigurationId,
		access.organizationId,
	);
	assertWholeConfiguration(await serversOf(osUpdateConfigurationId), access);
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

/** The servers the member may access, with what OS updates know of them. */
export const listOsUpdateServers = async (access: OsUpdateAccess) => {
	const ids = [...access.serverIds];
	if (!ids.length) return [];
	const servers = await db.query.server.findMany({
		where: and(
			eq(server.organizationId, access.organizationId),
			inArray(server.serverId, ids),
		),
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
	const listed = servers.map((row) => row.serverId);
	const [states, runs] = await Promise.all([
		db.query.osUpdateServers.findMany({
			where: inArray(osUpdateServers.serverId, listed),
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
			.where(inArray(osUpdateRuns.serverId, listed))
			.orderBy(osUpdateRuns.serverId, desc(osUpdateRuns.createdAt)),
	]);
	const now = new Date();
	const stateOf = new Map(states.map((state) => [state.serverId, state]));
	const lastRunOf = new Map(runs.map((run) => [run.serverId, run]));
	return servers.map((row) => {
		const state = stateOf.get(row.serverId);
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
						timeZone: configuration.schedule.timeZone,
						window: windowOf(configuration, now),
					}
				: null,
			lastRun: lastRunOf.get(row.serverId) ?? null,
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
	access: OsUpdateAccess,
) => {
	const target = await findServer(input.serverId, access);
	const configuration = input.osUpdateConfigurationId
		? await findOsUpdateConfiguration(
				input.osUpdateConfigurationId,
				access.organizationId,
			)
		: null;
	await ensureServerRow(input.serverId);
	const current = await db.query.osUpdateServers.findFirst({
		where: eq(osUpdateServers.serverId, input.serverId),
	});
	if (current?.osUpdateConfigurationId !== input.osUpdateConfigurationId) {
		// It installs in the configuration's windows, and is assessed every day.
		if (configuration) await access.requireRun();
		await db
			.update(osUpdateServers)
			.set({
				osUpdateConfigurationId: input.osUpdateConfigurationId,
				assignedAt: configuration ? new Date().toISOString() : null,
				...(configuration ? { periodicAssessment: true } : {}),
			})
			.where(eq(osUpdateServers.serverId, input.serverId));
	}
	requestOsUpdatesTick();
	return { server: target, configuration };
};

export const setOsUpdatePeriodicAssessment = async (
	input: { serverId: string; periodicAssessment: boolean },
	access: OsUpdateAccess,
) => {
	const target = await findServer(input.serverId, access);
	// An assessment refreshes the package lists as root.
	if (input.periodicAssessment) await access.requireRun();
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
	access: OsUpdateAccess,
) => {
	const target = await findServer(serverId, access);
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

/**
 * "Install now": a one-time run, queued for the controller. One per server
 * at a time: a unique index refuses a second one, even at the same instant.
 */
export const installOsUpdatesNow = async (
	input: z.infer<typeof apiInstallOsUpdatesNow>,
	access: OsUpdateAccess,
	requestedBy: string,
) => {
	const target = await findServer(input.serverId, access);
	if (target.serverStatus !== "active") {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `${target.name} is inactive in Dokploy`,
		});
	}
	const { serverId, maxDurationMinutes, ...rest } = input;
	const now = new Date();
	let run: typeof osUpdateRuns.$inferSelect | undefined;
	try {
		[run] = await db
			.insert(osUpdateRuns)
			.values({
				organizationId: access.organizationId,
				serverId,
				trigger: "manual",
				deadline: new Date(
					now.getTime() + maxDurationMinutes * 60_000,
				).toISOString(),
				settings: osUpdateSettingsSchema.parse(rest),
				requestedBy,
			})
			.returning();
	} catch (error) {
		if (!isUniqueViolation(error)) throw error;
		throw new TRPCError({
			code: "CONFLICT",
			message: `An installation is already queued or running on ${target.name}`,
		});
	}
	if (!run) throw new Error("The run was not queued");
	await ensureServerRow(serverId);
	requestOsUpdatesTick();
	return { run, server: target };
};

/** Cancels a run that has not started: one that runs cannot stop halfway. */
export const cancelOsUpdateRun = async (
	osUpdateRunId: string,
	access: OsUpdateAccess,
) => {
	const pending = await db.query.osUpdateRuns.findFirst({
		where: and(
			eq(osUpdateRuns.osUpdateRunId, osUpdateRunId),
			eq(osUpdateRuns.organizationId, access.organizationId),
		),
		columns: { serverId: true },
	});
	if (!pending) throw notFound("Run");
	const target = await findServer(pending.serverId, access);
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
	return { run, server: target };
};

/** The history of the servers the member may access, newest first, without the logs. */
export const listOsUpdateRuns = async (
	input: { serverId?: string; limit: number },
	access: OsUpdateAccess,
) => {
	const ids = [...access.serverIds].filter(
		(serverId) => !input.serverId || serverId === input.serverId,
	);
	if (!ids.length) return [];
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
				eq(osUpdateRuns.organizationId, access.organizationId),
				inArray(osUpdateRuns.serverId, ids),
			),
		)
		.orderBy(desc(osUpdateRuns.createdAt))
		.limit(input.limit);
};

export const findOsUpdateRun = async (
	osUpdateRunId: string,
	access: OsUpdateAccess,
) => {
	const run = await db.query.osUpdateRuns.findFirst({
		where: and(
			eq(osUpdateRuns.osUpdateRunId, osUpdateRunId),
			eq(osUpdateRuns.organizationId, access.organizationId),
		),
		with: {
			server: { columns: { name: true } },
			configuration: { columns: { name: true, schedule: true } },
		},
	});
	// Another member's server: as if it did not exist.
	if (!run || !access.serverIds.has(run.serverId)) throw notFound("Run");
	return run;
};
