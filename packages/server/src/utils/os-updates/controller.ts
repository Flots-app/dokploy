/**
 * Runs the OS updates of the remote servers, in the Dokploy process that
 * leads (a lease in the database, as the GitHub runner controller does):
 * - every open maintenance window gets one run per assigned server (a unique
 *   index makes it one whatever the restarts), and the runs of a
 *   configuration go one server at a time;
 * - a window that passed without its runs (no Dokploy running) is recorded as
 *   missed and notified: nothing installs outside a window, the next window
 *   or "Install now" catches up;
 * - a run that a stopped process left is resumed by the next leader from its
 *   last step (the steps run detached on the server, see scripts.ts);
 * - servers are assessed every 24 hours, and on demand.
 *
 * Linux GitHub runner machines are handled as servers, with one more step
 * first: the run drains the machine (no new job, the running ones end, never
 * interrupted) through the runner controller, installs once it is empty,
 * then gives it back whatever the outcome (see runner-drain.ts). It reaches
 * them with the host key pinned at their enrollment, as the runner
 * controller does.
 *
 * The Dokploy server itself is not managed: rebooting it, or restarting its
 * Docker, would stop the process that drives the run.
 */

import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { db } from "@dokploy/server/db";
import {
	githubRunnerNodes,
	type MacosVersion,
	type OsUpdateConfiguration,
	type OsUpdateRun,
	type OsUpdateRunnerNode,
	type OsUpdateRunPackage,
	type OsUpdateRunProgress,
	type OsUpdateServer,
	osUpdateConfigurations,
	osUpdateLocks,
	osUpdateRunnerNodes,
	osUpdateRuns,
	osUpdateServers,
} from "@dokploy/server/db/schema";
import { and, asc, eq, inArray, isNotNull, lt, ne, sql } from "drizzle-orm";
import { loggableError } from "../github-runners/errors";
import {
	inGuest,
	macStartVmScript,
	macStopVmScript,
} from "../github-runners/macos";
import {
	closeSharedSessions,
	type NodeSession,
	openNodeSession,
} from "../github-runners/ssh";
import {
	listNames,
	type OsUpdateNotice,
	sendOsUpdateNotifications,
} from "../notifications/os-updates";
import { sequentially } from "../service-migration/concurrency";
import {
	isDockerPackage,
	type OsUpdateSettings,
	SKIP_REASONS,
	type SkipReason,
	selectPackages,
} from "./filters";
import {
	isOsUpdateDrain,
	markOsUpdateInstalling,
	releaseOsUpdateDrain,
	sleepUntilDrainNews,
	startOsUpdateDrain,
} from "./runner-drain";
import { openWindow, previousWindow } from "./schedule";
import {
	assessScript,
	BOOT_ID_COMMAND,
	cleanupRunScript,
	dockerStatusScript,
	followStepScript,
	type InstallResult,
	installStep,
	LOG_CHUNK_BYTES,
	parseAssessment,
	parseFollow,
	parseInstallResult,
	parseSwarm,
	parseSwarmManagers,
	prepareStep,
	RESTART_DOCKER_COMMAND,
	type RunStep,
	rebootScript,
	rootShell,
	type ServerAssessment,
	SWARM_MANAGERS_COMMAND,
	startStepScript,
	stepExitCode,
	swarmRebootCheck,
	unsupportedMessage,
} from "./scripts";

const TICK_MS = 15_000;
const HEARTBEAT_MS = 10_000;
/** The leadership expires this long after the leader's last heartbeat. */
const LEADER_TTL_S = 45;
/** A run's lease: renewed while its process runs it, taken over after. */
const RUN_LEASE_S = 90;
const RUN_RENEW_MS = 30_000;
/** No install starts in the last 15 minutes of a window. */
export const INSTALL_RESERVE_MS = 15 * 60_000;
/** A run interrupted this many times fails instead of resuming again. */
const MAX_ATTEMPTS = 3;
export const ASSESS_EVERY_MS = 24 * 60 * 60_000;
const ASSESS_RETRY_MS = 60 * 60_000;
const MAX_ASSESSMENTS = 3;
/** Only a window that ended within this delay is reported missed. */
const MISSED_LOOKBACK_MS = 7 * 24 * 60 * 60_000;
const STEP_TIMEOUT_MS: Record<RunStep, number> = {
	// Lock waits (10 min), dpkg recovery, list refresh retries (5 min).
	prepare: 30 * 60_000,
	install: 2 * 60 * 60_000,
};
const FOLLOW_EVERY_MS = 5_000;
/** The server may not answer while this lasts (network, sshd restart). */
const UNREACHABLE_GIVE_UP_MS = 5 * 60_000;
const REBOOT_TIMEOUT_MS = 15 * 60_000;
const READY_TIMEOUT_MS = 10 * 60_000;
const SWARM_LOCK_TTL_S = 120;
const HISTORY_RETENTION_MS = 180 * 24 * 60 * 60_000;
const MAX_RUN_LOG = 256_000;
/** A run waiting for its runner machine to empty looks again this often. */
const DRAIN_POLL_MS = 5_000;
/** A hand-off asks the Mac for its macOS version this often. */
const HANDOFF_POLL_MS = 60_000;

interface ControllerState {
	owner: string;
	leader: boolean;
	heartbeat: NodeJS.Timeout | null;
	timer: NodeJS.Timeout | null;
	ticking: boolean;
	/** Runs this process executes. */
	executing: Map<string, Promise<void>>;
	/** Machines this process assesses (keyOf). */
	assessing: Set<string>;
	lastPurge: number;
}

const shared = globalThis as { __dokployOsUpdates?: ControllerState };
shared.__dokployOsUpdates ??= {
	owner: `${hostname()}:${process.pid}:${randomBytes(3).toString("hex")}`,
	leader: false,
	heartbeat: null,
	timer: null,
	ticking: false,
	executing: new Map(),
	assessing: new Set(),
	lastPurge: 0,
};
const state: ControllerState = shared.__dokployOsUpdates;
const OWNER = state.owner;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const timestamp = () => new Date().toISOString().slice(11, 19);
const messageOf = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

// ------------------------------------------------------------- locks

/** Takes or renews a lease, in the database's clock. */
const takeLock = async (key: string, ttlSeconds: number) => {
	const until = sql`now() + make_interval(secs => ${ttlSeconds})`;
	const rows = await db
		.insert(osUpdateLocks)
		.values({ key, owner: OWNER, until })
		.onConflictDoUpdate({
			target: osUpdateLocks.key,
			set: { owner: OWNER, until },
			setWhere: sql`${osUpdateLocks.owner} = ${OWNER} OR ${osUpdateLocks.until} < now()`,
		})
		.returning({ owner: osUpdateLocks.owner });
	return rows.length > 0;
};

const releaseLock = (key: string) =>
	db
		.delete(osUpdateLocks)
		.where(and(eq(osUpdateLocks.key, key), eq(osUpdateLocks.owner, OWNER)));

// ------------------------------------------------------------- run log

/** A user and password in a URL never reach the log. */
export const redactLogLine = (line: string) =>
	line
		.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1***:***@")
		.replace(
			/([?&](?:token|key|password|secret|signature)=)[^&\s]+/gi,
			"$1***",
		);

/** Lines as the log keeps them: progress bars reduced to their last state. */
export const logLines = (text: string) =>
	text
		.split("\n")
		.map((line) => (line.split("\r").at(-1) ?? "").trimEnd())
		.filter((line) => line.trim())
		.map(redactLogLine);

const appendRunLog = async (runId: string, text: string) => {
	const lines = logLines(text);
	if (!lines.length) return;
	const chunk = lines.map((line) => `[${timestamp()}] ${line}\n`).join("");
	await db
		.update(osUpdateRuns)
		// Only the end is kept: an install log cannot grow without bound.
		.set({ log: sql`right(${osUpdateRuns.log} || ${chunk}, ${MAX_RUN_LOG})` })
		.where(eq(osUpdateRuns.osUpdateRunId, runId));
};

// ------------------------------------------------------------- machines

/** What a run is for: a remote server, or a Linux GitHub runner machine. */
export type OsUpdateMachine =
	| { kind: "server"; id: string }
	| { kind: "runner"; id: string };

/** The machine of a run (one of its two ids is set, a constraint says so). */
export const machineOf = (row: {
	serverId: string | null;
	githubRunnerNodeId: string | null;
}): OsUpdateMachine =>
	row.serverId !== null
		? { kind: "server", id: row.serverId }
		: { kind: "runner", id: row.githubRunnerNodeId ?? "" };

/** A key for sets of machines: a server and a runner machine never collide. */
export const keyOf = (machine: OsUpdateMachine) =>
	`${machine.kind}:${machine.id}`;

/** The columns of a run (or a row) that name the machine. */
const machineColumns = (machine: OsUpdateMachine) =>
	machine.kind === "server"
		? { serverId: machine.id }
		: { githubRunnerNodeId: machine.id };

/**
 * A runner machine OS updates may work on: a Linux machine set up (ready,
 * draining for another reason, or stopped by an operator), or the VM of a
 * Mac while it runs (ready, or draining for another reason). OS updates
 * install in the Linux of the VM; macOS itself is handed to its owner.
 */
export const isManagedRunnerNode = (
	node: { platform: string; phase: string } | null | undefined,
) =>
	(node?.platform === "linux" &&
		["ready", "draining", "stopped"].includes(node.phase)) ||
	(node?.platform === "macos" && ["ready", "draining"].includes(node.phase));

type ServerRow = NonNullable<Awaited<ReturnType<typeof loadServer>>>;

const loadServer = (serverId: string) =>
	db.query.server.findFirst({
		where: (table, { eq }) => eq(table.serverId, serverId),
		with: { sshKey: true },
	});

const loadRunnerNode = (nodeId: string) =>
	db.query.githubRunnerNodes.findFirst({
		where: eq(githubRunnerNodes.githubRunnerNodeId, nodeId),
		with: { sshKey: true },
	});

/** How Dokploy reaches a machine over SSH. */
interface SshTarget {
	machine: OsUpdateMachine;
	name: string;
	host: string;
	port: number;
	username: string;
	privateKey: string | null;
	/**
	 * Runner machines: pinned at their enrollment, and required. Servers:
	 * none, as every other SSH command of Dokploy on its servers.
	 */
	hostKeyFingerprint: string | null;
	/**
	 * A Mac: its Lima VM, where the runners (and the Linux OS updates
	 * install in) live. Root commands run in it through `limactl shell`, as
	 * the runner controller's guest commands: no sudo on macOS.
	 */
	vmName: string | null;
}

const serverTarget = (server: ServerRow): SshTarget => ({
	machine: { kind: "server", id: server.serverId },
	name: server.name,
	host: server.ipAddress,
	port: server.port,
	username: server.username,
	privateKey: server.sshKey?.privateKey ?? null,
	hostKeyFingerprint: null,
	vmName: null,
});

const loadTarget = async (
	machine: OsUpdateMachine,
): Promise<SshTarget | null> => {
	if (machine.kind === "server") {
		const server = await loadServer(machine.id);
		return server ? serverTarget(server) : null;
	}
	const node = await loadRunnerNode(machine.id);
	if (!node) return null;
	return {
		machine,
		name: node.name,
		host: node.host,
		port: node.port,
		username: node.username,
		// Its own key (enrolled machines) first, as the runner controller.
		privateKey: node.sshPrivateKey ?? node.sshKey?.privateKey ?? null,
		hostKeyFingerprint: node.hostKeyFingerprint,
		vmName: node.platform === "macos" ? node.vmName : null,
	};
};

// ------------------------------------------------------------- SSH

/** What Dokploy lacks to reach a machine: waiting changes nothing. */
class SetupError extends Error {}

/**
 * One SSH connection to a machine, opened again after a failure: the machine
 * may drop it (network, sshd restarted by an update, reboot). `say` tells a
 * run's log when the machine stops answering, and when it answers again.
 */
const connection = (
	target: SshTarget,
	say?: (line: string) => Promise<void>,
) => {
	let session: NodeSession | null = null;
	const open = async () => {
		if (!target.privateKey) {
			throw new SetupError(`${target.name} has no SSH key in Dokploy`);
		}
		if (target.machine.kind === "runner" && !target.hostKeyFingerprint) {
			// Root over SSH to a runner machine: only the machine it enrolled.
			throw new SetupError(
				`${target.name} has no pinned host key: Dokploy pins it when it first reaches the machine (GitHub Runners), and runs OS updates on a runner machine only with it`,
			);
		}
		session ??= await openNodeSession({
			name: target.name,
			host: target.host,
			port: target.port,
			username: target.username,
			privateKey: target.privateKey,
			hostKeyFingerprint: target.hostKeyFingerprint,
		});
		return session;
	};
	const reset = () => {
		session?.close();
		session = null;
	};
	/** Runs a script as root: on the machine, or in the VM of a Mac. */
	const root = async (
		script: string,
		options: { label: string; timeoutMs: number; allowFailure?: boolean },
	) => {
		const current = await open();
		try {
			return await current.run(
				target.vmName
					? inGuest(target.vmName, "bash -s")
					: rootShell(target.username),
				{
					input: script.endsWith("\n") ? script : `${script}\n`,
					...options,
				},
			);
		} catch (error) {
			reset();
			throw error;
		}
	};
	/** Runs a command on the machine itself as its SSH user (the Mac's account). */
	const host = async (
		command: string,
		options: { label: string; timeoutMs: number },
	) => {
		const current = await open();
		try {
			return await current.run(command, options);
		} catch (error) {
			reset();
			throw error;
		}
	};
	/** As root, retried while the machine does not answer, up to `giveUpMs`. */
	const patient = async (
		script: string,
		options: { label: string; timeoutMs: number },
		giveUpMs = UNREACHABLE_GIVE_UP_MS,
	) => {
		const giveUp = Date.now() + giveUpMs;
		let told = false;
		const tell = (line: string) => say?.(line).catch(() => undefined);
		for (;;) {
			try {
				const result = await root(script, options);
				if (told) await tell(`${target.name} answers again`);
				return result;
			} catch (error) {
				if (Date.now() >= giveUp || error instanceof SetupError) throw error;
				// Once per outage: the run would otherwise look stuck.
				if (!told) {
					told = true;
					await tell(
						`${error instanceof Error ? error.message : String(error)}: trying again every 10 seconds until ${new Date(giveUp).toISOString().slice(11, 16)} UTC`,
					);
				}
				await sleep(10_000);
			}
		}
	};
	return { root, host, patient, reset };
};

type Connection = ReturnType<typeof connection>;

// ------------------------------------------------------------- assessment

/** What OS updates keep for a machine, whichever table holds it. */
type MachineState = Partial<
	Omit<OsUpdateServer, "serverId" | "osUpdateConfigurationId">
>;

const updateMachineState = (machine: OsUpdateMachine, values: MachineState) =>
	machine.kind === "server"
		? db
				.update(osUpdateServers)
				.set(values)
				.where(eq(osUpdateServers.serverId, machine.id))
		: db
				.update(osUpdateRunnerNodes)
				.set(values)
				.where(eq(osUpdateRunnerNodes.githubRunnerNodeId, machine.id));

const findMachineState = (
	machine: OsUpdateMachine,
): Promise<OsUpdateServer | OsUpdateRunnerNode | undefined> =>
	machine.kind === "server"
		? db.query.osUpdateServers.findFirst({
				where: eq(osUpdateServers.serverId, machine.id),
			})
		: db.query.osUpdateRunnerNodes.findFirst({
				where: eq(osUpdateRunnerNodes.githubRunnerNodeId, machine.id),
			});

const saveAssessment = (
	machine: OsUpdateMachine,
	assessment: ServerAssessment,
) =>
	updateMachineState(machine, {
		assessment,
		assessedAt: new Date().toISOString(),
		assessmentError: null,
	});

/** A machine held by another OS update script is asked again after this. */
const BUSY_RETRY_MS = 60_000;
export const BUSY_MESSAGE =
	"Another Dokploy OS update script runs on the server: checked again in a minute";

/** Assesses a machine now (refreshing its package lists). */
export const assessMachine = async (machine: OsUpdateMachine) => {
	const key = keyOf(machine);
	if (state.assessing.has(key)) return;
	state.assessing.add(key);
	const at = new Date().toISOString();
	try {
		const before = await findMachineState(machine);
		await updateMachineState(machine, {
			assessmentTriedAt: at,
			assessmentRequestedAt: null,
		});
		const target = await loadTarget(machine);
		if (!target) return;
		const ssh = connection(target);
		try {
			const { stdout } = await ssh.root(assessScript({ refresh: true }), {
				label: "Assessment",
				timeoutMs: 6 * 60_000,
			});
			if (stdout.trim() === "busy") {
				// Said, and a Check now stays asked: the next try comes in a minute.
				await updateMachineState(machine, {
					assessmentError: BUSY_MESSAGE,
					assessmentRequestedAt: before?.assessmentRequestedAt ?? null,
				});
				return;
			}
			const assessment = parseAssessment(stdout);
			if (!assessment) throw new Error("the server sent no readable report");
			await saveAssessment(machine, assessment);
		} finally {
			ssh.reset();
		}
	} catch (error) {
		await updateMachineState(machine, { assessmentError: messageOf(error) })
			.then(() => undefined)
			.catch(() => undefined);
	} finally {
		state.assessing.delete(key);
	}
};

/** Assesses a server now (refreshing its package lists). */
export const assessServer = (serverId: string) =>
	assessMachine({ kind: "server", id: serverId });

/** Due assessments: requested, or periodic ones older than 24 hours. */
const assessDueMachines = async (now: Date, busy: Set<string>) => {
	const day = new Date(now.getTime() - ASSESS_EVERY_MS).toISOString();
	const retry = new Date(now.getTime() - ASSESS_RETRY_MS).toISOString();
	const busyRetry = new Date(now.getTime() - BUSY_RETRY_MS).toISOString();
	const [servers, runnerNodes] = await Promise.all([
		db.query.osUpdateServers.findMany({
			with: { server: { columns: { serverStatus: true } } },
		}),
		db.query.osUpdateRunnerNodes.findMany({
			with: { node: { columns: { platform: true, phase: true } } },
		}),
	]);
	const rows = [
		...servers.map((row) => ({
			...row,
			machine: { kind: "server", id: row.serverId } as OsUpdateMachine,
			active: row.server?.serverStatus === "active",
		})),
		...runnerNodes.map((row) => ({
			...row,
			machine: {
				kind: "runner",
				id: row.githubRunnerNodeId,
			} as OsUpdateMachine,
			active: isManagedRunnerNode(row.node),
		})),
	];
	const due = rows.filter(
		(row) =>
			row.active &&
			!busy.has(keyOf(row.machine)) &&
			!state.assessing.has(keyOf(row.machine)) &&
			((row.assessmentRequestedAt !== null &&
				// Asked after the last try, or a minute after a busy server.
				(!row.assessmentTriedAt ||
					row.assessmentTriedAt < row.assessmentRequestedAt ||
					row.assessmentTriedAt < busyRetry)) ||
				(row.periodicAssessment &&
					(!row.assessedAt || row.assessedAt < day) &&
					(!row.assessmentTriedAt || row.assessmentTriedAt < retry))),
	);
	const room = MAX_ASSESSMENTS - state.assessing.size;
	for (const row of due.slice(0, Math.max(0, room))) {
		void assessMachine(row.machine);
	}
};

// ------------------------------------------------------------- notifications

const notify = (organizationId: string, notice: OsUpdateNotice) => {
	void sendOsUpdateNotifications(organizationId, notice).catch((error) =>
		console.error(
			`OS updates notification failed for ${notice.server}`,
			loggableError(error),
		),
	);
};

// ------------------------------------------------------------- windows

export const settingsOf = (
	configuration: Pick<
		OsUpdateConfiguration,
		| "classification"
		| "includePackages"
		| "excludePackages"
		| "reboot"
		| "allowDockerUpdates"
	>,
): OsUpdateSettings => ({
	classification: configuration.classification,
	includePackages: configuration.includePackages,
	excludePackages: configuration.excludePackages,
	reboot: configuration.reboot,
	allowDockerUpdates: configuration.allowDockerUpdates,
});

/**
 * Gives every assigned machine a run for the open window, and records the
 * last window as missed for the machines that had none.
 */
export const planOsUpdateWindows = async (now: Date) => {
	const configurations = await db.query.osUpdateConfigurations.findMany({
		where: eq(osUpdateConfigurations.enabled, true),
		with: {
			servers: { with: { server: { columns: { name: true } } } },
			runnerNodes: { with: { node: { columns: { name: true } } } },
		},
	});
	await sequentially(configurations, (configuration) =>
		planConfiguration(configuration, now),
	);
};

const planConfiguration = async (
	configuration: OsUpdateConfiguration & {
		servers: (OsUpdateServer & { server: { name: string } | null })[];
		runnerNodes: (OsUpdateRunnerNode & { node: { name: string } | null })[];
	},
	now: Date,
) => {
	const assigned = [
		...configuration.servers.map((row) => ({
			machine: { kind: "server", id: row.serverId } as OsUpdateMachine,
			assignedAt: row.assignedAt,
			name: row.server?.name ?? row.serverId,
		})),
		...configuration.runnerNodes.map((row) => ({
			machine: {
				kind: "runner",
				id: row.githubRunnerNodeId,
			} as OsUpdateMachine,
			assignedAt: row.assignedAt,
			name: row.node?.name ?? row.githubRunnerNodeId,
		})),
	].filter((row) => row.assignedAt);
	if (!assigned.length) return;
	const open = openWindow(configuration.schedule, now);
	if (open) {
		await db
			.insert(osUpdateRuns)
			.values(
				assigned.map((row) => ({
					organizationId: configuration.organizationId,
					...machineColumns(row.machine),
					osUpdateConfigurationId: configuration.osUpdateConfigurationId,
					trigger: "schedule" as const,
					windowStart: open.start.toISOString(),
					deadline: open.end.toISOString(),
					settings: settingsOf(configuration),
				})),
			)
			.onConflictDoNothing();
	}
	const previous = previousWindow(configuration.schedule, now);
	if (
		!previous ||
		now.getTime() - previous.end.getTime() > MISSED_LOOKBACK_MS
	) {
		return;
	}
	const start = previous.start.toISOString();
	// A window before the assignment or the last change never existed.
	const concerned = assigned.filter(
		(row) =>
			start >= (row.assignedAt ?? "") && start >= configuration.updatedAt,
	);
	if (!concerned.length) return;
	const missed = await db
		.insert(osUpdateRuns)
		.values(
			concerned.map((row) => ({
				organizationId: configuration.organizationId,
				...machineColumns(row.machine),
				osUpdateConfigurationId: configuration.osUpdateConfigurationId,
				trigger: "schedule" as const,
				status: "missed" as const,
				windowStart: start,
				deadline: previous.end.toISOString(),
				settings: settingsOf(configuration),
				finishedAt: now.toISOString(),
				message:
					"No Dokploy ran during this maintenance window: nothing was installed. The next window installs the updates, or use Install now.",
			})),
		)
		.onConflictDoNothing()
		.returning({
			serverId: osUpdateRuns.serverId,
			githubRunnerNodeId: osUpdateRuns.githubRunnerNodeId,
		});
	if (!missed.length) return;
	const recorded = new Set(missed.map((item) => keyOf(machineOf(item))));
	// A configuration may hold many servers: the notice names a few.
	const names = listNames(
		concerned
			.filter((row) => recorded.has(keyOf(row.machine)))
			.map((row) => row.name),
	);
	notify(configuration.organizationId, {
		event: "missed",
		title: `Maintenance window missed: ${configuration.name}`,
		message: `No Dokploy ran during the window of ${previous.start.toISOString().slice(0, 16).replace("T", " ")} UTC, so ${names} did not install their OS updates. They install them in the next window, or use Install now.`,
		server: names,
		configuration: configuration.name,
		at: now,
	});
};

/** Pending runs that can no longer start: their window closed. */
export const skipClosedOsUpdateRuns = async (now: Date) => {
	const limit = new Date(now.getTime() + INSTALL_RESERVE_MS).toISOString();
	await db
		.update(osUpdateRuns)
		.set({
			status: "skipped",
			finishedAt: now.toISOString(),
			message:
				"The maintenance window closed (or had less than 15 minutes left) before this server's turn: nothing was installed.",
		})
		.where(
			and(
				eq(osUpdateRuns.status, "pending"),
				ne(osUpdateRuns.kind, "handoff"),
				lt(osUpdateRuns.deadline, limit),
			),
		);
	// A hand-off installs nothing: it waits for its machine until its end.
	await db
		.update(osUpdateRuns)
		.set({
			status: "skipped",
			finishedAt: now.toISOString(),
			message:
				"The hand-off expired before the machine was free (another run held it).",
		})
		.where(
			and(
				eq(osUpdateRuns.status, "pending"),
				eq(osUpdateRuns.kind, "handoff"),
				lt(osUpdateRuns.deadline, now.toISOString()),
			),
		);
};

// ------------------------------------------------------------- runs

export const isUniqueViolation = (error: unknown) =>
	(error as { cause?: { code?: string } }).cause?.code === "23505" ||
	(error as { code?: string }).code === "23505";

export const claimRun = async (
	run: Pick<OsUpdateRun, "osUpdateRunId" | "startedAt">,
	settings: OsUpdateSettings,
) => {
	try {
		const rows = await db
			.update(osUpdateRuns)
			.set({
				status: "running",
				startedAt: run.startedAt ?? new Date().toISOString(),
				attempts: sql`${osUpdateRuns.attempts} + 1`,
				lockedBy: OWNER,
				lockedUntil: sql`now() + make_interval(secs => ${RUN_LEASE_S})`,
				settings,
			})
			.where(
				and(
					eq(osUpdateRuns.osUpdateRunId, run.osUpdateRunId),
					eq(osUpdateRuns.status, "pending"),
				),
			)
			.returning({ id: osUpdateRuns.osUpdateRunId });
		return rows.length > 0;
	} catch (error) {
		// Another run took the server or the configuration meanwhile.
		if (isUniqueViolation(error)) return false;
		// Anything else stops the tick, which logs it (loggableError).
		throw error;
	}
};

/** Starts the pending runs whose machine and configuration are free. */
const startPendingRuns = async (busy: Set<string>) => {
	const [pending, running] = await Promise.all([
		db.query.osUpdateRuns.findMany({
			where: eq(osUpdateRuns.status, "pending"),
			with: {
				server: { columns: { name: true, serverStatus: true } },
				runnerNode: {
					columns: { name: true, platform: true, phase: true, observed: true },
				},
				configuration: true,
			},
			orderBy: [asc(osUpdateRuns.createdAt)],
		}),
		db
			.select({
				serverId: osUpdateRuns.serverId,
				githubRunnerNodeId: osUpdateRuns.githubRunnerNodeId,
				configurationId: osUpdateRuns.osUpdateConfigurationId,
				trigger: osUpdateRuns.trigger,
			})
			.from(osUpdateRuns)
			.where(eq(osUpdateRuns.status, "running")),
	]);
	const busyConfigurations = new Set(
		running
			.filter((run) => run.trigger === "schedule" && run.configurationId)
			.map((run) => run.configurationId),
	);
	for (const run of running) busy.add(keyOf(machineOf(run)));
	if (!pending.length) return;
	const serverIds = pending.flatMap((run) =>
		run.serverId ? [run.serverId] : [],
	);
	const nodeIds = pending.flatMap((run) =>
		run.githubRunnerNodeId ? [run.githubRunnerNodeId] : [],
	);
	const [serverStates, nodeStates] = await Promise.all([
		serverIds.length
			? db.query.osUpdateServers.findMany({
					where: inArray(osUpdateServers.serverId, serverIds),
					columns: {
						serverId: true,
						assessment: true,
						osUpdateConfigurationId: true,
					},
				})
			: [],
		nodeIds.length
			? db.query.osUpdateRunnerNodes.findMany({
					where: inArray(osUpdateRunnerNodes.githubRunnerNodeId, nodeIds),
					columns: {
						githubRunnerNodeId: true,
						assessment: true,
						osUpdateConfigurationId: true,
					},
				})
			: [],
	]);
	const states = new Map<
		string,
		{
			assessment: ServerAssessment | null;
			osUpdateConfigurationId: string | null;
		}
	>([
		...serverStates.map(
			(row) => [keyOf({ kind: "server", id: row.serverId }), row] as const,
		),
		...nodeStates.map(
			(row) =>
				[keyOf({ kind: "runner", id: row.githubRunnerNodeId }), row] as const,
		),
	]);
	// Swarm managers last, then by name: the other nodes go first. Runner
	// machines running fewer jobs go first: they empty sooner.
	const order = (run: (typeof pending)[number]) => {
		const machine = machineOf(run);
		if (machine.kind === "runner") {
			const jobs = (run.runnerNode?.observed?.slots ?? []).filter(
				(slot) => slot.state === "busy",
			).length;
			return `0:${String(jobs).padStart(2, "0")}:${run.runnerNode?.name ?? ""}`;
		}
		return `${states.get(keyOf(machine))?.assessment?.swarm?.manager ? 1 : 0}:${run.server?.name ?? ""}`;
	};
	// What a user asked for (Install now, a hand-off) before the windows.
	const asked = (run: (typeof pending)[number]) =>
		run.trigger === "schedule" ? 1 : 0;
	pending.sort(
		(a, b) => asked(a) - asked(b) || order(a).localeCompare(order(b)),
	);
	// One after the other: each claim changes what the next one may take.
	await sequentially(pending, async (run) => {
		const machine = machineOf(run);
		const key = keyOf(machine);
		if (busy.has(key) || state.assessing.has(key)) return;
		if (
			run.trigger === "schedule" &&
			busyConfigurations.has(run.osUpdateConfigurationId)
		) {
			return;
		}
		const unavailable =
			machine.kind === "server"
				? run.server?.serverStatus !== "active"
					? "The server is inactive in Dokploy: nothing was installed."
					: null
				: !isManagedRunnerNode(run.runnerNode)
					? "The runner machine is not set up, or in error: nothing was installed."
					: null;
		const skip =
			unavailable ??
			(run.trigger === "schedule" && !run.configuration?.enabled
				? `The configuration was disabled or deleted before this ${machine.kind === "server" ? "server" : "machine"}'s turn: nothing was installed.`
				: run.trigger === "schedule" &&
						states.get(key)?.osUpdateConfigurationId !==
							run.osUpdateConfigurationId
					? `The ${machine.kind === "server" ? "server" : "machine"} left the configuration before its turn: nothing was installed.`
					: null);
		if (skip) {
			await db
				.update(osUpdateRuns)
				.set({
					status: "skipped",
					finishedAt: new Date().toISOString(),
					message: skip,
				})
				.where(
					and(
						eq(osUpdateRuns.osUpdateRunId, run.osUpdateRunId),
						eq(osUpdateRuns.status, "pending"),
					),
				);
			return;
		}
		// A scheduled run follows its configuration as it is at its turn.
		const settings =
			run.trigger === "schedule" && run.configuration
				? settingsOf(run.configuration)
				: run.settings;
		if (!(await claimRun(run, settings))) return;
		busy.add(key);
		if (run.trigger === "schedule") {
			busyConfigurations.add(run.osUpdateConfigurationId);
		}
		launch(run.osUpdateRunId);
	});
};

/**
 * Runs whose process stopped (their lease expired): this process resumes
 * them, from their last step.
 */
const resumeOrphanedRuns = async (busy: Set<string>) => {
	const rows = await db
		.update(osUpdateRuns)
		.set({
			lockedBy: OWNER,
			lockedUntil: sql`now() + make_interval(secs => ${RUN_LEASE_S})`,
			attempts: sql`${osUpdateRuns.attempts} + 1`,
		})
		.where(
			and(
				eq(osUpdateRuns.status, "running"),
				sql`(${osUpdateRuns.lockedUntil} IS NULL OR ${osUpdateRuns.lockedUntil} < now())`,
			),
		)
		.returning({
			id: osUpdateRuns.osUpdateRunId,
			serverId: osUpdateRuns.serverId,
			githubRunnerNodeId: osUpdateRuns.githubRunnerNodeId,
			organizationId: osUpdateRuns.organizationId,
			configurationId: osUpdateRuns.osUpdateConfigurationId,
			attempts: osUpdateRuns.attempts,
		});
	for (const row of rows) busy.add(keyOf(machineOf(row)));
	await Promise.all(
		rows.map(async (row) => {
			const machine = machineOf(row);
			if (row.attempts > MAX_ATTEMPTS) {
				const message = `Dokploy stopped during this run ${MAX_ATTEMPTS} times: given up. Check the ${machine.kind === "server" ? "server" : "machine"}, then use Install now.`;
				await finishRun(row.id, { status: "failed", message });
				if (machine.kind === "runner") {
					await releaseOsUpdateDrain(machine.id, row.id);
				}
				const names = await namesOf(machine, row.configurationId);
				notify(row.organizationId, {
					event: "failed",
					title: `OS updates failed on ${names.server}`,
					message,
					server: names.server,
					configuration: names.configuration,
					at: new Date(),
				});
				return;
			}
			await appendRunLog(
				row.id,
				"Dokploy stopped while it ran this update: resuming from its last step",
			);
			launch(row.id);
		}),
	);
};

/** The names a notice shows: the machine's, and its configuration's. */
const namesOf = async (
	machine: OsUpdateMachine,
	configurationId: string | null,
) => {
	const [target, configuration] = await Promise.all([
		loadTarget(machine),
		configurationId
			? db.query.osUpdateConfigurations.findFirst({
					where: eq(
						osUpdateConfigurations.osUpdateConfigurationId,
						configurationId,
					),
					columns: { name: true },
				})
			: null,
	]);
	return {
		server: target?.name ?? machine.id,
		configuration: configuration?.name ?? null,
	};
};

const launch = (runId: string) => {
	if (state.executing.has(runId)) return;
	const promise = executeRun(runId)
		.catch((error) =>
			console.error(`OS update run ${runId} failed`, loggableError(error)),
		)
		.finally(() => state.executing.delete(runId));
	state.executing.set(runId, promise);
};

const saveProgress = (runId: string, progress: OsUpdateRunProgress) =>
	db
		.update(osUpdateRuns)
		.set({ progress })
		.where(eq(osUpdateRuns.osUpdateRunId, runId));

/**
 * Ends a running run. False when it no longer runs: cancelled meanwhile (a
 * runner machine's run, while it waited for the jobs to end).
 */
const finishRun = async (
	runId: string,
	outcome: {
		status: "succeeded" | "failed" | "skipped";
		message: string;
	},
) => {
	const rows = await db
		.update(osUpdateRuns)
		.set({
			status: outcome.status,
			message: outcome.message,
			finishedAt: new Date().toISOString(),
			lockedBy: null,
			lockedUntil: null,
		})
		.where(
			and(
				eq(osUpdateRuns.osUpdateRunId, runId),
				eq(osUpdateRuns.status, "running"),
			),
		)
		.returning({ id: osUpdateRuns.osUpdateRunId });
	if (!rows.length) return false;
	await appendRunLog(runId, outcome.message);
	return true;
};

class StepLostError extends Error {}

/**
 * Starts a step on the server (unless resuming it) and follows it until it
 * ends: its log goes to the run's log, its result is returned.
 */
const runStep = async (input: {
	ssh: Connection;
	runId: string;
	step: RunStep;
	script: string;
	progress: OsUpdateRunProgress;
	resume: boolean;
}) => {
	const { ssh, runId, step } = input;
	const progress = { ...input.progress, step };
	if (!input.resume) {
		await ssh.patient(startStepScript(runId, step, input.script), {
			label: `Starting the ${step} step`,
			timeoutMs: 60_000,
		});
		progress.logOffset = 0;
		await saveProgress(runId, progress);
	}
	const giveUp = Date.now() + STEP_TIMEOUT_MS[step];
	let silent = 0;
	for (;;) {
		const { stdout } = await ssh.patient(
			followStepScript(runId, step, progress.logOffset),
			{ label: `Following the ${step} step`, timeoutMs: 60_000 },
		);
		const follow = parseFollow(stdout);
		if (!follow) throw new Error(`The ${step} step could not be followed`);
		const finished = follow.done;
		// Whole lines only, unless the step ended or a line fills the chunk.
		const cut = finished ? follow.log.length : follow.log.lastIndexOf("\n") + 1;
		const text =
			cut > 0 || follow.log.length < LOG_CHUNK_BYTES
				? follow.log.slice(0, cut)
				: follow.log;
		if (text) await appendRunLog(runId, text);
		const read = Buffer.byteLength(text);
		// The size is read before the log: the bytes received are what counts.
		progress.logOffset += read;
		await saveProgress(runId, progress);
		if (finished && progress.logOffset >= follow.size) return follow.result;
		if (finished) continue;
		if (!follow.unitActive) {
			// The unit may end between the two reads: one more look.
			silent += 1;
			if (silent > 2) {
				throw new StepLostError(
					`The ${step} step stopped without a result (the server rebooted, or its unit was stopped)`,
				);
			}
		} else silent = 0;
		if (Date.now() >= giveUp) {
			throw new Error(
				`The ${step} step did not end within ${STEP_TIMEOUT_MS[step] / 60_000} minutes`,
			);
		}
		await sleep(FOLLOW_EVERY_MS);
	}
};

const bootIdOf = async (ssh: Connection) => {
	const { stdout } = await ssh.root(BOOT_ID_COMMAND, {
		label: "Boot id",
		timeoutMs: 20_000,
	});
	return stdout.trim();
};

/** Waits for the server to answer with another boot id, then for Docker. */
const waitForBoot = async (
	ssh: Connection,
	bootId: string,
	expect: { docker: boolean; manager: boolean; noun: string },
	log: (line: string) => Promise<void>,
	since: number,
) => {
	const { manager, noun } = expect;
	const deadline = since + REBOOT_TIMEOUT_MS;
	for (;;) {
		try {
			const current = await bootIdOf(ssh);
			if (current && current !== bootId) break;
		} catch {
			// Still rebooting.
		}
		if (Date.now() >= deadline) {
			throw new Error(
				`The ${noun} did not come back within ${REBOOT_TIMEOUT_MS / 60_000} minutes of its reboot`,
			);
		}
		await sleep(10_000);
	}
	await log(`The ${noun} is back`);
	const ready = Date.now() + READY_TIMEOUT_MS;
	for (;;) {
		const { stdout } = await ssh.patient(dockerStatusScript(), {
			label: "Docker status",
			timeoutMs: 30_000,
		});
		const dockerActive = /^docker active=active$/m.test(stdout);
		// Docker that did not run before the reboot is not waited for.
		const noDocker = !expect.docker;
		const swarmLine = stdout
			.split("\n")
			.find((line) => line.startsWith("swarm "));
		const swarm = swarmLine ? parseSwarm(swarmLine.slice(6)) : null;
		const swarmReady =
			!manager || (swarm?.state === "active" && swarm.manager === true);
		if (noDocker || (dockerActive && swarmReady)) {
			await log(
				noDocker
					? "Docker did not run before the reboot: not waited for"
					: manager
						? "Docker runs and the node manages its Swarm again"
						: "Docker runs again",
			);
			return;
		}
		if (Date.now() >= ready) {
			throw new Error(
				manager
					? "Docker or the Swarm manager did not come back within 10 minutes of the reboot"
					: "Docker did not come back within 10 minutes of the reboot",
			);
		}
		await sleep(10_000);
	}
};

const plural = (count: number, word: string) =>
	`${count} ${word}${count === 1 ? "" : "s"}`;

/** The selected updates of installed packages, without the new packages. */
const selectedUpdates = (selection: ReturnType<typeof selectPackages>) =>
	selection.selected.filter((item) => item.from !== null);

const selectionSummary = (
	assessment: ServerAssessment,
	selection: ReturnType<typeof selectPackages>,
) => {
	const pending = assessment.packages.filter((item) => item.from !== null);
	const security = pending.filter((item) => item.security).length;
	const updates = selectedUpdates(selection);
	const fresh = selection.selected.filter((item) => item.from === null);
	const lines = [
		`${plural(pending.length, "update")} pending (${security} for security): ${updates.length} selected`,
	];
	if (updates.length && fresh.length) {
		lines.push(
			`New packages allowed only if a selected update needs them: ${fresh
				.slice(0, 30)
				.map((item) => item.name)
				.join(
					", ",
				)}${fresh.length > 30 ? ` and ${fresh.length - 30} more` : ""}`,
		);
	}
	const reasons = new Map<SkipReason, string[]>();
	for (const item of selection.skipped) {
		reasons.set(item.reason, [
			...(reasons.get(item.reason) ?? []),
			item.package.name,
		]);
	}
	for (const [reason, names] of reasons) {
		lines.push(
			`Skipped, ${SKIP_REASONS[reason]}: ${names.slice(0, 30).join(", ")}${names.length > 30 ? ` and ${names.length - 30} more` : ""}`,
		);
	}
	if (assessment.keptBack.length) {
		lines.push(
			`Kept back by apt (phased, or needing a removal): ${assessment.keptBack.join(", ")}`,
		);
	}
	return lines.join("\n");
};

// ------------------------------------------------------------- macOS hand-off

/** macOS as `sw_vers` reports it, run as the Mac's account (no sudo). */
export const MACOS_VERSION_COMMAND = `printf 'version=%s\\nbuild=%s\\nextra=%s\\n' "$(sw_vers -productVersion)" "$(sw_vers -buildVersion)" "$(sw_vers -productVersionExtra 2>/dev/null || true)"`;

export const parseMacosVersion = (output: string): MacosVersion | null => {
	const values: Record<string, string> = {};
	for (const line of output.split("\n")) {
		const separator = line.indexOf("=");
		if (separator > 0) {
			values[line.slice(0, separator).trim()] = line
				.slice(separator + 1)
				.trim();
		}
	}
	if (!values.version || !values.build) return null;
	return {
		version: values.version,
		build: values.build,
		extra: values.extra ?? "",
	};
};

export const macosLabel = (macos: MacosVersion) =>
	`macOS ${macos.version}${macos.extra ? ` ${macos.extra}` : ""} (${macos.build})`;

/** Another build, version or Rapid Security Response than at the start. */
export const macosChanged = (before: MacosVersion, now: MacosVersion) =>
	before.version !== now.version ||
	before.build !== now.build ||
	before.extra !== now.extra;

const readMacos = async (ssh: Connection) => {
	const { stdout } = await ssh.host(MACOS_VERSION_COMMAND, {
		label: "macOS version",
		timeoutMs: 30_000,
	});
	const macos = parseMacosVersion(stdout);
	if (!macos) throw new Error("the Mac did not report its macOS version");
	return macos;
};

/**
 * The owner updates macOS while the Mac runs no job; Dokploy only watches
 * for another version (the Mac restarts meanwhile, and stops answering for
 * a while). It installs nothing on macOS: that needs the owner (or an MDM).
 */
const awaitMacosUpdate = async (input: {
	runId: string;
	name: string;
	ssh: Connection;
	baseline: MacosVersion;
	deadline: number;
	log: (line: string) => Promise<void>;
}): Promise<
	| { kind: "updated"; macos: MacosVersion }
	| { kind: "expired" }
	| { kind: "cancelled" }
> => {
	const { runId, name, ssh, baseline, deadline, log } = input;
	let silent = false;
	for (;;) {
		const current = await db.query.osUpdateRuns.findFirst({
			where: eq(osUpdateRuns.osUpdateRunId, runId),
			columns: { status: true },
		});
		if (current?.status !== "running") return { kind: "cancelled" };
		try {
			const macos = await readMacos(ssh);
			if (silent) {
				silent = false;
				await log(`${name} answers again (${macosLabel(macos)})`);
			}
			if (macosChanged(baseline, macos)) return { kind: "updated", macos };
		} catch {
			if (!silent) {
				silent = true;
				await log(
					`${name} does not answer (restarting for its update?): waiting for it`,
				);
			}
		}
		if (Date.now() >= deadline) return { kind: "expired" };
		await sleepUntilDrainNews(HANDOFF_POLL_MS);
	}
};

type HoldOutcome =
	/** Empty: the run may install. With the progress it recorded. */
	| { kind: "drained"; progress: OsUpdateRunProgress }
	/** Nothing to do: the machine was never taken out of service. */
	| { kind: "nothing"; message: string }
	| { kind: "skipped"; message: string }
	/** Cancelled by a user while the jobs ran (the run is no longer running). */
	| { kind: "cancelled" };

/**
 * Takes a runner machine out of service for the run, and waits until it is
 * empty: no new job from the start, the running jobs end on their own (never
 * interrupted). Assessed first, so that a machine with nothing to install
 * keeps taking jobs. Given up, with nothing installed, when the jobs still
 * run at the install limit of the window. The run gives the machine back in
 * every case (executeRun). A hand-off (a Mac for its owner's macOS update)
 * is not assessed and waits until its own deadline.
 */
const holdRunnerMachine = async (input: {
	runId: string;
	machine: OsUpdateMachine;
	name: string;
	ssh: Connection;
	settings: OsUpdateSettings;
	deadline: number;
	progress: OsUpdateRunProgress;
	log: (line: string) => Promise<void>;
	handoff: boolean;
}): Promise<HoldOutcome> => {
	const { runId, machine, name, ssh, settings, log, handoff } = input;
	const limit = handoff ? input.deadline : input.deadline - INSTALL_RESERVE_MS;
	const what = handoff
		? "it is handed to its owner for a macOS update"
		: "the updates are installed";
	const nothing = handoff
		? "the hand-off did not start"
		: "nothing was installed";
	let progress = input.progress;
	let started = Boolean(progress.drainStartedAt);
	if (!started && !handoff) {
		// What it waits for, before any job is held back for it.
		const { stdout } = await ssh.patient(assessScript({ refresh: true }), {
			label: "Assessment",
			timeoutMs: 6 * 60_000,
		});
		const assessment =
			stdout.trim() === "busy" ? null : parseAssessment(stdout);
		if (assessment) {
			await saveAssessment(machine, assessment);
			if (!assessment.supported) {
				throw new Error(unsupportedMessage(assessment.os));
			}
			const selection = selectPackages(assessment.packages, settings);
			const reboot =
				settings.reboot === "always" ||
				(settings.reboot === "if-required" && assessment.rebootRequired);
			if (
				!selectedUpdates(selection).length &&
				!reboot &&
				!assessment.dpkgInterrupted
			) {
				await log(selectionSummary(assessment, selection));
				return {
					kind: "nothing",
					message: `Nothing to install${assessment.rebootRequired ? "; a reboot is pending (reboot setting: never)" : ""}: ${name} kept taking jobs.`,
				};
			}
		}
	}
	if (!started) {
		if (Date.now() >= limit) {
			return {
				kind: "skipped",
				message: handoff
					? "The hand-off expired before the machine could be drained."
					: "The maintenance window closed before the machine could be drained: nothing was installed.",
			};
		}
		// Recorded first: a user may cancel the run while the jobs end.
		progress = {
			...progress,
			step: "drain",
			drainStartedAt: new Date().toISOString(),
		};
		const saved = await db
			.update(osUpdateRuns)
			.set({ progress })
			.where(
				and(
					eq(osUpdateRuns.osUpdateRunId, runId),
					eq(osUpdateRuns.status, "running"),
				),
			)
			.returning({ id: osUpdateRuns.osUpdateRunId });
		if (!saved.length) return { kind: "cancelled" };
	}
	let told: string | null = null;
	const tell = async (line: string) => {
		if (line === told) return;
		told = line;
		await log(line);
	};
	for (;;) {
		const current = await db.query.osUpdateRuns.findFirst({
			where: eq(osUpdateRuns.osUpdateRunId, runId),
			columns: { status: true },
		});
		if (current?.status !== "running") return { kind: "cancelled" };
		const node = await loadRunnerNode(machine.id);
		if (!node) throw new Error("The runner machine no longer exists");
		const ours =
			isOsUpdateDrain(node.drain) && node.drain.osUpdateRunId === runId;
		if (!ours && started) {
			return {
				kind: "skipped",
				message: `${name} was put back to work, disabled or removed before its jobs ended: ${nothing}.`,
			};
		}
		if (!ours) {
			if (!isManagedRunnerNode(node)) {
				return {
					kind: "skipped",
					message: `${name} is ${node.phase === "error" ? "in error" : node.platform === "macos" && node.phase === "stopped" ? "stopped (its VM does not run)" : "not set up"} in GitHub Runners: ${nothing}.`,
				};
			}
			if (
				await startOsUpdateDrain({
					nodeId: machine.id,
					runId,
					abortAt: new Date(limit),
					handoff,
				})
			) {
				started = true;
				await tell(
					`${name} takes no new job: ${what} once its running jobs end (given up at ${new Date(limit).toISOString().slice(11, 16)} UTC otherwise)`,
				);
				continue;
			}
			// Another drain (an operator, the runner controller's updates).
			await tell(
				`${name} is busy with another action (${node.drain?.reason ?? node.phase}): waiting for it to end`,
			);
		} else if (node.drain?.drainedAt) {
			return { kind: "drained", progress };
		} else {
			const jobs = (node.observed?.slots ?? []).filter(
				(slot) => slot.state === "busy",
			).length;
			await tell(
				node.observed?.reachable === false
					? `${name} does not answer the runner controller: waiting for it`
					: jobs
						? `Waiting for ${plural(jobs, "running job")} to end`
						: "Waiting for the runner controller to find the machine empty",
			);
		}
		if (Date.now() >= limit) {
			return {
				kind: "skipped",
				message: handoff
					? started
						? `Jobs still ran on ${name} (or it did not answer) when the hand-off expired: it takes jobs again.`
						: `${name} was busy with another action until the hand-off expired.`
					: started
						? `Jobs still ran on ${name} (or it did not answer) when the maintenance window closed: nothing was installed, and it takes jobs again.`
						: `${name} was busy with another action until the maintenance window closed: nothing was installed.`,
			};
		}
		await sleepUntilDrainNews(DRAIN_POLL_MS);
	}
};

/**
 * The whole run: prepare, install, reboot, assess again. A runner machine is
 * drained first (holdRunnerMachine), and given back at the end, whatever
 * happened.
 */
const executeRun = async (runId: string) => {
	const renew = setInterval(() => {
		void db
			.update(osUpdateRuns)
			.set({
				lockedUntil: sql`now() + make_interval(secs => ${RUN_LEASE_S})`,
			})
			.where(
				and(
					eq(osUpdateRuns.osUpdateRunId, runId),
					eq(osUpdateRuns.lockedBy, OWNER),
					eq(osUpdateRuns.status, "running"),
				),
			)
			.catch(() => undefined);
	}, RUN_RENEW_MS);
	renew.unref?.();
	const log = (line: string) => appendRunLog(runId, line);
	let swarmLock: string | null = null;
	let ssh: Connection | null = null;
	let run: OsUpdateRun | undefined;
	let serverName = runId;
	let configurationName: string | null = null;
	/** This process runs it: it gives a runner machine back at the end. */
	let machine: OsUpdateMachine | null = null;
	try {
		run = await db.query.osUpdateRuns.findFirst({
			where: eq(osUpdateRuns.osUpdateRunId, runId),
		});
		if (!run || run.status !== "running" || run.lockedBy !== OWNER) return;
		machine = machineOf(run);
		const target = await loadTarget(machine);
		if (!target) {
			throw new Error(
				machine.kind === "server"
					? "The server no longer exists"
					: "The runner machine no longer exists",
			);
		}
		serverName = target.name;
		if (run.osUpdateConfigurationId) {
			const configuration = await db.query.osUpdateConfigurations.findFirst({
				where: eq(
					osUpdateConfigurations.osUpdateConfigurationId,
					run.osUpdateConfigurationId,
				),
				columns: { name: true },
			});
			configurationName = configuration?.name ?? null;
		}
		const settings = run.settings;
		const deadline = Date.parse(run.deadline);
		const noun = machine.kind === "server" ? "server" : "machine";
		ssh = connection(target, log);
		let progress: OsUpdateRunProgress = run.progress ?? {
			step: machine.kind === "runner" ? "drain" : "prepare",
			logOffset: 0,
			allowed: null,
			bootId: null,
			rebootRequestedAt: null,
		};
		const handoff = run.kind === "handoff";
		if (handoff && !target.vmName) {
			throw new Error("A hand-off is for the macOS of a Mac runner machine");
		}
		if (run.attempts === 1 && !run.progress) {
			await log(
				handoff
					? `Hand-off of ${target.name} for a macOS update: no new job, then its owner updates macOS (System Settings › General › Software Update); Dokploy installs nothing on macOS and gives the Mac back once it reports another version, or at ${new Date(deadline).toISOString().slice(0, 16).replace("T", " ")} UTC`
					: `${run.trigger === "manual" ? "Install now" : "Maintenance window"} on ${target.name}${target.vmName ? ` (VM ${target.vmName} of a Mac GitHub runner)` : machine.kind === "runner" ? " (GitHub runner machine)" : ""}: ${settings.classification === "security" ? "security updates" : "all updates"}, reboot ${settings.reboot}, Docker packages ${settings.allowDockerUpdates ? "allowed" : "held"}; no install starts after ${new Date(deadline - INSTALL_RESERVE_MS).toISOString().slice(0, 16).replace("T", " ")} UTC`,
			);
		}
		// A hand-off compares macOS with what it was at the start.
		if (handoff && !progress.macos) {
			const baseline = await readMacos(ssh);
			progress = { ...progress, macos: baseline };
			await saveProgress(runId, progress);
			await log(`${target.name} runs ${macosLabel(baseline)}`);
		}

		// ---- runner machines: drained first, jobs never interrupted
		if (progress.step === "drain") {
			const held = await holdRunnerMachine({
				runId,
				machine,
				name: target.name,
				ssh,
				settings,
				deadline,
				progress,
				log,
				handoff,
			});
			if (held.kind === "cancelled") {
				await log(
					handoff
						? "Cancelled while the jobs ended"
						: "Cancelled while the jobs ended: nothing was installed",
				);
				return;
			}
			if (held.kind === "nothing") {
				await complete(held.message);
				return;
			}
			if (held.kind === "skipped") {
				await finishRun(runId, { status: "skipped", message: held.message });
				return;
			}
			// From here on the run installs: no cancel, and the machine stays
			// out of service until the run gives it back. A hand-off may still
			// be cancelled ("Give back now"): Dokploy installs nothing.
			const next: OsUpdateRunProgress = {
				...held.progress,
				step: handoff ? "handoff" : "prepare",
				logOffset: 0,
			};
			const moved = await db
				.update(osUpdateRuns)
				.set({ progress: next })
				.where(
					and(
						eq(osUpdateRuns.osUpdateRunId, runId),
						eq(osUpdateRuns.status, "running"),
					),
				)
				.returning({ id: osUpdateRuns.osUpdateRunId });
			if (!moved.length) {
				await log(
					handoff
						? "Cancelled while the jobs ended"
						: "Cancelled while the jobs ended: nothing was installed",
				);
				return;
			}
			if (!(await markOsUpdateInstalling(machine.id, runId))) {
				await finishRun(runId, {
					status: "skipped",
					message: handoff
						? `${target.name} was put back to work, disabled or removed before its hand-off.`
						: `${target.name} was put back to work, disabled or removed before the install: nothing was installed.`,
				});
				return;
			}
			progress = next;
			if (handoff) {
				const until = new Date(deadline)
					.toISOString()
					.slice(0, 16)
					.replace("T", " ");
				await log(
					`${target.name} runs no job any more: its owner may update macOS now. Dokploy gives it back once it reports another version, or at ${until} UTC`,
				);
				if (run) {
					notify(run.organizationId, {
						event: "handoff",
						title: `${target.name} is ready for its macOS update`,
						message: `No job runs on ${target.name} any more. Update macOS on it (System Settings › General › Software Update): Dokploy gives it back to its jobs once it reports another version than ${macosLabel(progress.macos ?? { version: "?", build: "?", extra: "" })}, or at ${until} UTC.`,
						server: target.name,
						configuration: null,
						at: new Date(),
					});
				}
			} else {
				await log(`${target.name} runs no job any more: installing`);
			}
		}

		// ---- a Mac handed to its owner: Dokploy watches, installs nothing
		if (progress.step === "handoff") {
			const baseline = progress.macos;
			if (!baseline) throw new Error("The hand-off lost its macOS version");
			const outcome = await awaitMacosUpdate({
				runId,
				name: target.name,
				ssh,
				baseline,
				deadline,
				log,
			});
			if (outcome.kind === "cancelled") {
				await log("Given back before its macOS update");
				return;
			}
			if (outcome.kind === "expired") {
				const message = `macOS did not change before the hand-off expired (still ${macosLabel(baseline)}): ${target.name} takes jobs again.`;
				if (await finishRun(runId, { status: "skipped", message })) {
					notify(run.organizationId, {
						event: "missed",
						title: `Hand-off of ${target.name} expired`,
						message,
						server: target.name,
						configuration: null,
						at: new Date(),
					});
				}
				return;
			}
			const message = `macOS updated: ${macosLabel(baseline)} → ${macosLabel(outcome.macos)}. ${target.name} takes jobs again.`;
			if (await finishRun(runId, { status: "succeeded", message })) {
				notify(run.organizationId, {
					event: "succeeded",
					title: `macOS updated on ${target.name}`,
					message,
					server: target.name,
					configuration: null,
					at: new Date(),
				});
			}
			return;
		}

		let assessment: ServerAssessment | null = null;
		let installed: InstallResult | null = null;
		let manager = false;
		let dockerRan = false;
		const changes: OsUpdateRunPackage[] = run.packages;
		let rebootRequired = run.rebootRequired ?? false;

		if (progress.step !== "reboot") {
			let resumeInstall = progress.step === "install";
			for (;;) {
				if (!resumeInstall) {
					// ---- prepare: recover dpkg, refresh the lists, assess
					const prepared = await runStep({
						ssh,
						runId,
						step: "prepare",
						script: prepareStep(runId),
						progress,
						resume: false,
					});
					progress = { ...progress, step: "prepare" };
					assessment = parseAssessment(prepared);
					if (assessment) await saveAssessment(machine, assessment);
					if (assessment && !assessment.supported) {
						throw new Error(unsupportedMessage(assessment.os));
					}
					const code = stepExitCode(prepared);
					if (!assessment || code !== 0) {
						throw new Error(
							`Preparing the server failed (exit ${code ?? "unknown"}): see the log`,
						);
					}
					if (assessment.simulationError) {
						throw new Error(
							`apt cannot plan the upgrade: ${assessment.simulationError}`,
						);
					}
					const selection = selectPackages(assessment.packages, settings);
					await log(selectionSummary(assessment, selection));
					// New packages alone install nothing: no update would pull them in.
					if (!selectedUpdates(selection).length) {
						await log("Nothing to install");
						rebootRequired = assessment.rebootRequired;
						break;
					}
					if (Date.now() >= deadline - INSTALL_RESERVE_MS) {
						await finishRun(runId, {
							status: "skipped",
							message:
								"The maintenance window closed before the install could start: nothing was installed.",
						});
						return;
					}
					progress = {
						...progress,
						step: "install",
						allowed: selection.selected.map((item) => item.name),
						logOffset: 0,
					};
				}
				// ---- install
				const allowed = progress.allowed ?? [];
				let result: string;
				try {
					result = await runStep({
						ssh,
						runId,
						step: "install",
						script: installStep({
							runId,
							allowed,
							deadline: Math.floor((deadline - INSTALL_RESERVE_MS) / 1000),
						}),
						progress,
						resume: resumeInstall,
					});
				} catch (error) {
					if (error instanceof StepLostError && resumeInstall) {
						// Lost while Dokploy was away: start over, dpkg recovers first.
						await log(`${error.message}: starting over`);
						resumeInstall = false;
						progress = { ...progress, step: "prepare", logOffset: 0 };
						continue;
					}
					throw error;
				}
				installed = parseInstallResult(result);
				if (!installed) throw new Error("The install step left no result");
				// Resumed: the prepare step's assessment was saved with the machine.
				assessment ??= (await findMachineState(machine))?.assessment ?? null;
				const security = new Map(
					(assessment?.packages ?? []).map((item) => [
						item.name.split(":")[0],
						item.security,
					]),
				);
				changes.splice(
					0,
					changes.length,
					...installed.changes.map((change) => ({
						...change,
						security: security.get(change.name.split(":")[0]) ?? null,
					})),
				);
				rebootRequired = installed.rebootRequired;
				await db
					.update(osUpdateRuns)
					.set({ packages: changes, rebootRequired })
					.where(eq(osUpdateRuns.osUpdateRunId, runId));
				if (installed.exitCode !== 0) {
					throw new Error(
						`apt-get upgrade failed (exit ${installed.exitCode ?? "unknown"}): see the log${changes.length ? `. ${plural(changes.length, "package")} changed before it stopped` : ""}`,
					);
				}
				if (installed.status === "window-closed") {
					await finishRun(runId, {
						status: "skipped",
						message:
							"The maintenance window closed while the server was prepared: nothing was installed.",
					});
					return;
				}
				await log(
					changes.length
						? `${plural(changes.length, "package")} changed: ${changes
								.slice(0, 40)
								.map((change) => `${change.name} ${change.to ?? "removed"}`)
								.join(
									", ",
								)}${changes.length > 40 ? ` and ${changes.length - 40} more` : ""}`
						: "apt installed nothing (the selected updates were held back)",
				);
				break;
			}
			// Docker and Swarm, as the server reported them before the install.
			const current =
				assessment ?? (await findMachineState(machine))?.assessment;
			manager =
				current?.swarm?.manager === true && (current.swarm.managers ?? 1) > 1;
			dockerRan = current?.docker?.active === true;

			// ---- reboot, or Docker restart
			const wantsReboot =
				settings.reboot === "always" ||
				(settings.reboot === "if-required" && rebootRequired);
			const dockerChanged = changes.some((change) =>
				isDockerPackage(change.name),
			);
			if (!wantsReboot) {
				if (
					dockerChanged &&
					installed?.dockerRestarted === false &&
					current?.docker?.active
				) {
					// Ubuntu's docker.io leaves the old daemon running after its upgrade.
					await log(
						"Restarting Docker: its packages changed and its daemon did not restart",
					);
					await ssh.root(RESTART_DOCKER_COMMAND, {
						label: "Docker restart",
						timeoutMs: 5 * 60_000,
					});
				}
				const outcome = changes.length
					? `${plural(changes.length, "package")} updated${rebootRequired ? "; a reboot is pending (reboot setting: never)" : ""}.`
					: rebootRequired && settings.reboot === "never"
						? "Nothing to install; a reboot is pending (reboot setting: never)."
						: "Nothing to install.";
				await complete(outcome);
				return;
			}
			if (Date.now() >= deadline) {
				await complete(
					`${changes.length ? `${plural(changes.length, "package")} updated` : "Nothing installed"}; the reboot waits for the next window, which closed before it could start.`,
				);
				return;
			}
			if (manager && current?.swarm?.clusterId) {
				const key = `swarm:${current.swarm.clusterId}`;
				await log(
					"This server manages a Swarm with other managers: waiting for them to be free to reboot",
				);
				for (;;) {
					if (await takeLock(key, SWARM_LOCK_TTL_S)) break;
					if (Date.now() >= deadline) {
						await complete(
							`${plural(changes.length, "package")} updated; the reboot waits for the next window: another manager of its Swarm was rebooting until the window closed.`,
						);
						return;
					}
					await sleep(15_000);
				}
				swarmLock = key;
				const { stdout } = await ssh.root(SWARM_MANAGERS_COMMAND, {
					label: "Swarm managers",
					timeoutMs: 30_000,
				});
				const check = swarmRebootCheck(parseSwarmManagers(stdout));
				if (!check.safe) {
					await complete(
						`${plural(changes.length, "package")} updated; not rebooted: ${check.reason}. Reboot it by hand when the Swarm can spare it.`,
					);
					return;
				}
			}
			const bootId = await bootIdOf(ssh);
			progress = {
				...progress,
				step: "reboot",
				bootId,
				rebootRequestedAt: new Date().toISOString(),
			};
			await saveProgress(runId, progress);
			const why =
				settings.reboot === "always"
					? " (reboot setting: always)"
					: ": an update asks for it";
			if (target.vmName) {
				// The VM of a Mac restarts as the runner controller restarts it
				// (its stop and start scripts): the Mac itself never reboots.
				await log(`Restarting VM ${target.vmName} of ${target.name}${why}`);
				await ssh.host(macStopVmScript(target.vmName), {
					label: "VM stop",
					timeoutMs: 5 * 60_000,
				});
				await ssh.host(macStartVmScript(target.vmName), {
					label: "VM start",
					timeoutMs: 15 * 60_000,
				});
			} else {
				await log(`Rebooting the ${noun}${why}`);
				await ssh.root(rebootScript(runId), {
					label: "Reboot",
					timeoutMs: 30_000,
				});
				ssh.reset();
			}
		} else {
			// Resumed while the server rebooted. A VM stopped by a process that
			// died before starting it again is started (a running one is left).
			if (target.vmName) {
				await ssh.host(macStartVmScript(target.vmName), {
					label: "VM start",
					timeoutMs: 15 * 60_000,
				});
			}
			const current = (await findMachineState(machine))?.assessment;
			manager =
				current?.swarm?.manager === true && (current.swarm.managers ?? 1) > 1;
			dockerRan = current?.docker?.active === true;
			if (manager && current?.swarm?.clusterId) {
				// Keeps the other managers waiting until this one is back.
				swarmLock = `swarm:${current.swarm.clusterId}`;
				await takeLock(swarmLock, SWARM_LOCK_TTL_S);
			}
		}

		// ---- the server reboots
		const renewSwarm = swarmLock
			? setInterval(() => {
					if (swarmLock)
						void takeLock(swarmLock, SWARM_LOCK_TTL_S).catch(() => undefined);
				}, 30_000)
			: null;
		try {
			await waitForBoot(
				ssh,
				progress.bootId ?? "",
				{ docker: dockerRan, manager, noun },
				log,
				Date.parse(progress.rebootRequestedAt ?? new Date().toISOString()),
			);
		} finally {
			if (renewSwarm) clearInterval(renewSwarm);
		}
		// The runner controller's connection died with the reboot: it opens a
		// new one at its next tick instead of failing a probe on the old one.
		// A Mac did not reboot: its connection holds.
		if (machine.kind === "runner" && !target.vmName) {
			closeSharedSessions(target);
		}
		await db
			.update(osUpdateRuns)
			.set({ rebooted: true })
			.where(eq(osUpdateRuns.osUpdateRunId, runId));
		await complete(
			`${changes.length ? `${plural(changes.length, "package")} updated` : "Nothing installed"}, and the ${noun} rebooted.`,
		);
	} catch (error) {
		const message = redactLogLine(messageOf(error));
		const failed = await finishRun(runId, {
			status: "failed",
			message: `Failed: ${message}`,
		}).catch(() => false);
		if (run && failed) {
			notify(run.organizationId, {
				event: "failed",
				title: `OS updates failed on ${serverName}`,
				message,
				server: serverName,
				configuration: configurationName,
				at: new Date(),
			});
		}
	} finally {
		clearInterval(renew);
		if (swarmLock) await releaseLock(swarmLock).catch(() => undefined);
		ssh?.reset();
		// Back to work, whatever happened: installed, failed, skipped,
		// cancelled. Only the run's own drain goes.
		if (machine?.kind === "runner") {
			const given = await releaseOsUpdateDrain(machine.id, runId).catch(
				(error) => {
					console.error(
						`OS updates: ${serverName} not given back to GitHub Runners (the runner controller does it)`,
						loggableError(error),
					);
					return false;
				},
			);
			if (given) {
				await log(`${serverName} takes jobs again`).catch(() => undefined);
			}
		}
	}

	/** Success: the files of the run go, the machine is assessed again. */
	async function complete(message: string) {
		if (!run || !ssh || !machine) return;
		await ssh
			.root(cleanupRunScript(runId), { label: "Cleanup", timeoutMs: 30_000 })
			.catch(() => undefined);
		try {
			const { stdout } = await ssh.root(assessScript({ refresh: false }), {
				label: "Assessment",
				timeoutMs: 2 * 60_000,
			});
			const assessment = parseAssessment(stdout);
			if (assessment) await saveAssessment(machine, assessment);
		} catch {
			// The next periodic assessment tells.
		}
		if (!(await finishRun(runId, { status: "succeeded", message }))) return;
		const configuration = run.osUpdateConfigurationId
			? await db.query.osUpdateConfigurations.findFirst({
					where: eq(
						osUpdateConfigurations.osUpdateConfigurationId,
						run.osUpdateConfigurationId,
					),
					columns: { notifyOnSuccess: true },
				})
			: null;
		if (configuration?.notifyOnSuccess) {
			notify(run.organizationId, {
				event: "succeeded",
				title: `OS updates installed on ${serverName}`,
				message,
				server: serverName,
				configuration: configurationName,
				at: new Date(),
			});
		}
	}
};

// ------------------------------------------------------------- tick

const purgeHistory = async (now: Date) => {
	if (now.getTime() - state.lastPurge < 60 * 60_000) return;
	state.lastPurge = now.getTime();
	await db
		.delete(osUpdateRuns)
		.where(
			and(
				isNotNull(osUpdateRuns.finishedAt),
				lt(
					osUpdateRuns.finishedAt,
					new Date(now.getTime() - HISTORY_RETENTION_MS).toISOString(),
				),
			),
		);
};

export const tickOsUpdates = async () => {
	if (state.ticking || !state.leader) return;
	state.ticking = true;
	try {
		const now = new Date();
		const busy = new Set<string>();
		await resumeOrphanedRuns(busy);
		await planOsUpdateWindows(now);
		await skipClosedOsUpdateRuns(now);
		await startPendingRuns(busy);
		await assessDueMachines(now, busy);
		await purgeHistory(now);
	} catch (error) {
		console.error("OS updates: tick failed", loggableError(error));
	} finally {
		state.ticking = false;
	}
};

const heartbeat = async () => {
	const leading = await takeLock("leader", LEADER_TTL_S);
	if (leading && !state.leader) {
		console.log(`OS updates controller: leading (${OWNER})`);
		state.leader = true;
		void tickOsUpdates();
	} else if (!leading && state.leader) {
		console.log(`OS updates controller: standing by (${OWNER})`);
		state.leader = false;
	}
};

/**
 * Starts the controller of this process. Every Dokploy process runs one; the
 * leader ticks, the others take over within LEADER_TTL_S of its end.
 */
export const startOsUpdatesController = async () => {
	if (
		state.heartbeat ||
		process.env.DOKPLOY_OS_UPDATES_CONTROLLER === "false"
	) {
		return;
	}
	await heartbeat().catch((error) =>
		console.error("OS updates controller: no database", loggableError(error)),
	);
	state.heartbeat = setInterval(
		() =>
			void heartbeat().catch(() => {
				state.leader = false;
			}),
		HEARTBEAT_MS,
	);
	state.timer = setInterval(() => void tickOsUpdates(), TICK_MS);
	console.log("OS updates controller started");
};

/** Stops ticking and hands the leadership over at once. */
export const stopOsUpdatesController = async () => {
	if (state.timer) clearInterval(state.timer);
	if (state.heartbeat) clearInterval(state.heartbeat);
	state.timer = null;
	state.heartbeat = null;
	if (state.leader) {
		state.leader = false;
		await releaseLock("leader").catch(() => undefined);
	}
};

/** Asks the leader to tick now (after "Install now" or "Check now"). */
export const requestOsUpdatesTick = () => {
	if (state.leader) void tickOsUpdates();
};
