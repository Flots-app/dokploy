/**
 * OS updates of the remote servers and of the Linux GitHub runner machines:
 * maintenance configurations, their machines, assessments and runs. The
 * controller (utils/os-updates) does the work; this service records what
 * users ask for.
 *
 * Every call carries the access of the member who asks: the servers they may
 * reach (a member restricted to some servers sees and changes only those),
 * the runner machines they may see (githubRunner.read), and two checks:
 * `requireRun`, the right to make machines run apt as root (osUpdate.run),
 * and `requireRunnerUpdate`, the right to take runner machines out of
 * service (githubRunner.update). Assigning machines, enabling a
 * configuration, changing its window or what it installs, and assessing a
 * machine all lead to root apt runs: they need the first, as Check now and
 * Install now do; on runner machines they need the second too.
 */
import { db } from "@dokploy/server/db";
import {
	type apiCreateOsUpdateConfiguration,
	type apiInstallOsUpdatesNow,
	type apiUpdateOsUpdateConfiguration,
	githubRunnerNodes,
	githubRunnerPools,
	type OsUpdateConfiguration,
	osUpdateConfigurations,
	osUpdateRunnerNodes,
	osUpdateRuns,
	osUpdateServers,
	server,
} from "@dokploy/server/db/schema";
import {
	isManagedRunnerNode,
	machineOf,
	type OsUpdateMachine,
	requestOsUpdatesTick,
} from "@dokploy/server/utils/os-updates/controller";
import { osUpdateSettingsSchema } from "@dokploy/server/utils/os-updates/filters";
import {
	isOsUpdateDrain,
	wakeOsUpdateDrains,
} from "@dokploy/server/utils/os-updates/runner-drain";
import {
	nextWindow,
	openWindow,
} from "@dokploy/server/utils/os-updates/schedule";
import { TRPCError } from "@trpc/server";
import {
	and,
	desc,
	eq,
	getTableColumns,
	inArray,
	isNotNull,
	or,
	sql,
} from "drizzle-orm";
import type { z } from "zod";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface OsUpdateAccess {
	organizationId: string;
	/** The servers of the organization the member may access. */
	serverIds: Set<string>;
	/** The runner machines of the organization the member may see. */
	runnerNodeIds: Set<string>;
	/** Throws unless the member may make machines run apt as root. */
	requireRun: () => Promise<void>;
	/** Throws unless the member may take runner machines out of service. */
	requireRunnerUpdate: () => Promise<void>;
}

/** A server or a runner machine, as the API names it. */
export interface OsUpdateMachineInput {
	serverId?: string;
	githubRunnerNodeId?: string;
}

export const machineOfInput = (input: OsUpdateMachineInput): OsUpdateMachine =>
	input.githubRunnerNodeId
		? { kind: "runner", id: input.githubRunnerNodeId }
		: { kind: "server", id: input.serverId ?? "" };

const notFound = (what: string) =>
	new TRPCError({ code: "NOT_FOUND", message: `${what} not found` });

const forbiddenServer = () =>
	new TRPCError({
		code: "UNAUTHORIZED",
		message: "You are not authorized to access this server",
	});

const forbiddenRunner = () =>
	new TRPCError({
		code: "UNAUTHORIZED",
		message: "You are not authorized to access this runner machine",
	});

const LINUX_ONLY =
	"OS updates manage Linux runner machines only: the VM of a Mac follows the update policy of its pool, and macOS its owner";

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

/**
 * A machine of the organization the member may access: its id, name, and
 * whether OS updates may work on it now. A runner machine must be Linux.
 */
const findMachine = async (
	machine: OsUpdateMachine,
	access: OsUpdateAccess,
) => {
	if (machine.kind === "server") {
		const row = await findServer(machine.id, access);
		return {
			machine,
			id: row.serverId,
			name: row.name,
			active: row.serverStatus === "active",
		};
	}
	const node = await db.query.githubRunnerNodes.findFirst({
		where: and(
			eq(githubRunnerNodes.githubRunnerNodeId, machine.id),
			eq(githubRunnerNodes.organizationId, access.organizationId),
		),
		columns: {
			githubRunnerNodeId: true,
			name: true,
			platform: true,
			phase: true,
		},
	});
	if (!node) throw notFound("Runner machine");
	if (!access.runnerNodeIds.has(machine.id)) throw forbiddenRunner();
	if (node.platform !== "linux") {
		throw new TRPCError({ code: "BAD_REQUEST", message: LINUX_ONLY });
	}
	return {
		machine,
		id: node.githubRunnerNodeId,
		name: node.name,
		active: isManagedRunnerNode(node),
	};
};

/** Refused on a machine OS updates cannot work on now. */
const assertActive = (found: {
	name: string;
	active: boolean;
	machine: OsUpdateMachine;
}) => {
	if (found.active) return;
	throw new TRPCError({
		code: "BAD_REQUEST",
		message:
			found.machine.kind === "server"
				? `${found.name} is inactive in Dokploy`
				: `${found.name} is not set up, or in error, in GitHub Runners`,
	});
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

/** The machines a configuration applies to. */
const machinesOf = async (osUpdateConfigurationId: string) => {
	const [servers, runnerNodes] = await Promise.all([
		db.query.osUpdateServers.findMany({
			where: eq(
				osUpdateServers.osUpdateConfigurationId,
				osUpdateConfigurationId,
			),
			columns: { serverId: true },
		}),
		db.query.osUpdateRunnerNodes.findMany({
			where: eq(
				osUpdateRunnerNodes.osUpdateConfigurationId,
				osUpdateConfigurationId,
			),
			columns: { githubRunnerNodeId: true },
		}),
	]);
	return {
		serverIds: servers.map((row) => row.serverId),
		runnerNodeIds: runnerNodes.map((row) => row.githubRunnerNodeId),
	};
};

type Machines = Awaited<ReturnType<typeof machinesOf>>;

/**
 * A change to a configuration itself (its window, what it installs, whether
 * it runs, its removal) applies to all its machines: the member must access
 * every one of them.
 */
const assertWholeConfiguration = (
	machines: Machines,
	access: OsUpdateAccess,
) => {
	if (
		machines.serverIds.some((serverId) => !access.serverIds.has(serverId)) ||
		machines.runnerNodeIds.some((nodeId) => !access.runnerNodeIds.has(nodeId))
	) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message:
				"This configuration also applies to machines you cannot access: only its machines can be changed",
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
			runnerNodes: {
				with: {
					node: { columns: { githubRunnerNodeId: true, name: true } },
				},
			},
		},
		orderBy: (table, { asc }) => asc(table.name),
	});
	const now = new Date();
	return rows.map(({ servers, runnerNodes, ...configuration }) => {
		const listed = servers.flatMap((row) => (row.server ? [row.server] : []));
		const nodes = runnerNodes.flatMap((row) => (row.node ? [row.node] : []));
		return {
			...configuration,
			servers: listed.filter((item) => access.serverIds.has(item.serverId)),
			runnerNodes: nodes.filter((item) =>
				access.runnerNodeIds.has(item.githubRunnerNodeId),
			),
			/** Machines it applies to that the member cannot access. */
			hiddenMachines:
				listed.filter((item) => !access.serverIds.has(item.serverId)).length +
				nodes.filter(
					(item) => !access.runnerNodeIds.has(item.githubRunnerNodeId),
				).length,
			window: windowOf(configuration, now),
		};
	});
};

/**
 * Assigns the machines a member may access to a configuration: those listed
 * join it (leaving any other, and assessed every day from then on), those
 * it had and are not listed leave it. Machines out of the member's access
 * stay as they are. Runner machines must be Linux.
 */
const assignMachines = async (
	tx: Transaction,
	configurationId: string,
	wanted: Machines,
	access: OsUpdateAccess,
) => {
	const wantedServers = new Set(wanted.serverIds);
	const wantedNodes = new Set(wanted.runnerNodeIds);
	if ([...wantedServers].some((serverId) => !access.serverIds.has(serverId))) {
		throw forbiddenServer();
	}
	if ([...wantedNodes].some((nodeId) => !access.runnerNodeIds.has(nodeId))) {
		throw forbiddenRunner();
	}
	if (wantedServers.size) {
		const owned = await tx
			.select({ serverId: server.serverId })
			.from(server)
			.where(
				and(
					inArray(server.serverId, [...wantedServers]),
					eq(server.organizationId, access.organizationId),
				),
			);
		if (owned.length !== wantedServers.size) throw notFound("Server");
	}
	if (wantedNodes.size) {
		const owned = await tx
			.select({
				id: githubRunnerNodes.githubRunnerNodeId,
				platform: githubRunnerNodes.platform,
			})
			.from(githubRunnerNodes)
			.where(
				and(
					inArray(githubRunnerNodes.githubRunnerNodeId, [...wantedNodes]),
					eq(githubRunnerNodes.organizationId, access.organizationId),
				),
			);
		if (owned.length !== wantedNodes.size) throw notFound("Runner machine");
		if (owned.some((node) => node.platform !== "linux")) {
			throw new TRPCError({ code: "BAD_REQUEST", message: LINUX_ONLY });
		}
	}
	const now = new Date().toISOString();
	const joined = { serverIds: [] as string[], runnerNodeIds: [] as string[] };

	const currentServers = new Set(
		(
			await tx
				.select({ serverId: osUpdateServers.serverId })
				.from(osUpdateServers)
				.where(eq(osUpdateServers.osUpdateConfigurationId, configurationId))
		).map((row) => row.serverId),
	);
	const leavingServers = [...currentServers].filter(
		(serverId) =>
			access.serverIds.has(serverId) && !wantedServers.has(serverId),
	);
	if (leavingServers.length) {
		await tx
			.update(osUpdateServers)
			.set({ osUpdateConfigurationId: null, assignedAt: null })
			.where(inArray(osUpdateServers.serverId, leavingServers));
	}
	joined.serverIds = [...wantedServers].filter(
		(serverId) => !currentServers.has(serverId),
	);
	if (joined.serverIds.length) {
		// Joining from another configuration, or for the first time.
		await tx
			.insert(osUpdateServers)
			.values(
				joined.serverIds.map((serverId) => ({
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
	}

	const currentNodes = new Set(
		(
			await tx
				.select({ nodeId: osUpdateRunnerNodes.githubRunnerNodeId })
				.from(osUpdateRunnerNodes)
				.where(eq(osUpdateRunnerNodes.osUpdateConfigurationId, configurationId))
		).map((row) => row.nodeId),
	);
	const leavingNodes = [...currentNodes].filter(
		(nodeId) => access.runnerNodeIds.has(nodeId) && !wantedNodes.has(nodeId),
	);
	if (leavingNodes.length) {
		await tx
			.update(osUpdateRunnerNodes)
			.set({ osUpdateConfigurationId: null, assignedAt: null })
			.where(inArray(osUpdateRunnerNodes.githubRunnerNodeId, leavingNodes));
	}
	joined.runnerNodeIds = [...wantedNodes].filter(
		(nodeId) => !currentNodes.has(nodeId),
	);
	if (joined.runnerNodeIds.length) {
		await tx
			.insert(osUpdateRunnerNodes)
			.values(
				joined.runnerNodeIds.map((githubRunnerNodeId) => ({
					githubRunnerNodeId,
					osUpdateConfigurationId: configurationId,
					assignedAt: now,
					periodicAssessment: true,
				})),
			)
			.onConflictDoUpdate({
				target: osUpdateRunnerNodes.githubRunnerNodeId,
				set: {
					osUpdateConfigurationId: configurationId,
					assignedAt: now,
					periodicAssessment: true,
				},
			});
	}
	return joined;
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
	if (input.runnerNodeIds.some((nodeId) => !access.runnerNodeIds.has(nodeId))) {
		throw forbiddenRunner();
	}
	// Machines in an enabled configuration install in its windows.
	if (
		input.enabled &&
		input.serverIds.length + input.runnerNodeIds.length > 0
	) {
		await access.requireRun();
	}
	// Runner machines it holds are drained in its windows.
	if (input.runnerNodeIds.length) await access.requireRunnerUpdate();
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
			await assignMachines(
				tx,
				row.osUpdateConfigurationId,
				{ serverIds: input.serverIds, runnerNodeIds: input.runnerNodeIds },
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
	const currentMachines = await machinesOf(current.osUpdateConfigurationId);
	const settingsChanged =
		installSettings(current) !== installSettings(input) ||
		current.enabled !== input.enabled;
	if (settingsChanged) assertWholeConfiguration(currentMachines, access);
	if (input.serverIds.some((serverId) => !access.serverIds.has(serverId))) {
		throw forbiddenServer();
	}
	if (input.runnerNodeIds.some((nodeId) => !access.runnerNodeIds.has(nodeId))) {
		throw forbiddenRunner();
	}
	const hiddenServers = currentMachines.serverIds.filter(
		(serverId) => !access.serverIds.has(serverId),
	);
	const hiddenNodes = currentMachines.runnerNodeIds.filter(
		(nodeId) => !access.runnerNodeIds.has(nodeId),
	);
	const assignedServers = new Set(currentMachines.serverIds);
	const assignedNodes = new Set(currentMachines.runnerNodeIds);
	const joining =
		input.serverIds.filter((serverId) => !assignedServers.has(serverId))
			.length +
		input.runnerNodeIds.filter((nodeId) => !assignedNodes.has(nodeId)).length;
	const machinesAfter =
		hiddenServers.length +
		hiddenNodes.length +
		input.serverIds.length +
		input.runnerNodeIds.length;
	// Machines that start installing, or install at other times or other updates.
	if (input.enabled && machinesAfter > 0 && (joining > 0 || settingsChanged)) {
		await access.requireRun();
	}
	// Runner machines joining or leaving it, or drained at other times.
	const wanted = new Set(input.runnerNodeIds);
	const runnersChanged =
		input.runnerNodeIds.some((nodeId) => !assignedNodes.has(nodeId)) ||
		currentMachines.runnerNodeIds.some(
			(nodeId) => access.runnerNodeIds.has(nodeId) && !wanted.has(nodeId),
		);
	if (
		runnersChanged ||
		(settingsChanged && hiddenNodes.length + input.runnerNodeIds.length > 0)
	) {
		await access.requireRunnerUpdate();
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
			await assignMachines(
				tx,
				row.osUpdateConfigurationId,
				{ serverIds: input.serverIds, runnerNodeIds: input.runnerNodeIds },
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
	const machines = await machinesOf(current.osUpdateConfigurationId);
	assertWholeConfiguration(machines, access);
	if (input.enabled && !current.enabled) {
		if (machines.serverIds.length + machines.runnerNodeIds.length > 0) {
			await access.requireRun();
		}
		if (machines.runnerNodeIds.length) await access.requireRunnerUpdate();
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
	assertWholeConfiguration(await machinesOf(osUpdateConfigurationId), access);
	// Its machines leave it (set null); its runs keep their history.
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

/**
 * The Linux runner machines the member may see, with what OS updates know of
 * them and where their drain stands.
 */
export const listOsUpdateRunnerNodes = async (access: OsUpdateAccess) => {
	const ids = [...access.runnerNodeIds];
	if (!ids.length) return [];
	const nodes = await db
		.select({
			githubRunnerNodeId: githubRunnerNodes.githubRunnerNodeId,
			name: githubRunnerNodes.name,
			host: githubRunnerNodes.host,
			phase: githubRunnerNodes.phase,
			enabled: githubRunnerNodes.enabled,
			platform: githubRunnerNodes.platform,
			drain: githubRunnerNodes.drain,
			observed: githubRunnerNodes.observed,
			poolName: githubRunnerPools.name,
		})
		.from(githubRunnerNodes)
		.innerJoin(
			githubRunnerPools,
			eq(
				githubRunnerPools.githubRunnerPoolId,
				githubRunnerNodes.githubRunnerPoolId,
			),
		)
		.where(
			and(
				eq(githubRunnerNodes.organizationId, access.organizationId),
				eq(githubRunnerNodes.platform, "linux"),
				inArray(githubRunnerNodes.githubRunnerNodeId, ids),
			),
		)
		.orderBy(githubRunnerPools.name, githubRunnerNodes.name);
	if (!nodes.length) return [];
	const listed = nodes.map((row) => row.githubRunnerNodeId);
	const [states, runs] = await Promise.all([
		db.query.osUpdateRunnerNodes.findMany({
			where: inArray(osUpdateRunnerNodes.githubRunnerNodeId, listed),
			with: { configuration: true },
		}),
		db
			.selectDistinctOn([osUpdateRuns.githubRunnerNodeId], {
				githubRunnerNodeId: osUpdateRuns.githubRunnerNodeId,
				osUpdateRunId: osUpdateRuns.osUpdateRunId,
				status: osUpdateRuns.status,
				trigger: osUpdateRuns.trigger,
				createdAt: osUpdateRuns.createdAt,
				startedAt: osUpdateRuns.startedAt,
				finishedAt: osUpdateRuns.finishedAt,
				message: osUpdateRuns.message,
			})
			.from(osUpdateRuns)
			.where(inArray(osUpdateRuns.githubRunnerNodeId, listed))
			.orderBy(osUpdateRuns.githubRunnerNodeId, desc(osUpdateRuns.createdAt)),
	]);
	const now = new Date();
	const stateOf = new Map(
		states.map((state) => [state.githubRunnerNodeId, state]),
	);
	const lastRunOf = new Map(runs.map((run) => [run.githubRunnerNodeId, run]));
	return nodes.map(({ drain, observed, ...row }) => {
		const state = stateOf.get(row.githubRunnerNodeId);
		const configuration = state?.configuration ?? null;
		return {
			...row,
			active: isManagedRunnerNode(row),
			/** Jobs running on it, as the runner controller last saw. */
			jobs: (observed?.slots ?? []).filter((slot) => slot.state === "busy")
				.length,
			/** Out of service for an OS update run: waiting for its jobs, or installing. */
			osUpdate: isOsUpdateDrain(drain)
				? {
						osUpdateRunId: drain.osUpdateRunId,
						installing: Boolean(drain.installingAt),
					}
				: null,
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
			lastRun: lastRunOf.get(row.githubRunnerNodeId) ?? null,
		};
	});
};

/** A machine's row, created on first use (not assessed periodically by default). */
const ensureMachineRow = (machine: OsUpdateMachine) =>
	machine.kind === "server"
		? db
				.insert(osUpdateServers)
				.values({ serverId: machine.id, periodicAssessment: false })
				.onConflictDoNothing()
		: db
				.insert(osUpdateRunnerNodes)
				.values({ githubRunnerNodeId: machine.id, periodicAssessment: false })
				.onConflictDoNothing();

const findMachineRow = (machine: OsUpdateMachine) =>
	machine.kind === "server"
		? db.query.osUpdateServers.findFirst({
				where: eq(osUpdateServers.serverId, machine.id),
			})
		: db.query.osUpdateRunnerNodes.findFirst({
				where: eq(osUpdateRunnerNodes.githubRunnerNodeId, machine.id),
			});

const updateMachineRow = (
	machine: OsUpdateMachine,
	values: {
		osUpdateConfigurationId?: string | null;
		assignedAt?: string | null;
		periodicAssessment?: boolean;
		assessmentRequestedAt?: string | null;
	},
) =>
	machine.kind === "server"
		? db
				.update(osUpdateServers)
				.set(values)
				.where(eq(osUpdateServers.serverId, machine.id))
		: db
				.update(osUpdateRunnerNodes)
				.set(values)
				.where(eq(osUpdateRunnerNodes.githubRunnerNodeId, machine.id));

/** Root apt on a runner machine: the member may also change runner machines. */
const requireMachineChange = async (
	machine: OsUpdateMachine,
	access: OsUpdateAccess,
) => {
	if (machine.kind === "runner") await access.requireRunnerUpdate();
};

export const assignOsUpdateConfiguration = async (
	input: OsUpdateMachineInput & { osUpdateConfigurationId: string | null },
	access: OsUpdateAccess,
) => {
	const target = await findMachine(machineOfInput(input), access);
	const configuration = input.osUpdateConfigurationId
		? await findOsUpdateConfiguration(
				input.osUpdateConfigurationId,
				access.organizationId,
			)
		: null;
	await ensureMachineRow(target.machine);
	const current = await findMachineRow(target.machine);
	if (current?.osUpdateConfigurationId !== input.osUpdateConfigurationId) {
		// It installs in the configuration's windows, and is assessed every day.
		if (configuration) await access.requireRun();
		await requireMachineChange(target.machine, access);
		await updateMachineRow(target.machine, {
			osUpdateConfigurationId: input.osUpdateConfigurationId,
			assignedAt: configuration ? new Date().toISOString() : null,
			...(configuration ? { periodicAssessment: true } : {}),
		});
	}
	requestOsUpdatesTick();
	return { machine: target, configuration };
};

export const setOsUpdatePeriodicAssessment = async (
	input: OsUpdateMachineInput & { periodicAssessment: boolean },
	access: OsUpdateAccess,
) => {
	const target = await findMachine(machineOfInput(input), access);
	// An assessment refreshes the package lists as root.
	if (input.periodicAssessment) {
		await access.requireRun();
		await requireMachineChange(target.machine, access);
	}
	await ensureMachineRow(target.machine);
	await updateMachineRow(target.machine, {
		periodicAssessment: input.periodicAssessment,
	});
	requestOsUpdatesTick();
	return target;
};

/** "Check now": the controller assesses the machine within seconds. */
export const requestOsUpdateAssessment = async (
	input: OsUpdateMachineInput,
	access: OsUpdateAccess,
) => {
	const target = await findMachine(machineOfInput(input), access);
	assertActive(target);
	await requireMachineChange(target.machine, access);
	await ensureMachineRow(target.machine);
	await updateMachineRow(target.machine, {
		assessmentRequestedAt: new Date().toISOString(),
	});
	requestOsUpdatesTick();
	return target;
};

/**
 * "Install now": a one-time run, queued for the controller. One per machine
 * at a time: a unique index refuses a second one, even at the same instant.
 * A runner machine is drained first, as in a window.
 */
export const installOsUpdatesNow = async (
	input: z.infer<typeof apiInstallOsUpdatesNow>,
	access: OsUpdateAccess,
	requestedBy: string,
) => {
	const target = await findMachine(machineOfInput(input), access);
	assertActive(target);
	await requireMachineChange(target.machine, access);
	const {
		serverId: _server,
		githubRunnerNodeId: _node,
		maxDurationMinutes,
		...rest
	} = input;
	const now = new Date();
	let run: typeof osUpdateRuns.$inferSelect | undefined;
	try {
		[run] = await db
			.insert(osUpdateRuns)
			.values({
				organizationId: access.organizationId,
				...(target.machine.kind === "server"
					? { serverId: target.id }
					: { githubRunnerNodeId: target.id }),
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
	await ensureMachineRow(target.machine);
	requestOsUpdatesTick();
	return { run, machine: target };
};

/**
 * Cancels a run that has not started installing: a pending one, or a run of
 * a runner machine still waiting for its jobs to end (the machine takes jobs
 * again). One that installs cannot stop halfway.
 */
export const cancelOsUpdateRun = async (
	osUpdateRunId: string,
	access: OsUpdateAccess,
) => {
	const found = await db.query.osUpdateRuns.findFirst({
		where: and(
			eq(osUpdateRuns.osUpdateRunId, osUpdateRunId),
			eq(osUpdateRuns.organizationId, access.organizationId),
		),
		columns: { serverId: true, githubRunnerNodeId: true },
	});
	if (!found) throw notFound("Run");
	const target = await findMachine(machineOf(found), access);
	const [run] = await db
		.update(osUpdateRuns)
		.set({
			status: "cancelled",
			finishedAt: new Date().toISOString(),
			message: sql`CASE WHEN ${osUpdateRuns.status} = 'running' THEN 'Cancelled while the jobs of the machine ended: nothing was installed, and it takes jobs again.' ELSE 'Cancelled before it started.' END`,
			lockedBy: null,
			lockedUntil: null,
		})
		.where(
			and(
				eq(osUpdateRuns.osUpdateRunId, osUpdateRunId),
				or(
					eq(osUpdateRuns.status, "pending"),
					and(
						eq(osUpdateRuns.status, "running"),
						isNotNull(osUpdateRuns.githubRunnerNodeId),
						sql`coalesce(${osUpdateRuns.progress}->>'step', 'drain') = 'drain'`,
					),
				),
			),
		)
		.returning();
	if (!run) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Only a run that has not started installing can be cancelled",
		});
	}
	// The run waiting in this process gives the machine back at once.
	wakeOsUpdateDrains();
	return { run, machine: target };
};

/** The history of the machines the member may access, newest first, without the logs. */
export const listOsUpdateRuns = async (
	input: OsUpdateMachineInput & { limit: number },
	access: OsUpdateAccess,
) => {
	const filtered = Boolean(input.serverId || input.githubRunnerNodeId);
	const serverIds = [...access.serverIds].filter(
		(serverId) => !filtered || serverId === input.serverId,
	);
	const nodeIds = [...access.runnerNodeIds].filter(
		(nodeId) => !filtered || nodeId === input.githubRunnerNodeId,
	);
	if (!serverIds.length && !nodeIds.length) return [];
	const { log: _log, ...columns } = getTableColumns(osUpdateRuns);
	const rows = await db
		.select({
			...columns,
			serverName: server.name,
			runnerNodeName: githubRunnerNodes.name,
			configurationName: osUpdateConfigurations.name,
		})
		.from(osUpdateRuns)
		.leftJoin(server, eq(server.serverId, osUpdateRuns.serverId))
		.leftJoin(
			githubRunnerNodes,
			eq(githubRunnerNodes.githubRunnerNodeId, osUpdateRuns.githubRunnerNodeId),
		)
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
				or(
					serverIds.length
						? inArray(osUpdateRuns.serverId, serverIds)
						: sql`false`,
					nodeIds.length
						? inArray(osUpdateRuns.githubRunnerNodeId, nodeIds)
						: sql`false`,
				),
			),
		)
		.orderBy(desc(osUpdateRuns.createdAt))
		.limit(input.limit);
	return rows.map(({ serverName, runnerNodeName, ...row }) => ({
		...row,
		/** The server's, or the runner machine's. */
		machineName: serverName ?? runnerNodeName,
	}));
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
			runnerNode: { columns: { name: true } },
			configuration: { columns: { name: true, schedule: true } },
		},
	});
	// Another member's machine: as if it did not exist.
	const machine = run ? machineOf(run) : null;
	if (
		!run ||
		!machine ||
		!(machine.kind === "server"
			? access.serverIds.has(machine.id)
			: access.runnerNodeIds.has(machine.id))
	) {
		throw notFound("Run");
	}
	const { server: serverRow, runnerNode, ...rest } = run;
	return {
		...rest,
		machineName: serverRow?.name ?? runnerNode?.name ?? null,
		configuration: run.configuration,
	};
};
