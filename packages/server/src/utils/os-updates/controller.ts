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
 * The Dokploy server itself is not managed: rebooting it, or restarting its
 * Docker, would stop the process that drives the run.
 */

import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { db } from "@dokploy/server/db";
import {
	type OsUpdateConfiguration,
	type OsUpdateRun,
	type OsUpdateRunPackage,
	type OsUpdateRunProgress,
	type OsUpdateServer,
	osUpdateConfigurations,
	osUpdateLocks,
	osUpdateRuns,
	osUpdateServers,
} from "@dokploy/server/db/schema";
import { and, asc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { loggableError } from "../github-runners/errors";
import { type NodeSession, openNodeSession } from "../github-runners/ssh";
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

interface ControllerState {
	owner: string;
	leader: boolean;
	heartbeat: NodeJS.Timeout | null;
	timer: NodeJS.Timeout | null;
	ticking: boolean;
	/** Runs this process executes. */
	executing: Map<string, Promise<void>>;
	/** Servers this process assesses. */
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

// ------------------------------------------------------------- SSH

type ServerRow = NonNullable<Awaited<ReturnType<typeof loadServer>>>;

const loadServer = (serverId: string) =>
	db.query.server.findFirst({
		where: (table, { eq }) => eq(table.serverId, serverId),
		with: { sshKey: true },
	});

/**
 * One SSH connection to a server, opened again after a failure: the server
 * may drop it (network, sshd restarted by an update, reboot). `say` tells a
 * run's log when the server stops answering, and when it answers again.
 */
const connection = (
	server: ServerRow,
	say?: (line: string) => Promise<void>,
) => {
	let session: NodeSession | null = null;
	const open = async () => {
		if (!server.sshKey?.privateKey) {
			throw new Error(`${server.name} has no SSH key in Dokploy`);
		}
		session ??= await openNodeSession({
			name: server.name,
			host: server.ipAddress,
			port: server.port,
			username: server.username,
			privateKey: server.sshKey.privateKey,
			// As every other SSH command of Dokploy on its servers.
			hostKeyFingerprint: null,
		});
		return session;
	};
	const reset = () => {
		session?.close();
		session = null;
	};
	/** Runs a script as root. */
	const root = async (
		script: string,
		options: { label: string; timeoutMs: number; allowFailure?: boolean },
	) => {
		const current = await open();
		try {
			return await current.run(rootShell(server.username), {
				input: script.endsWith("\n") ? script : `${script}\n`,
				...options,
			});
		} catch (error) {
			reset();
			throw error;
		}
	};
	/** As root, retried while the server does not answer, up to `giveUpMs`. */
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
				if (told) await tell(`${server.name} answers again`);
				return result;
			} catch (error) {
				if (Date.now() >= giveUp) throw error;
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
	return { root, patient, reset };
};

type Connection = ReturnType<typeof connection>;

// ------------------------------------------------------------- assessment

const saveAssessment = (serverId: string, assessment: ServerAssessment) =>
	db
		.update(osUpdateServers)
		.set({
			assessment,
			assessedAt: new Date().toISOString(),
			assessmentError: null,
		})
		.where(eq(osUpdateServers.serverId, serverId));

/** A server held by another OS update script is asked again after this. */
const BUSY_RETRY_MS = 60_000;
export const BUSY_MESSAGE =
	"Another Dokploy OS update script runs on the server: checked again in a minute";

/** Assesses a server now (refreshing its package lists). */
export const assessServer = async (serverId: string) => {
	if (state.assessing.has(serverId)) return;
	state.assessing.add(serverId);
	const at = new Date().toISOString();
	try {
		const before = await db.query.osUpdateServers.findFirst({
			where: eq(osUpdateServers.serverId, serverId),
			columns: { assessmentRequestedAt: true },
		});
		await db
			.update(osUpdateServers)
			.set({ assessmentTriedAt: at, assessmentRequestedAt: null })
			.where(eq(osUpdateServers.serverId, serverId));
		const server = await loadServer(serverId);
		if (!server) return;
		const ssh = connection(server);
		try {
			const { stdout } = await ssh.root(assessScript({ refresh: true }), {
				label: "Assessment",
				timeoutMs: 6 * 60_000,
			});
			if (stdout.trim() === "busy") {
				// Said, and a Check now stays asked: the next try comes in a minute.
				await db
					.update(osUpdateServers)
					.set({
						assessmentError: BUSY_MESSAGE,
						assessmentRequestedAt: before?.assessmentRequestedAt ?? null,
					})
					.where(eq(osUpdateServers.serverId, serverId));
				return;
			}
			const assessment = parseAssessment(stdout);
			if (!assessment) throw new Error("the server sent no readable report");
			await saveAssessment(serverId, assessment);
		} finally {
			ssh.reset();
		}
	} catch (error) {
		await db
			.update(osUpdateServers)
			.set({ assessmentError: messageOf(error) })
			.where(eq(osUpdateServers.serverId, serverId))
			.catch(() => undefined);
	} finally {
		state.assessing.delete(serverId);
	}
};

/** Due assessments: requested, or periodic ones older than 24 hours. */
const assessDueServers = async (now: Date, busy: Set<string>) => {
	const day = new Date(now.getTime() - ASSESS_EVERY_MS).toISOString();
	const retry = new Date(now.getTime() - ASSESS_RETRY_MS).toISOString();
	const busyRetry = new Date(now.getTime() - BUSY_RETRY_MS).toISOString();
	const rows = await db.query.osUpdateServers.findMany({
		with: { server: { columns: { serverStatus: true } } },
	});
	const due = rows.filter(
		(row) =>
			row.server?.serverStatus === "active" &&
			!busy.has(row.serverId) &&
			!state.assessing.has(row.serverId) &&
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
		void assessServer(row.serverId);
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
 * Gives every assigned server a run for the open window, and records the
 * last window as missed for the servers that had none.
 */
export const planOsUpdateWindows = async (now: Date) => {
	const configurations = await db.query.osUpdateConfigurations.findMany({
		where: eq(osUpdateConfigurations.enabled, true),
		with: { servers: { with: { server: { columns: { name: true } } } } },
	});
	await sequentially(configurations, (configuration) =>
		planConfiguration(configuration, now),
	);
};

const planConfiguration = async (
	configuration: OsUpdateConfiguration & {
		servers: (OsUpdateServer & { server: { name: string } | null })[];
	},
	now: Date,
) => {
	const assigned = configuration.servers.filter((row) => row.assignedAt);
	if (!assigned.length) return;
	const open = openWindow(configuration.schedule, now);
	if (open) {
		await db
			.insert(osUpdateRuns)
			.values(
				assigned.map((row) => ({
					organizationId: configuration.organizationId,
					serverId: row.serverId,
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
				serverId: row.serverId,
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
		.returning({ serverId: osUpdateRuns.serverId });
	if (!missed.length) return;
	const recorded = new Set(missed.map((item) => item.serverId));
	// A configuration may hold many servers: the notice names a few.
	const names = listNames(
		concerned
			.filter((row) => recorded.has(row.serverId))
			.map((row) => row.server?.name ?? row.serverId),
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
			and(eq(osUpdateRuns.status, "pending"), lt(osUpdateRuns.deadline, limit)),
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

/** Starts the pending runs whose server and configuration are free. */
const startPendingRuns = async (busyServers: Set<string>) => {
	const [pending, running] = await Promise.all([
		db.query.osUpdateRuns.findMany({
			where: eq(osUpdateRuns.status, "pending"),
			with: {
				server: { columns: { name: true, serverStatus: true } },
				configuration: true,
			},
			orderBy: [asc(osUpdateRuns.createdAt)],
		}),
		db
			.select({
				serverId: osUpdateRuns.serverId,
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
	for (const run of running) busyServers.add(run.serverId);
	if (!pending.length) return;
	const assessments = new Map(
		(
			await db.query.osUpdateServers.findMany({
				where: inArray(
					osUpdateServers.serverId,
					pending.map((run) => run.serverId),
				),
				columns: {
					serverId: true,
					assessment: true,
					osUpdateConfigurationId: true,
				},
			})
		).map((row) => [row.serverId, row]),
	);
	// Swarm managers last, then by name: the other nodes go first.
	const order = (run: (typeof pending)[number]) =>
		`${assessments.get(run.serverId)?.assessment?.swarm?.manager ? 1 : 0}:${run.server?.name ?? ""}`;
	pending.sort((a, b) =>
		a.trigger !== b.trigger
			? a.trigger === "manual"
				? -1
				: 1
			: order(a).localeCompare(order(b)),
	);
	// One after the other: each claim changes what the next one may take.
	await sequentially(pending, async (run) => {
		if (busyServers.has(run.serverId) || state.assessing.has(run.serverId)) {
			return;
		}
		if (
			run.trigger === "schedule" &&
			busyConfigurations.has(run.osUpdateConfigurationId)
		) {
			return;
		}
		const skip =
			run.server?.serverStatus !== "active"
				? "The server is inactive in Dokploy: nothing was installed."
				: run.trigger === "schedule" && !run.configuration?.enabled
					? "The configuration was disabled or deleted before this server's turn: nothing was installed."
					: run.trigger === "schedule" &&
							assessments.get(run.serverId)?.osUpdateConfigurationId !==
								run.osUpdateConfigurationId
						? "The server left the configuration before its turn: nothing was installed."
						: null;
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
		busyServers.add(run.serverId);
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
const resumeOrphanedRuns = async (busyServers: Set<string>) => {
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
			organizationId: osUpdateRuns.organizationId,
			configurationId: osUpdateRuns.osUpdateConfigurationId,
			attempts: osUpdateRuns.attempts,
		});
	for (const row of rows) busyServers.add(row.serverId);
	await Promise.all(
		rows.map(async (row) => {
			if (row.attempts > MAX_ATTEMPTS) {
				const message = `Dokploy stopped during this run ${MAX_ATTEMPTS} times: given up. Check the server, then use Install now.`;
				await finishRun(row.id, { status: "failed", message });
				const names = await namesOf(row.serverId, row.configurationId);
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

/** The names a notice shows: the server's, and its configuration's. */
const namesOf = async (serverId: string, configurationId: string | null) => {
	const [target, configuration] = await Promise.all([
		loadServer(serverId),
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
		server: target?.name ?? serverId,
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

const finishRun = async (
	runId: string,
	outcome: {
		status: "succeeded" | "failed" | "skipped";
		message: string;
	},
) => {
	await db
		.update(osUpdateRuns)
		.set({
			status: outcome.status,
			message: outcome.message,
			finishedAt: new Date().toISOString(),
			lockedBy: null,
			lockedUntil: null,
		})
		.where(eq(osUpdateRuns.osUpdateRunId, runId));
	await appendRunLog(runId, outcome.message);
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
	expect: { docker: boolean; manager: boolean },
	log: (line: string) => Promise<void>,
	since: number,
) => {
	const { manager } = expect;
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
				`The server did not come back within ${REBOOT_TIMEOUT_MS / 60_000} minutes of its reboot`,
			);
		}
		await sleep(10_000);
	}
	await log("The server is back");
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

/** The whole run: prepare, install, reboot, assess again. */
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
	try {
		run = await db.query.osUpdateRuns.findFirst({
			where: eq(osUpdateRuns.osUpdateRunId, runId),
		});
		if (!run || run.status !== "running" || run.lockedBy !== OWNER) return;
		const server = await loadServer(run.serverId);
		if (!server) throw new Error("The server no longer exists");
		serverName = server.name;
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
		ssh = connection(server, log);
		let progress: OsUpdateRunProgress = run.progress ?? {
			step: "prepare",
			logOffset: 0,
			allowed: null,
			bootId: null,
			rebootRequestedAt: null,
		};
		if (run.attempts === 1 && !run.progress) {
			await log(
				`${run.trigger === "manual" ? "Install now" : "Maintenance window"} on ${server.name}: ${settings.classification === "security" ? "security updates" : "all updates"}, reboot ${settings.reboot}, Docker packages ${settings.allowDockerUpdates ? "allowed" : "held"}; no install starts after ${new Date(deadline - INSTALL_RESERVE_MS).toISOString().slice(0, 16).replace("T", " ")} UTC`,
			);
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
					if (assessment) await saveAssessment(server.serverId, assessment);
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
				// Resumed: the prepare step's assessment was saved with the server.
				assessment ??=
					(
						await db.query.osUpdateServers.findFirst({
							where: eq(osUpdateServers.serverId, server.serverId),
						})
					)?.assessment ?? null;
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
				assessment ??
				(
					await db.query.osUpdateServers.findFirst({
						where: eq(osUpdateServers.serverId, server.serverId),
					})
				)?.assessment;
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
			await log(
				settings.reboot === "always"
					? "Rebooting the server (reboot setting: always)"
					: "Rebooting the server: an update asks for it",
			);
			await ssh.root(rebootScript(runId), {
				label: "Reboot",
				timeoutMs: 30_000,
			});
			ssh.reset();
		} else {
			// Resumed while the server rebooted.
			const current = (
				await db.query.osUpdateServers.findFirst({
					where: eq(osUpdateServers.serverId, server.serverId),
				})
			)?.assessment;
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
				{ docker: dockerRan, manager },
				log,
				Date.parse(progress.rebootRequestedAt ?? new Date().toISOString()),
			);
		} finally {
			if (renewSwarm) clearInterval(renewSwarm);
		}
		await db
			.update(osUpdateRuns)
			.set({ rebooted: true })
			.where(eq(osUpdateRuns.osUpdateRunId, runId));
		await complete(
			`${changes.length ? `${plural(changes.length, "package")} updated` : "Nothing installed"}, and the server rebooted.`,
		);
	} catch (error) {
		const message = redactLogLine(messageOf(error));
		await finishRun(runId, {
			status: "failed",
			message: `Failed: ${message}`,
		}).catch(() => undefined);
		if (run) {
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
	}

	/** Success: the files of the run go, the server is assessed again. */
	async function complete(message: string) {
		if (!run || !ssh) return;
		await ssh
			.root(cleanupRunScript(runId), { label: "Cleanup", timeoutMs: 30_000 })
			.catch(() => undefined);
		try {
			const { stdout } = await ssh.root(assessScript({ refresh: false }), {
				label: "Assessment",
				timeoutMs: 2 * 60_000,
			});
			const assessment = parseAssessment(stdout);
			if (assessment) await saveAssessment(run.serverId, assessment);
		} catch {
			// The next periodic assessment tells.
		}
		await finishRun(runId, { status: "succeeded", message });
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
		await assessDueServers(now, busy);
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
