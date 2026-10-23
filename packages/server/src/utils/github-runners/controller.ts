import { createHash, randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { db } from "@dokploy/server/db";
import {
	type GithubRunnerAppliedConfig,
	type GithubRunnerCleanup,
	type GithubRunnerDrain,
	type GithubRunnerFirewallState,
	type GithubRunnerJobRecord,
	type GithubRunnerNode,
	type GithubRunnerNodeObservation,
	type GithubRunnerOperation,
	type GithubRunnerOsReport,
	type GithubRunnerPool,
	type GithubRunnerRollout,
	type GithubRunnerUpdateKind,
	github,
	githubRunnerAlerts,
	githubRunnerControllers,
	githubRunnerJobs,
	githubRunnerLeader,
	githubRunnerMetrics,
	githubRunnerNodes,
	githubRunnerOperations,
	githubRunnerPools,
	githubRunnerReroutes,
} from "@dokploy/server/db/schema";
import {
	and,
	asc,
	eq,
	gte,
	inArray,
	isNotNull,
	isNull,
	lt,
	ne,
	notInArray,
	or,
	sql,
} from "drizzle-orm";
import ssh2 from "ssh2";
import {
	dokployServerAddresses,
	loadRunnerFirewalls,
	type RunnerFirewalls,
	runnerNodeFirewall,
} from "../../services/firewall";
import { nftablesRuleset, pfRuleset, type Ruleset } from "../firewall/backends";
import { compileFirewall, filters } from "../firewall/model";
import { sendGithubRunnerNotifications } from "../notifications/github-runners";
import {
	mapWithConcurrency,
	sequentially,
} from "../service-migration/concurrency";
import { type RunnerNotice, runnerAlerts, syncRunnerAlerts } from "./alerts";
import { autonomySetting, planSpares } from "./autonomy";
import {
	effectiveBudget,
	formatBytes,
	formatCpuList,
	formatCpus,
	resolveMaxRunners,
	sliceLimits,
	vmSize,
} from "./budget";
import { linuxChecks, macChecks, type NodeCheck } from "./checks";
import {
	cleanupDue,
	type DiskPressure,
	type DiskSample,
	diskPressure,
	diskThresholds,
	FILL_HORIZON_MS,
	fillRate,
	type LastCleanup,
	trimSamples,
	VM_MIN_FREE_BYTES,
	vmCleanupGoal,
	vmDiskThresholds,
} from "./disk";
import {
	createNodeDriver,
	detectPlatform,
	type NodeDriver,
	type NodeProbe,
	readLinuxFacts,
	readMacStatus,
} from "./driver";
import {
	linuxFirewallApplyScript,
	linuxFirewallClearScript,
	MAC_FIREWALL_HELPER,
	parseFirewallStatus,
} from "./firewall";
import {
	checkToken,
	createGithubRunnerClient,
	decodeJitConfig,
	type GithubRunner,
	type GithubRunnerAuth,
	type GithubRunnerClient,
	isPermanentGithubError,
	listRunnerReleases,
	type RunnerRelease,
	resolveLimaRelease,
	resolveRunnerRelease,
} from "./github-api";
import {
	LIMA_VERSION,
	MAC_BOOT_SCRIPT_VERSION,
	macCreateVmScript,
	macDeleteVmScript,
	macInstallLimaScript,
	macResizeVmScript,
	macStartVmScript,
	macStopVmScript,
	macWriteBootScript,
} from "./macos";
import {
	fetchOsReleases,
	linuxOsReportScript,
	macOsReportScript,
	type OsRelease,
	osPatchScript,
	osProduct,
	parseOsReport,
	parsePatchResult,
} from "./os";
import {
	type PlacementMachine,
	placeWaitingRunners,
	type WaitingTarget,
} from "./placement";
import {
	parseBenchmark,
	parseCaches,
	parseCleanup,
	type RuntimeStatus,
} from "./probe";
import {
	isKillDrain,
	isRunnerOf,
	isStale,
	type PlannedAction,
	planNode,
	runnerNamePrefix,
} from "./reconcile";
import { decideRerun, initialRerunStatus } from "./rerun";
import { canaryProgress, rolloutGate, UPDATE_KIND_LABELS } from "./rollout";
import {
	decideRouting,
	fallbackRunsOn,
	REROUTE_MIN_QUEUED_MS,
	ROUTING_RETRY_MS,
	routingSyncDue,
	waitsForPool,
} from "./routing";
import {
	CONTROLLER_SEEN,
	installRuntimeScript,
	MIN_RUNTIME_VERSION,
	RUNNERCTL,
	RUNTIME_VERSION,
	runnerEnvironment,
	shellQuote,
} from "./runtime";
import {
	closeSharedSessions,
	type NodeSession,
	openNodeSession,
	sharedNodeSession,
} from "./ssh";
import {
	effectiveUpdatePolicy,
	type UpdateReason,
	updateDecision,
	updateWindowEnd,
} from "./updates";
import { type RunnerReleaseInfo, runnerVersionStatus } from "./versions";

const GiB = 1024 ** 3;
export const TICK_MS = 5_000;
/**
 * Leases on a machine are short and renewed while held: when the process
 * holding one dies, another instance takes the machine over within a minute
 * and a half.
 */
const TICK_LEASE_MS = 90_000;
const TASK_LEASE_MS = 90_000;
const LEASE_RENEW_MS = 30_000;
/** The leader renews its lease every heartbeat; it expires after this long. */
const LEADER_TTL_S = 20;
const HEARTBEAT_MS = 5_000;
/** Work left running by a process that died is recovered this often. */
const ORPHANS_EVERY_MS = 60_000;
const METRIC_EVERY_MS = 30_000;
const CACHES_EVERY_MS = 10 * 60_000;
const ROUTINE_CLEANUP_EVERY_MS = 6 * 60 * 60_000;
const BENCHMARK_EVERY_MS = 6 * 60 * 60_000;
const BENCHMARK_RETRY_MS = 30 * 60_000;
const MAX_CLEANUPS = 20;
const HEAL_EVERY_MS = 5 * 60_000;
const RELEASE_TTL_MS = 6 * 60 * 60_000;
const METRIC_RETENTION_MS = 7 * 24 * 60 * 60_000;
/** Jobs and operations older than this go, except work still in progress. */
const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60_000;
const MAX_ARMS_PER_TICK = 4;
const MAX_EVENTS = 30;

/**
 * The server entry point and the Next.js API routes each evaluate their own copy
 * of this module in the same process (like the deployment queue), so every piece
 * of controller state lives on globalThis: an operator action and a tick must see
 * the same tasks, the same ticks and the same lease owner.
 */
interface ControllerState {
	owner: string;
	clients: Map<string, { key: string; client: GithubRunnerClient }>;
	releases: Map<string, { release: RunnerRelease; at: number }>;
	tasks: Map<string, Promise<void>>;
	ticking: Set<string>;
	counters: Map<
		string,
		{
			at: number;
			usage: number | null;
			busy: number | null;
			total: number | null;
		}
	>;
	lastMetricAt: Map<string, number>;
	lastCachesAt: Map<string, number>;
	lastHealAt: Map<string, number>;
	lastRecoveryAt: Map<string, number>;
	/** A drain whose completion failed waits until then before trying again. */
	drainRetryAt: Map<string, number>;
	/** Runners of each pool as GitHub listed them at the last tick. */
	poolRunners: Map<string, { at: number; runners: GithubRunner[] }>;
	/** Repositories a pool routes jobs for, refreshed hourly. */
	repositories: Map<string, { at: number; names: string[] }>;
	lastRerouteScan: Map<string, number>;
	/** Pools whose reroute scan runs, in the background. */
	rerouteScans: Set<string>;
	/** Machines that did not answer: tried again in the background, not by the tick. */
	reconnects: Map<
		string,
		{
			failures: number;
			retryAt: number;
			probing: boolean;
			/** Last "Retry now" acted on (epoch ms). */
			requestSeen?: number;
		}
	>;
	lastBenchmarkAt: Map<string, number>;
	/** Free space seen by the last ticks, for the fill rate (VM disk on a Mac). */
	diskSamples: Map<string, { host: DiskSample[]; vm: DiskSample[] }>;
	lastCleanups: Map<string, LastCleanup>;
	/** Messages of background tasks, added to the events by the next tick. */
	pendingEvents: Map<string, { at: string; message: string }[]>;
	timer: NodeJS.Timeout | null;
	running: boolean;
	rerun: boolean;
	lastPurge: number;
	pendingTick: NodeJS.Timeout | null;
	/** actions/runner releases, to tell machines left on an older one. */
	runnerReleases: { at: number; releases: RunnerReleaseInfo[] } | null;
	runnerReleasesTriedAt: number;
	/** Last OS report of each machine. */
	osReportAt: Map<string, number>;
	/** Support dates of each OS product (endoflife.date). */
	osReleases: Map<string, { at: number; releases: OsRelease[] }>;
	osReleasesTriedAt: Map<string, number>;
	/** What GitHub said of each pool's personal access token (by its hash). */
	tokenChecks: Map<
		string,
		{
			at: number;
			hash: string;
			result: { valid: boolean; expiresAt: string | null } | null;
		}
	>;
	lastAlertsAt: number;
	/** Firewalls attached to pools and machines, read once per tick. */
	firewalls: { at: number; value: RunnerFirewalls } | null;
	/** A firewall that failed to load waits until then before trying again. */
	firewallRetryAt: Map<string, number>;
	/** Leases this process holds, renewed until released. */
	leaseRenewals: Map<string, NodeJS.Timeout>;
	/** Hash of the firewall rules each machine must run its jobs behind; null for none. */
	firewallExpected: Map<string, string | null>;
	/** Autonomy settings last written on each machine. */
	autonomyApplied: Map<string, string>;
	/** Why each machine's update waits, as last told in its events. */
	updateWaiting: Map<string, string>;
	/** Whether this process leads: only the leader ticks. */
	leader: boolean;
	heartbeat: NodeJS.Timeout | null;
	kind: "dokploy" | "standalone";
	version: string | null;
	startedAt: string;
	lastOrphanCheck: number;
}

const shared = globalThis as { __dokployGithubRunners?: ControllerState };
shared.__dokployGithubRunners ??= {
	owner: `${hostname()}:${process.pid}:${randomBytes(3).toString("hex")}`,
	clients: new Map(),
	releases: new Map(),
	tasks: new Map(),
	ticking: new Set(),
	counters: new Map(),
	lastMetricAt: new Map(),
	lastCachesAt: new Map(),
	lastHealAt: new Map(),
	lastRecoveryAt: new Map(),
	drainRetryAt: new Map(),
	poolRunners: new Map(),
	repositories: new Map(),
	lastRerouteScan: new Map(),
	rerouteScans: new Set(),
	reconnects: new Map(),
	lastBenchmarkAt: new Map(),
	diskSamples: new Map(),
	lastCleanups: new Map(),
	pendingEvents: new Map(),
	timer: null,
	running: false,
	rerun: false,
	lastPurge: 0,
	pendingTick: null,
	runnerReleases: null,
	runnerReleasesTriedAt: 0,
	osReportAt: new Map(),
	osReleases: new Map(),
	osReleasesTriedAt: new Map(),
	tokenChecks: new Map(),
	lastAlertsAt: 0,
	firewalls: null,
	firewallRetryAt: new Map(),
	leaseRenewals: new Map(),
	firewallExpected: new Map(),
	autonomyApplied: new Map(),
	updateWaiting: new Map(),
	leader: false,
	heartbeat: null,
	kind: "dokploy",
	version: null,
	startedAt: new Date().toISOString(),
	lastOrphanCheck: 0,
};
const state: ControllerState = shared.__dokployGithubRunners;
// State kept across a hot reload predates fields added since.
state.drainRetryAt ??= new Map();
state.runnerReleases ??= null;
state.runnerReleasesTriedAt ??= 0;
state.osReportAt ??= new Map();
state.osReleases ??= new Map();
state.osReleasesTriedAt ??= new Map();
state.tokenChecks ??= new Map();
state.lastAlertsAt ??= 0;
state.firewalls ??= null;
state.firewallRetryAt ??= new Map();
state.leaseRenewals ??= new Map();
state.firewallExpected ??= new Map();
state.autonomyApplied ??= new Map();
state.updateWaiting ??= new Map();
state.leader ??= false;
state.heartbeat ??= null;
state.kind ??= "dokploy";
state.version ??= null;
state.startedAt ??= new Date().toISOString();
state.lastOrphanCheck ??= 0;
state.rerouteScans ??= new Set();
state.reconnects ??= new Map();
const OWNER = state.owner;

type NodeWithRelations = GithubRunnerNode & {
	pool: GithubRunnerPool;
	sshKey: { privateKey: string } | null;
};

/** Sends a notice in the background: notification channels can be slow. */
const notify = (pool: GithubRunnerPool, notice: RunnerNotice) => {
	void sendGithubRunnerNotifications(pool.organizationId, notice).catch(
		(error) =>
			console.error(
				`GitHub runner notification failed for ${pool.name}`,
				error,
			),
	);
};

// ---------------------------------------------------------------- loading

export const loadRunnerNode = async (nodeId: string) => {
	const node = await db.query.githubRunnerNodes.findFirst({
		where: eq(githubRunnerNodes.githubRunnerNodeId, nodeId),
		with: { pool: true, sshKey: { columns: { privateKey: true } } },
	});
	if (!node) throw new Error("Runner machine not found");
	return node as NodeWithRelations;
};

export const poolAuth = async (
	pool: GithubRunnerPool,
): Promise<GithubRunnerAuth> => {
	if (pool.authType === "token") {
		if (!pool.token) throw new Error(`Pool ${pool.name} has no token`);
		return { type: "token", token: pool.token };
	}
	if (pool.authType === "app") {
		if (!pool.appId || !pool.appInstallationId || !pool.appPrivateKey) {
			throw new Error(`Pool ${pool.name} has an incomplete GitHub App`);
		}
		return {
			type: "app",
			appId: pool.appId,
			installationId: pool.appInstallationId,
			privateKey: pool.appPrivateKey,
		};
	}
	const provider = pool.githubId
		? await db.query.github.findFirst({
				where: eq(github.githubId, pool.githubId),
			})
		: null;
	if (
		!provider?.githubAppId ||
		!provider.githubInstallationId ||
		!provider.githubPrivateKey
	) {
		throw new Error(
			`The GitHub provider of pool ${pool.name} is missing or not installed`,
		);
	}
	return {
		type: "app",
		appId: provider.githubAppId,
		installationId: provider.githubInstallationId,
		privateKey: provider.githubPrivateKey,
	};
};

const clients = state.clients;

/** One client per pool, so a GitHub App installation token is reused until it expires. */
export const poolClient = async (pool: GithubRunnerPool) => {
	const auth = await poolAuth(pool);
	const key = createHash("sha256")
		.update(
			JSON.stringify([
				auth,
				pool.scope,
				pool.owner,
				pool.repository,
				pool.runnerGroup,
				pool.apiUrl,
			]),
		)
		.digest("hex");
	const cached = clients.get(pool.githubRunnerPoolId);
	if (cached?.key === key) return cached.client;
	const client = createGithubRunnerClient(
		{
			scope: pool.scope,
			owner: pool.owner,
			repository: pool.repository,
			runnerGroup: pool.runnerGroup,
			apiUrl: pool.apiUrl,
		},
		auth,
	);
	clients.set(pool.githubRunnerPoolId, { key, client });
	return client;
};

const releases = state.releases;

export const desiredRelease = async (
	pool: GithubRunnerPool,
	arch: string,
): Promise<RunnerRelease> => {
	const key = `${pool.runnerVersion ?? "latest"}:${arch}`;
	const cached = releases.get(key);
	if (
		cached &&
		(pool.runnerVersion || Date.now() - cached.at < RELEASE_TTL_MS)
	) {
		return cached.release;
	}
	const authorization =
		new URL(pool.apiUrl).hostname === "api.github.com"
			? await (await poolClient(pool)).authorization().catch(() => undefined)
			: undefined;
	const release = await resolveRunnerRelease(pool.runnerVersion, arch, {
		authorization,
	});
	releases.set(key, { release, at: Date.now() });
	return release;
};

/** The pinned Lima release for a Mac, resolved once per architecture. */
const limaRelease = async (pool: GithubRunnerPool, arch: string) => {
	const key = `lima:${LIMA_VERSION}:${arch}`;
	const cached = releases.get(key);
	if (cached) return cached.release;
	const authorization =
		new URL(pool.apiUrl).hostname === "api.github.com"
			? await (await poolClient(pool)).authorization().catch(() => undefined)
			: undefined;
	const release = await resolveLimaRelease(LIMA_VERSION, arch, {
		authorization,
	});
	releases.set(key, { release, at: Date.now() });
	return release;
};

/** Installs Dokploy's own Lima for the account it logs in with, when missing or older. */
const ensureLima = async (
	node: NodeWithRelations,
	driver: NodeDriver,
	status: {
		limaVersion: string | null;
		limaManaged: boolean;
		host: { arch: string } | null;
	},
	log: (line: string) => Promise<void>,
) => {
	if (status.limaManaged && status.limaVersion === LIMA_VERSION) return;
	const release = await limaRelease(node.pool, status.host?.arch ?? "arm64");
	await log(
		`Installing Lima ${release.version} for ${node.username} (verified SHA-256)`,
	);
	await driver.host(macInstallLimaScript(release), {
		timeoutMs: 10 * 60_000,
		label: "Lima installation",
	});
};

const archLabel = (arch: string) =>
	arch === "aarch64" || arch === "arm64" ? "ARM64" : "X64";

/** Labels every runner of the machine is registered with. */
export const runnerLabels = (
	pool: GithubRunnerPool,
	node: GithubRunnerNode,
	arch: string,
) => {
	const labels = [
		"self-hosted",
		"Linux",
		archLabel(arch),
		...pool.labels,
		...node.extraLabels,
		`dokploy-${node.name}`,
	];
	const seen = new Set<string>();
	return labels.filter((label) => {
		const key = label.toLowerCase();
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
};

export const environmentHash = (pool: GithubRunnerPool) =>
	createHash("sha256")
		.update(runnerEnvironment(pool))
		.digest("hex")
		.slice(0, 16);

/** The key of the machine itself (enrolled machines), or the shared SSH key. */
export const nodePrivateKey = (
	node: GithubRunnerNode & { sshKey?: { privateKey: string } | null },
) => {
	const key = node.sshPrivateKey ?? node.sshKey?.privateKey;
	if (!key) throw new Error(`Runner machine ${node.name} has no SSH key`);
	return key;
};

/** Ticks and tasks share one connection per machine. */
const connect = (node: NodeWithRelations) =>
	sharedNodeSession({
		name: node.name,
		host: node.host,
		port: node.port,
		username: node.username,
		privateKey: nodePrivateKey(node),
		hostKeyFingerprint: node.hostKeyFingerprint,
	});

// ------------------------------------------------------- leases and queues

const takeLease = async (nodeId: string, durationMs: number) => {
	const now = new Date();
	const rows = await db
		.update(githubRunnerNodes)
		.set({
			lockedBy: OWNER,
			lockedUntil: new Date(now.getTime() + durationMs).toISOString(),
		})
		.where(
			and(
				eq(githubRunnerNodes.githubRunnerNodeId, nodeId),
				or(
					isNull(githubRunnerNodes.lockedUntil),
					lt(githubRunnerNodes.lockedUntil, now.toISOString()),
					eq(githubRunnerNodes.lockedBy, OWNER),
				),
			),
		)
		.returning({ id: githubRunnerNodes.githubRunnerNodeId });
	return rows.length > 0;
};

const stopRenewing = (nodeId: string) => {
	const timer = state.leaseRenewals.get(nodeId);
	if (timer) clearInterval(timer);
	state.leaseRenewals.delete(nodeId);
};

/** Leases a machine, and keeps the lease alive until it is released. */
const acquireLease = async (nodeId: string, durationMs: number) => {
	if (!(await takeLease(nodeId, durationMs))) return false;
	if (!state.leaseRenewals.has(nodeId)) {
		const timer = setInterval(() => {
			void takeLease(nodeId, durationMs)
				.then((kept) => {
					if (kept) return;
					// Another instance took it after an outage: let the work end.
					stopRenewing(nodeId);
					console.error(`GitHub runners: lost the lease on machine ${nodeId}`);
				})
				.catch(() => undefined);
		}, LEASE_RENEW_MS);
		timer.unref?.();
		state.leaseRenewals.set(nodeId, timer);
	}
	return true;
};

const releaseLease = (nodeId: string) => {
	stopRenewing(nodeId);
	return db
		.update(githubRunnerNodes)
		.set({ lockedBy: null, lockedUntil: null })
		.where(
			and(
				eq(githubRunnerNodes.githubRunnerNodeId, nodeId),
				eq(githubRunnerNodes.lockedBy, OWNER),
			),
		);
};

/**
 * An operation started from a process that does not lead waits for the
 * leader's tick to let the machine go: a tick holds it a few seconds.
 */
const LEASE_WAIT_MS = 2 * 60_000;

const waitForLease = async (
	nodeId: string,
	log: (line: string) => Promise<void>,
) => {
	const deadline = Date.now() + LEASE_WAIT_MS;
	let told = false;
	for (;;) {
		if (await acquireLease(nodeId, TASK_LEASE_MS)) return true;
		if (Date.now() >= deadline) return false;
		if (!told) {
			told = true;
			await log("Waiting for another Dokploy instance to let the machine go");
		}
		await new Promise((resolve) => setTimeout(resolve, 1_000));
	}
};

/** Long tasks of a machine (provisioning, VM restart...). The tick skips the machine meanwhile. */
const tasks = state.tasks;
const ticking = state.ticking;

const waitForTick = async (nodeId: string) => {
	for (let attempt = 0; attempt < 600 && ticking.has(nodeId); attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
};

/**
 * Runs a task with the machine leased and an SSH session open. Returns false
 * when another task already runs on the machine.
 */
const runTask = (
	nodeId: string,
	operationId: string | null,
	task: (context: {
		node: NodeWithRelations;
		driver: NodeDriver;
		session: NodeSession;
		log: (line: string) => Promise<void>;
	}) => Promise<void>,
	onError?: (error: unknown) => Promise<void>,
) => {
	if (tasks.has(nodeId)) return false;
	const log = (line: string) => appendOperationLog(operationId, line);
	const promise = (async () => {
		await waitForTick(nodeId);
		let session: NodeSession | null = null;
		let keepalive: NodeJS.Timeout | null = null;
		const leased = await waitForLease(nodeId, log);
		try {
			if (!leased) {
				throw new Error(
					`Another Dokploy instance has been working on this machine for ${LEASE_WAIT_MS / 60_000} minutes: try again later`,
				);
			}
			const node = await loadRunnerNode(nodeId);
			session = await connect(node);
			// It answers: the tick observes it again without waiting for a retry.
			state.reconnects.delete(nodeId);
			const driver = createNodeDriver(session, node);
			// A long task holds the machine without probing it: it still tells
			// the machine a controller is there, so it does not arm itself.
			keepalive = setInterval(() => {
				void driver
					.guest(`sh -c 'touch ${CONTROLLER_SEEN} 2>/dev/null || true'`, {
						label: "Keepalive",
						timeoutMs: 20_000,
						allowFailure: true,
					})
					.catch(() => undefined);
			}, 30_000);
			await task({ node, driver, session, log });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await log(`Error: ${message}`);
			if (onError) await onError(error);
			else {
				await finishOperation(operationId, "error", message);
				await db
					.update(githubRunnerNodes)
					.set({ lastError: message })
					.where(eq(githubRunnerNodes.githubRunnerNodeId, nodeId));
			}
		} finally {
			if (keepalive) clearInterval(keepalive);
			session?.close();
			if (leased) await releaseLease(nodeId);
		}
	})()
		.catch((error) => console.error("GitHub runner task failed", error))
		.finally(() => {
			tasks.delete(nodeId);
			requestTick();
		});
	tasks.set(nodeId, promise);
	return true;
};

// ------------------------------------------------------------- operations

const timestamp = () => new Date().toISOString().slice(11, 19);

/** Characters of log kept per operation. */
const MAX_OPERATION_LOG = 200_000;

export const appendOperationLog = async (
	operationId: string | null,
	line: string,
) => {
	if (!operationId) return;
	const text = line
		.split("\n")
		.filter((item) => item.trim())
		.map((item) => `[${timestamp()}] ${item}\n`)
		.join("");
	if (!text) return;
	await db
		.update(githubRunnerOperations)
		// Only the end is kept: a long install log cannot grow without bound.
		.set({
			logs: sql`right(${githubRunnerOperations.logs} || ${text}, ${MAX_OPERATION_LOG})`,
		})
		.where(eq(githubRunnerOperations.githubRunnerOperationId, operationId));
};

export const finishOperation = async (
	operationId: string | null,
	status: "done" | "error" | "cancelled",
	errorMessage?: string,
) => {
	if (!operationId) return;
	await db
		.update(githubRunnerOperations)
		.set({
			status,
			errorMessage: errorMessage ?? null,
			finishedAt: new Date().toISOString(),
		})
		.where(
			and(
				eq(githubRunnerOperations.githubRunnerOperationId, operationId),
				eq(githubRunnerOperations.status, "running"),
			),
		);
};

/** Starts an operation; the running one of the machine, if any, is cancelled when superseded. */
export const createOperation = async (
	node: GithubRunnerNode,
	type: GithubRunnerOperation["type"],
	summary: string,
	userId: string | null,
	options: { supersede?: boolean } = {},
) => {
	const running = await db.query.githubRunnerOperations.findFirst({
		where: and(
			eq(githubRunnerOperations.githubRunnerNodeId, node.githubRunnerNodeId),
			eq(githubRunnerOperations.status, "running"),
		),
	});
	if (running) {
		if (!options.supersede) {
			throw new Error(
				`An operation (${running.type}) is already running on ${node.name}`,
			);
		}
		await appendOperationLog(
			running.githubRunnerOperationId,
			`Superseded by "${summary}"`,
		);
		await finishOperation(running.githubRunnerOperationId, "cancelled");
	}
	const [operation] = await db
		.insert(githubRunnerOperations)
		.values({
			organizationId: node.organizationId,
			githubRunnerNodeId: node.githubRunnerNodeId,
			githubRunnerPoolId: node.githubRunnerPoolId,
			nodeName: node.name,
			type,
			summary,
			createdBy: userId,
		})
		.returning();
	if (!operation) throw new Error("Unable to record the operation");
	return operation;
};

// ------------------------------------------------------------- checks

export interface NodeCheckResult {
	fingerprint: string;
	platform: string;
	host: { cpus: number; memoryBytes: number; arch: string; os: string } | null;
	checks: NodeCheck[];
	canProvision: boolean;
}

export const checkRunnerMachine = async (input: {
	name: string;
	host: string;
	port: number;
	username: string;
	privateKey: string;
	hostKeyFingerprint: string | null;
	/** Host keys the setup script reported, when no key is pinned yet. */
	knownHostKeys?: string[];
	platform: "linux" | "macos";
	vmName: string;
	vmDiskGb: number;
	diskReserveGb: number;
	diskCleanupGb: number;
	cpuPercent: number;
	memoryPercent: number;
	maxRunners: number;
}): Promise<NodeCheckResult> => {
	const session = await openNodeSession({
		name: input.name,
		host: input.host,
		port: input.port,
		username: input.username,
		privateKey: input.privateKey,
		hostKeyFingerprint: input.hostKeyFingerprint,
		knownHostKeys: input.knownHostKeys,
	});
	try {
		const detected = await detectPlatform(session);
		if (detected !== input.platform) {
			return {
				fingerprint: session.fingerprint,
				platform: detected,
				host: null,
				checks: [
					{
						id: "platform",
						label: "Platform",
						status: "fail",
						message: `The machine runs ${detected === "macos" ? "macOS" : detected}, not ${input.platform === "macos" ? "macOS" : "Linux"}`,
					},
				],
				canProvision: false,
			};
		}
		if (input.platform === "macos") {
			const status = await readMacStatus(session, input.vmName);
			const checks = macChecks(status, input);
			return {
				fingerprint: session.fingerprint,
				platform: "macos",
				host: status.host
					? {
							cpus: status.host.cpus,
							memoryBytes: status.host.memoryBytes,
							arch: status.host.arch,
							os: `macOS ${status.host.version}`,
						}
					: null,
				checks,
				canProvision: checks.every((item) => item.status !== "fail"),
			};
		}
		const facts = await readLinuxFacts(session);
		const checks = linuxChecks(facts, input);
		return {
			fingerprint: session.fingerprint,
			platform: "linux",
			host: {
				cpus: facts.cpus,
				memoryBytes: facts.memoryBytes,
				arch: facts.arch,
				os: `${facts.distro} ${facts.distroVersion}`,
			},
			checks,
			canProvision: checks.every((item) => item.status !== "fail"),
		};
	} finally {
		session.close();
	}
};

// ------------------------------------------------------------- provisioning

const installRuntime = async (
	driver: NodeDriver,
	log: (line: string) => Promise<void>,
) => {
	await log(`Installing the Dokploy runner runtime v${RUNTIME_VERSION}`);
	await driver.guest("bash -s", {
		input: installRuntimeScript(),
		timeoutMs: 20 * 60_000,
		label: "Runtime installation",
		onOutput: (chunk) => {
			for (const line of chunk.split("\n")) {
				if (line.startsWith("==> ") || line.startsWith("warning:")) {
					void log(line.replace(/^==> /, ""));
				}
			}
		},
	});
};

const installRelease = async (
	driver: NodeDriver,
	release: RunnerRelease,
	log: (line: string) => Promise<void>,
) => {
	await log(`Installing actions/runner ${release.version} (SHA-256 verified)`);
	await driver.guest(
		`${RUNNERCTL} install-release ${release.version} ${release.url} ${release.sha256}`,
		{ timeoutMs: 15 * 60_000, label: "Runner installation" },
	);
};

const writeEnvironment = (driver: NodeDriver, pool: GithubRunnerPool) =>
	driver.guest(`${RUNNERCTL} env`, {
		input: runnerEnvironment(pool),
		label: "Runner environment",
		timeoutMs: 60_000,
	});

const applySliceLimits = async (
	driver: NodeDriver,
	node: GithubRunnerNode,
	host: { cpus: number; memoryBytes: number },
	log?: (line: string) => Promise<void>,
) => {
	// On macOS the VM is the budget: the slice inside takes the whole VM.
	const limits =
		node.platform === "linux"
			? sliceLimits(host, node)
			: { cpuQuotaPercent: null, allowedCpus: null, memoryMaxBytes: null };
	await driver.guest(
		`${RUNNERCTL} limits ${limits.cpuQuotaPercent ?? "none"} ${limits.allowedCpus ?? "none"} ${limits.memoryMaxBytes ?? "none"}`,
		{ label: "Resource limits", timeoutMs: 60_000 },
	);
	if (log && node.platform === "linux") {
		const effective = effectiveBudget("linux", host, node);
		await log(
			`Budget applied: ${formatCpus(effective.cpus)}${limits.allowedCpus ? ` (${formatCpuList(limits.allowedCpus)})` : ""}, ${formatBytes(effective.memoryBytes)} memory`,
		);
	}
};

const startVm = async (
	driver: NodeDriver,
	node: GithubRunnerNode,
	log: (line: string) => Promise<void>,
) => {
	await log(`Starting VM ${node.vmName}`);
	await driver.host(macStartVmScript(node.vmName), {
		timeoutMs: 15 * 60_000,
		label: "VM start",
		onOutput: (chunk) => {
			for (const line of chunk.split("\n")) {
				const entry = limaLogLine(line);
				if (entry) void log(entry);
			}
		},
	});
};

/** Keeps the useful lines of limactl's logfmt output, as plain messages. */
export const limaLogLine = (line: string) => {
	const text = line.trim();
	if (!text) return null;
	const message = text
		.match(/msg="((?:[^"\\]|\\.)*)"/)?.[1]
		?.replace(/\\"/g, '"');
	const level = text.match(/level=(\w+)/)?.[1];
	if (message === undefined) {
		// Lines of the start script itself (stale PID files).
		return /^Removing /.test(text) ? text : null;
	}
	if (/^READY/.test(message)) return "VM ready";
	if (level === "error" || level === "fatal") return `Lima: ${message}`;
	return null;
};

/** Installs or refreshes everything on a machine, then marks it ready. */
const prepareMachine = async (
	node: NodeWithRelations,
	driver: NodeDriver,
	log: (line: string) => Promise<void>,
) => {
	let applied: GithubRunnerAppliedConfig | null = node.applied;
	let vmCreated = applied?.vmCreatedByDokploy ?? false;
	let host: { cpus: number; memoryBytes: number };

	if (node.platform === "macos") {
		const before = await readMacStatus(driver.session, node.vmName);
		await ensureLima(node, driver, before, log);
		const status = await readMacStatus(driver.session, node.vmName);
		if (!status.host) throw new Error("Unable to read the Mac facts");
		host = status.host;
		const size = vmSize(status.host, node);
		if (status.vm.status === "missing") {
			await log(
				`Creating VM ${node.vmName}: ${formatCpus(size.cpus)}, ${formatBytes(size.memoryBytes)}, ${node.vmDiskGb} GiB disk`,
			);
			await driver.host(
				macCreateVmScript(node.vmName, {
					cpus: size.cpus,
					memoryGiB: size.memoryGiB,
					diskGb: node.vmDiskGb,
				}),
				{ timeoutMs: 30 * 60_000, label: "VM creation" },
			);
			vmCreated = true;
			// Recorded now: removing the machine deletes this VM even when the
			// rest of the provisioning fails.
			await db
				.update(githubRunnerNodes)
				.set({
					applied: {
						...(applied ?? {
							runtimeVersion: 0,
							runnerVersion: "",
							cpuPercent: node.cpuPercent,
							memoryPercent: node.memoryPercent,
							vmDiskGb: node.vmDiskGb,
							cpus: size.cpus,
							memoryBytes: size.memoryBytes,
							envHash: "",
						}),
						vmCreatedByDokploy: true,
					},
				})
				.where(
					eq(githubRunnerNodes.githubRunnerNodeId, node.githubRunnerNodeId),
				);
		} else if (status.vm.status !== "Running") {
			await log(`Sizing VM ${node.vmName} to the budget`);
			await driver.host(
				macResizeVmScript(node.vmName, {
					cpus: size.cpus,
					memoryGiB: size.memoryGiB,
					diskGb:
						status.vm.diskBytes && node.vmDiskGb * GiB > status.vm.diskBytes
							? node.vmDiskGb
							: null,
				}),
				{ timeoutMs: 5 * 60_000, label: "VM resize" },
			);
		} else if (
			status.vm.cpus !== size.cpus ||
			status.vm.memoryBytes !== size.memoryBytes
		) {
			await log(
				`VM ${node.vmName} already runs with ${formatCpus(status.vm.cpus ?? 0)} and ${formatBytes(status.vm.memoryBytes ?? 0)}; apply the budget later to resize it (it restarts the VM)`,
			);
		}
		await startVm(driver, node, log);
		// The boot daemon of the setup script starts the VM after a reboot.
		await driver.host(macWriteBootScript(node.vmName), {
			timeoutMs: 30_000,
			label: "Boot script",
		});
		const after = await readMacStatus(driver.session, node.vmName);
		applied = {
			runtimeVersion: RUNTIME_VERSION,
			runnerVersion: "",
			cpuPercent: node.cpuPercent,
			memoryPercent: node.memoryPercent,
			vmDiskGb: node.vmDiskGb,
			cpus: after.vm.cpus ?? size.cpus,
			memoryBytes: after.vm.memoryBytes ?? size.memoryBytes,
			envHash: "",
			vmCreatedByDokploy: vmCreated,
		};
	} else {
		const facts = await readLinuxFacts(driver.session);
		host = { cpus: facts.cpus, memoryBytes: facts.memoryBytes };
		applied = null;
	}

	await installRuntime(driver, log);
	const probe = await driver.probe();
	const arch = probe.runtime?.host?.arch;
	if (!probe.runtime || !arch) {
		throw new Error(
			`The runtime does not answer after installation${probe.runtimeError ? `: ${probe.runtimeError}` : ""}`,
		);
	}
	const release = await desiredRelease(node.pool, arch);
	await installRelease(driver, release, log);
	await writeEnvironment(driver, node.pool);
	await applySliceLimits(driver, node, host, log);
	const effective = effectiveBudget(node.platform, host, node);
	const runners = resolveMaxRunners(node.maxRunners, node.platform, host, node);
	await log(
		`Ready: up to ${runners} concurrent job${runners === 1 ? "" : "s"} on ${formatCpus(effective.cpus)} and ${formatBytes(effective.memoryBytes)}`,
	);
	return {
		runtimeVersion: RUNTIME_VERSION,
		runnerVersion: release.version,
		cpuPercent: node.cpuPercent,
		memoryPercent: node.memoryPercent,
		vmDiskGb: node.platform === "macos" ? node.vmDiskGb : null,
		cpus: applied?.cpus ?? effective.cpus,
		memoryBytes: applied?.memoryBytes ?? effective.memoryBytes,
		envHash: environmentHash(node.pool),
		vmCreatedByDokploy: node.platform === "macos" ? vmCreated : undefined,
		bootScript: node.platform === "macos" ? MAC_BOOT_SCRIPT_VERSION : undefined,
	} satisfies GithubRunnerAppliedConfig;
};

export const provisionRunnerNode = async (
	nodeId: string,
	userId: string | null,
) => {
	const node = await loadRunnerNode(nodeId);
	if (node.phase === "enrolling") {
		throw new Error(
			`Run the setup script on ${node.name} and paste its code first`,
		);
	}
	// Refused before anything is written: the machine keeps its phase and the
	// running operation is not superseded.
	if (tasks.has(nodeId)) {
		throw new Error("Another task is running on this machine");
	}
	const operation = await createOperation(
		node,
		"provision",
		`Provision ${node.name}`,
		userId,
		{ supersede: true },
	);
	await db
		.update(githubRunnerNodes)
		.set({ phase: "provisioning", lastError: null })
		.where(eq(githubRunnerNodes.githubRunnerNodeId, nodeId));
	const started = runTask(
		nodeId,
		operation.githubRunnerOperationId,
		async ({ node, driver, log }) => {
			await log(`Connected to ${node.host} (${driver.session.fingerprint})`);
			const applied = await prepareMachine(node, driver, log);
			// The operator may have disabled the machine meanwhile: decide in the update.
			const [fresh] = await db
				.update(githubRunnerNodes)
				.set({
					applied,
					phase: sql`CASE WHEN ${githubRunnerNodes.enabled} THEN 'ready'::"githubRunnerNodePhase" ELSE 'stopped'::"githubRunnerNodePhase" END`,
					drain: null,
					lastError: null,
				})
				.where(eq(githubRunnerNodes.githubRunnerNodeId, nodeId))
				.returning({ enabled: githubRunnerNodes.enabled });
			if (!fresh?.enabled && node.platform === "macos") {
				await driver.host(macStopVmScript(node.vmName), {
					timeoutMs: 5 * 60_000,
					label: "VM stop",
				});
			}
			await finishOperation(operation.githubRunnerOperationId, "done");
		},
		async (error) => {
			const message = error instanceof Error ? error.message : String(error);
			await finishOperation(
				operation.githubRunnerOperationId,
				"error",
				message,
			);
			await db
				.update(githubRunnerNodes)
				.set({ phase: "error", lastError: message })
				.where(eq(githubRunnerNodes.githubRunnerNodeId, nodeId));
		},
	);
	if (!started) {
		// A task started while the operation was recorded: back to where it was.
		await finishOperation(
			operation.githubRunnerOperationId,
			"error",
			"Another task is running on this machine",
		);
		await db
			.update(githubRunnerNodes)
			.set({ phase: node.phase, lastError: node.lastError })
			.where(
				and(
					eq(githubRunnerNodes.githubRunnerNodeId, nodeId),
					eq(githubRunnerNodes.phase, "provisioning"),
				),
			);
		throw new Error("Another task is running on this machine");
	}
	return operation;
};

// ------------------------------------------------------------- user actions

/** Stops taking jobs; once the machine is empty its runtime (and VM) stop. */
export const disableRunnerNode = async (
	nodeId: string,
	options: { mode: "wait" | "kill"; timeoutMinutes: number | null },
	userId: string | null,
) => {
	const node = await loadRunnerNode(nodeId);
	if (node.phase === "stopped" || node.phase === "new") {
		await db
			.update(githubRunnerNodes)
			.set({ enabled: false })
			.where(eq(githubRunnerNodes.githubRunnerNodeId, nodeId));
		return null;
	}
	const operation = await createOperation(
		node,
		"disable",
		options.mode === "kill"
			? `Disable ${node.name} now (running jobs are interrupted)`
			: `Disable ${node.name} once its jobs finish${options.timeoutMinutes ? ` (at most ${options.timeoutMinutes} min)` : ""}`,
		userId,
		{ supersede: true },
	);
	const now = new Date();
	// A new drain does not wait for the retry delay of a previous one.
	state.drainRetryAt.delete(nodeId);
	await db
		.update(githubRunnerNodes)
		.set({
			enabled: false,
			phase: "draining",
			drain: {
				mode: options.mode,
				reason: "disable",
				requestedAt: now.toISOString(),
				deadline:
					options.mode === "wait" && options.timeoutMinutes
						? new Date(
								now.getTime() + options.timeoutMinutes * 60_000,
							).toISOString()
						: null,
				operationId: operation.githubRunnerOperationId,
			},
		})
		.where(eq(githubRunnerNodes.githubRunnerNodeId, nodeId));
	await appendOperationLog(
		operation.githubRunnerOperationId,
		options.mode === "kill"
			? "No new job; stopping the runners now"
			: "No new job; waiting for the running jobs to finish",
	);
	requestTick();
	return operation;
};

export const enableRunnerNode = async (
	nodeId: string,
	userId: string | null,
) => {
	const node = await loadRunnerNode(nodeId);
	if (node.phase === "new" || node.phase === "error" || !node.applied) {
		await db
			.update(githubRunnerNodes)
			.set({ enabled: true })
			.where(eq(githubRunnerNodes.githubRunnerNodeId, nodeId));
		return provisionRunnerNode(nodeId, userId);
	}
	const operation = await createOperation(
		node,
		"enable",
		`Enable ${node.name}`,
		userId,
		{ supersede: true },
	);
	await db
		.update(githubRunnerNodes)
		.set({ enabled: true, drain: null })
		.where(eq(githubRunnerNodes.githubRunnerNodeId, nodeId));
	if (node.phase === "ready" || node.phase === "draining") {
		await db
			.update(githubRunnerNodes)
			.set({ phase: "ready" })
			.where(eq(githubRunnerNodes.githubRunnerNodeId, nodeId));
		await appendOperationLog(
			operation.githubRunnerOperationId,
			"Draining cancelled: the machine takes jobs again",
		);
		await finishOperation(operation.githubRunnerOperationId, "done");
		requestTick();
		return operation;
	}
	runTask(
		nodeId,
		operation.githubRunnerOperationId,
		async ({ node, driver, log }) => {
			if (node.platform === "macos") {
				await startVm(driver, node, log);
			}
			const probe = await driver.probe();
			if (!probe.runtime || probe.runtime.runtimeVersion < RUNTIME_VERSION) {
				await installRuntime(driver, log);
			}
			await log("The machine takes jobs again");
			await db
				.update(githubRunnerNodes)
				.set({ phase: "ready", lastError: null })
				.where(eq(githubRunnerNodes.githubRunnerNodeId, nodeId));
			await finishOperation(operation.githubRunnerOperationId, "done");
		},
	);
	return operation;
};

/** Whether the new settings need the macOS VM to restart. */
export const needsVmRestart = (
	node: GithubRunnerNode,
	host: { cpus: number; memoryBytes: number } | null,
) => {
	if (node.platform !== "macos" || !node.applied || !host) return false;
	const size = vmSize(host, node);
	return (
		size.cpus !== node.applied.cpus ||
		size.memoryBytes !== node.applied.memoryBytes ||
		node.vmDiskGb > (node.applied.vmDiskGb ?? 0)
	);
};

/**
 * Applies the budget of a machine. Linux limits change live; a Mac drains (or
 * interrupts its jobs) and restarts its VM with the new size.
 */
export const applyRunnerNodeConfig = async (
	nodeId: string,
	mode: "wait" | "kill",
	userId: string | null,
) => {
	const node = await loadRunnerNode(nodeId);
	const host = node.observed?.host ?? null;
	if (node.phase === "new" || node.phase === "provisioning") return null;

	if (node.platform === "macos" && needsVmRestart(node, host)) {
		if (node.phase === "stopped") {
			const operation = await createOperation(
				node,
				"apply",
				`Resize the VM of ${node.name}`,
				userId,
				{ supersede: true },
			);
			runTask(
				nodeId,
				operation.githubRunnerOperationId,
				async ({ node, driver, log }) => {
					await resizeStoppedVm(node, driver, log);
					await finishOperation(operation.githubRunnerOperationId, "done");
				},
			);
			return operation;
		}
		const operation = await createOperation(
			node,
			"apply",
			mode === "kill"
				? `Resize the VM of ${node.name} now (running jobs are interrupted)`
				: `Resize the VM of ${node.name} once its jobs finish`,
			userId,
			{ supersede: true },
		);
		// A new drain does not wait for the retry delay of a previous one.
		state.drainRetryAt.delete(nodeId);
		await db
			.update(githubRunnerNodes)
			.set({
				phase: "draining",
				drain: {
					mode,
					reason: "apply",
					requestedAt: new Date().toISOString(),
					deadline: null,
					operationId: operation.githubRunnerOperationId,
				},
			})
			.where(eq(githubRunnerNodes.githubRunnerNodeId, nodeId));
		await appendOperationLog(
			operation.githubRunnerOperationId,
			"The VM restarts with its new size once no job runs",
		);
		requestTick();
		return operation;
	}

	if (node.platform === "linux" && node.phase !== "error") {
		const operation = await createOperation(
			node,
			"apply",
			`Apply the budget of ${node.name}`,
			userId,
			{ supersede: true },
		);
		runTask(
			nodeId,
			operation.githubRunnerOperationId,
			async ({ node, driver, log }) => {
				const probe = await driver.probe();
				if (!probe.host) throw new Error("Unable to read the machine facts");
				await applySliceLimits(driver, node, probe.host, log);
				await db
					.update(githubRunnerNodes)
					.set({
						applied: node.applied
							? {
									...node.applied,
									cpuPercent: node.cpuPercent,
									memoryPercent: node.memoryPercent,
								}
							: node.applied,
					})
					.where(eq(githubRunnerNodes.githubRunnerNodeId, nodeId));
				await finishOperation(operation.githubRunnerOperationId, "done");
			},
		);
		return operation;
	}
	requestTick();
	return null;
};

const resizeStoppedVm = async (
	node: NodeWithRelations,
	driver: NodeDriver,
	log: (line: string) => Promise<void>,
) => {
	const status = await readMacStatus(driver.session, node.vmName);
	if (!status.host) throw new Error("Unable to read the Mac facts");
	const size = vmSize(status.host, node);
	await log(
		`Resizing VM ${node.vmName} to ${formatCpus(size.cpus)} and ${formatBytes(size.memoryBytes)}`,
	);
	await driver.host(
		macResizeVmScript(node.vmName, {
			cpus: size.cpus,
			memoryGiB: size.memoryGiB,
			diskGb:
				status.vm.diskBytes && node.vmDiskGb * GiB > status.vm.diskBytes
					? node.vmDiskGb
					: null,
		}),
		{ timeoutMs: 5 * 60_000, label: "VM resize" },
	);
	await db
		.update(githubRunnerNodes)
		.set({
			applied: {
				...(node.applied as GithubRunnerAppliedConfig),
				cpuPercent: node.cpuPercent,
				memoryPercent: node.memoryPercent,
				vmDiskGb: Math.max(node.vmDiskGb, node.applied?.vmDiskGb ?? 0),
				cpus: size.cpus,
				memoryBytes: size.memoryBytes,
			},
		})
		.where(eq(githubRunnerNodes.githubRunnerNodeId, node.githubRunnerNodeId));
};

export const removeRunnerNode = async (
	nodeId: string,
	options: {
		mode: "wait" | "kill";
		uninstall: boolean;
		force: boolean;
		timeoutMinutes?: number | null;
	},
	userId: string | null,
) => {
	const node = await loadRunnerNode(nodeId);
	// A failed provisioning may have installed things: only a machine Dokploy
	// never worked on (or one still being provisioned) is forgotten right away.
	const untouched =
		node.phase === "new" ||
		node.phase === "enrolling" ||
		(node.phase === "provisioning" && !node.applied);
	if (options.force || untouched) {
		// Nothing to drain, or the machine is gone: unregister and forget it.
		await forgetRegistrations(node).catch(() => undefined);
		await db
			.delete(githubRunnerNodes)
			.where(eq(githubRunnerNodes.githubRunnerNodeId, nodeId));
		return null;
	}
	const operation = await createOperation(
		node,
		"remove",
		`Remove ${node.name}${options.uninstall ? " and uninstall its runtime" : ""}`,
		userId,
		{ supersede: true },
	);
	// A new drain does not wait for the retry delay of a previous one.
	state.drainRetryAt.delete(nodeId);
	await db
		.update(githubRunnerNodes)
		.set({
			enabled: false,
			phase: "draining",
			drain: {
				mode: options.mode,
				reason: "remove",
				requestedAt: new Date().toISOString(),
				deadline:
					options.mode === "wait" && options.timeoutMinutes
						? new Date(
								Date.now() + options.timeoutMinutes * 60_000,
							).toISOString()
						: null,
				operationId: operation.githubRunnerOperationId,
				uninstall: options.uninstall,
			},
		})
		.where(eq(githubRunnerNodes.githubRunnerNodeId, nodeId));
	await appendOperationLog(
		operation.githubRunnerOperationId,
		options.mode === "kill"
			? "Stopping the runners now"
			: "Waiting for the running jobs to finish",
	);
	// A full provisioning records the runner version: without it the machine
	// was never ready and started no runner.
	const neverReady = !node.applied?.runnerVersion;
	if (node.phase === "stopped" || neverReady) {
		// Nothing runs: finish right away.
		startDrainCompletion(nodeId);
	}
	requestTick();
	return operation;
};

const forgetRegistrations = async (node: NodeWithRelations) => {
	const client = await poolClient(node.pool);
	const prefix = runnerNamePrefix(node.name);
	const runners = await client.listRunners();
	await Promise.all(
		runners
			.filter((runner) => isRunnerOf(prefix, runner.name))
			.map((runner) => client.deleteRunner(runner.id)),
	);
};

type TaskContext = Parameters<Parameters<typeof runTask>[2]>[0];

/** A failed drain completion is tried again after this long, not every tick. */
const DRAIN_RETRY_MS = 60_000;

/**
 * Finishes a drain: the machine is empty, do what the drain was for. A failure
 * goes to the drain's operation, which stays open while it is retried.
 */
const startDrainCompletion = (nodeId: string) => {
	if (Date.now() < (state.drainRetryAt.get(nodeId) ?? 0)) return false;
	let operationId: string | null = null;
	return runTask(
		nodeId,
		null,
		async (context) => {
			operationId = context.node.drain?.operationId ?? null;
			await completeDrain(context);
			state.drainRetryAt.delete(nodeId);
		},
		async (error) => {
			const message = error instanceof Error ? error.message : String(error);
			state.drainRetryAt.set(nodeId, Date.now() + DRAIN_RETRY_MS);
			await appendOperationLog(
				operationId,
				`Error: ${message}. Trying again in a minute.`,
			);
			await db
				.update(githubRunnerNodes)
				.set({ lastError: message })
				.where(eq(githubRunnerNodes.githubRunnerNodeId, nodeId));
		},
	);
};

/**
 * The drain a completion was started for, as long as it is the machine's
 * current one: the operator may enable the machine again, or start another
 * drain, while the completion stops or deletes the VM.
 */
export const currentDrain = (nodeId: string, drain: GithubRunnerDrain) =>
	and(
		eq(githubRunnerNodes.githubRunnerNodeId, nodeId),
		eq(githubRunnerNodes.phase, "draining"),
		sql`${githubRunnerNodes.drain}->>'requestedAt' = ${drain.requestedAt}`,
		sql`${githubRunnerNodes.drain}->>'operationId' IS NOT DISTINCT FROM ${drain.operationId}`,
	);

/** Ends the drain unless the operator changed course meanwhile; false then. */
const endDrain = async (
	nodeId: string,
	drain: GithubRunnerDrain,
	phase: "ready" | "stopped",
) =>
	(
		await db
			.update(githubRunnerNodes)
			.set({ phase, drain: null })
			.where(currentDrain(nodeId, drain))
			.returning({ id: githubRunnerNodes.githubRunnerNodeId })
	).length > 0;

export const completeDrain = async ({ node, driver }: TaskContext) => {
	const nodeId = node.githubRunnerNodeId;
	const drain = node.drain;
	if (!drain) return;
	const operationId = drain.operationId;
	const log = (line: string) => appendOperationLog(operationId, line);
	const stopVm = () =>
		driver.host(macStopVmScript(node.vmName), {
			timeoutMs: 5 * 60_000,
			label: "VM stop",
		});
	if (drain.reason === "patch") {
		await finishPatch({ node, driver } as TaskContext, drain);
		return;
	}
	if (drain.reason === "disable") {
		if (node.platform === "macos") {
			await log(`All runners stopped; shutting VM ${node.vmName} down`);
			await stopVm();
		}
		if (!(await endDrain(nodeId, drain, "stopped"))) {
			const fresh = await loadRunnerNode(nodeId);
			await log("The machine was enabled again meanwhile: it is not disabled");
			// The VM was just stopped: started again for the jobs.
			if (fresh.enabled && node.platform === "macos") {
				await startVm(driver, node, log);
			}
			return;
		}
		await log("Machine disabled: it takes no job until it is enabled again");
		await finishOperation(operationId, "done");
		notify(node.pool, {
			event: "info",
			severity: "info",
			title: `${node.name} is disabled`,
			message:
				drain.mode === "kill"
					? `Its jobs were stopped: ${node.name} takes no job until it is enabled again.`
					: `Its last jobs finished: ${node.name} takes no job until it is enabled again.`,
			pool: node.pool.name,
			machine: node.name,
			at: new Date(),
		});
		return;
	}
	if (drain.reason === "apply") {
		if (node.platform === "macos") {
			await log(`No job runs; restarting VM ${node.vmName} with its new size`);
			await driver.host(macStopVmScript(node.vmName), {
				timeoutMs: 5 * 60_000,
				label: "VM stop",
			});
			await resizeStoppedVm(node, driver, log);
			await startVm(driver, node, log);
		}
		const fresh = await loadRunnerNode(nodeId);
		if (!(await endDrain(nodeId, drain, fresh.enabled ? "ready" : "stopped"))) {
			// Another drain took over: it decides what the VM does next.
			await log("New budget applied; another action took over the machine");
			return;
		}
		if (!fresh.enabled && node.platform === "macos") await stopVm();
		await log("New budget applied");
		await finishOperation(operationId, "done");
		return;
	}
	// remove
	await log("Unregistering the runners from GitHub");
	await forgetRegistrations(node).catch((error) =>
		// Its runners are ephemeral: GitHub drops them once they stay offline.
		log(
			`Could not unregister the runners (${error instanceof Error ? error.message : String(error)}); GitHub removes them once they stay offline`,
		),
	);
	// Set once the machine no longer runs what Dokploy installed.
	let uninstalled = false;
	if (drain.uninstall && node.firewall?.hash) {
		await log("Removing the firewall of the jobs");
		await clearFirewall(driver, node.platform).catch((error) =>
			log(
				`Could not remove the firewall (${error instanceof Error ? error.message : String(error)})`,
			),
		);
	}
	if (drain.uninstall) {
		if (node.platform === "macos" && node.applied?.vmCreatedByDokploy) {
			await log(`Deleting VM ${node.vmName}`);
			uninstalled = true;
			await driver.host(macDeleteVmScript(node.vmName), {
				timeoutMs: 10 * 60_000,
				label: "VM deletion",
			});
		} else {
			const vm =
				node.platform === "macos"
					? (await readMacStatus(driver.session, node.vmName)).vm.status
					: null;
			if (vm === "missing") {
				await log(`No VM ${node.vmName}: nothing to uninstall`);
			} else {
				if (vm && vm !== "Running") await startVm(driver, node, log);
				await log("Uninstalling the runner runtime");
				uninstalled = true;
				await driver.guest(`${RUNNERCTL} uninstall`, {
					timeoutMs: 10 * 60_000,
					label: "Runtime removal",
					allowFailure: true,
				});
			}
			if (node.platform === "macos" && vm !== "missing") {
				await log(
					`VM ${node.vmName} was not created by Dokploy: it is kept, stopped`,
				);
				await stopVm();
			}
		}
	} else if (node.platform === "macos") {
		await stopVm();
	}
	const removed = await db
		.delete(githubRunnerNodes)
		.where(currentDrain(nodeId, drain))
		.returning({ id: githubRunnerNodes.githubRunnerNodeId });
	if (!removed.length) {
		// The removal was cancelled (or replaced) while it ran: the machine stays.
		await log("The removal was cancelled meanwhile: the machine is kept");
		if (uninstalled) {
			// Nothing is left to run jobs: it takes a new provisioning.
			await db
				.update(githubRunnerNodes)
				.set({
					applied: null,
					phase: sql`CASE WHEN ${githubRunnerNodes.phase} = 'draining' THEN ${githubRunnerNodes.phase} ELSE 'error'::"githubRunnerNodePhase" END`,
					lastError:
						"The removal was cancelled after the runtime was uninstalled: provision the machine again",
				})
				.where(eq(githubRunnerNodes.githubRunnerNodeId, nodeId));
		}
		return;
	}
	await log("Machine removed");
	await finishOperation(operationId, "done");
	notify(node.pool, {
		event: "info",
		severity: "info",
		title: `${node.name} was removed`,
		message: `${node.name} left ${node.pool.name}${uninstalled ? ": Dokploy uninstalled what it had installed on it" : ""}.`,
		pool: node.pool.name,
		machine: node.name,
		at: new Date(),
	});
};

// ------------------------------------------------------------- the tick

interface Observation {
	node: NodeWithRelations;
	session: NodeSession;
	driver: NodeDriver;
	probe: NodeProbe;
}

const { counters, lastMetricAt, lastCachesAt, lastHealAt } = state;

const recordEvent = (
	events: { at: string; message: string }[],
	message: string,
) => {
	events.unshift({ at: new Date().toISOString(), message });
	events.splice(MAX_EVENTS);
};

const markUnreachable = async (node: GithubRunnerNode, error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	// Merged in the database: a "Retry now" written meanwhile stays.
	const fallback = { admission: { ok: false }, slots: [] };
	const update = {
		at: new Date().toISOString(),
		reachable: false,
		error: message,
	};
	await db
		.update(githubRunnerNodes)
		.set({
			lastError: message,
			observed: sql`coalesce(${githubRunnerNodes.observed}, ${JSON.stringify(fallback)}::jsonb) || ${JSON.stringify(update)}::jsonb`,
		})
		.where(eq(githubRunnerNodes.githubRunnerNodeId, node.githubRunnerNodeId));
};

const unreachable = new Set<string>();

const RECONNECT_MIN_MS = 10_000;
const RECONNECT_MAX_MS = 60_000;

/** How long a machine that failed this many times in a row waits for the next try. */
export const reconnectDelay = (failures: number) =>
	Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.max(0, failures - 1));

/**
 * Tries a machine that did not answer again, outside the tick: an SSH timeout
 * (15 seconds) would otherwise hold every tick of every pool. Once it answers,
 * the next tick observes it as usual.
 */
const retryUnreachable = (node: NodeWithRelations) => {
	const nodeId = node.githubRunnerNodeId;
	const backoff = state.reconnects.get(nodeId);
	// "Retry now" may come from another process: it is read from the machine.
	const requested = Date.parse(node.observed?.retryRequestedAt ?? "") || 0;
	if (backoff && requested > (backoff.requestSeen ?? 0)) {
		backoff.requestSeen = requested;
		backoff.retryAt = 0;
	}
	if (!backoff || backoff.probing || Date.now() < backoff.retryAt) return;
	backoff.probing = true;
	void (async () => {
		let session: NodeSession | null = null;
		try {
			session = await connect(node);
			await createNodeDriver(session, node).probe();
			state.reconnects.delete(nodeId);
			requestTick();
		} catch (error) {
			backoff.failures++;
			backoff.retryAt = Date.now() + reconnectDelay(backoff.failures);
			await markUnreachable(node, error).catch(() => undefined);
		} finally {
			session?.close();
			backoff.probing = false;
		}
	})();
};

/** After the operator fixed a machine (its host key): tried at the next tick. */
export const retryRunnerNodeNow = async (nodeId: string) => {
	const backoff = state.reconnects.get(nodeId);
	if (backoff) backoff.retryAt = 0;
	// Read by the leading controller, which may run in another process.
	await db
		.update(githubRunnerNodes)
		.set({
			observed: sql`jsonb_set(coalesce(${githubRunnerNodes.observed}, '{}'::jsonb), '{retryRequestedAt}', to_jsonb(${new Date().toISOString()}::text))`,
		})
		.where(eq(githubRunnerNodes.githubRunnerNodeId, nodeId));
	requestTick();
};

const observeNode = async (
	node: NodeWithRelations,
): Promise<Observation | null> => {
	const nodeId = node.githubRunnerNodeId;
	if (state.reconnects.has(nodeId)) {
		// Still unreachable for detectLostJobs until it answers again.
		unreachable.add(nodeId);
		retryUnreachable(node);
		return null;
	}
	unreachable.delete(nodeId);
	if (tasks.has(nodeId)) return null;
	if (!(await acquireLease(nodeId, TICK_LEASE_MS))) return null;
	let session: NodeSession | null = null;
	try {
		session = await connect(node);
		const driver = createNodeDriver(session, node);
		const probe = await driver.probe();
		return { node, session, driver, probe };
	} catch (error) {
		session?.close();
		await markUnreachable(node, error);
		await releaseLease(nodeId);
		unreachable.add(nodeId);
		state.reconnects.set(nodeId, {
			failures: 1,
			retryAt: Date.now() + reconnectDelay(1),
			probing: false,
			// A "Retry now" from before this failure is spent.
			requestSeen: Date.parse(node.observed?.retryRequestedAt ?? "") || 0,
		});
		return null;
	}
};

/** A machine silent this long whose runners GitHub reports offline lost its jobs. */
const LOST_AFTER_MS = 2 * 60_000;

/**
 * Jobs of a machine that went down (power, network, VM crash) cannot be seen
 * ending: once the machine has been unreachable for a while and GitHub reports
 * their runner offline, they are interrupted and recovered like a crash.
 */
const detectLostJobs = async (
	node: NodeWithRelations,
	runners: GithubRunner[],
) => {
	if (
		!node.lastSeenAt ||
		Date.now() - Date.parse(node.lastSeenAt) < LOST_AFTER_MS
	) {
		return;
	}
	const running = await db.query.githubRunnerJobs.findMany({
		where: and(
			eq(githubRunnerJobs.githubRunnerNodeId, node.githubRunnerNodeId),
			eq(githubRunnerJobs.outcome, "running"),
		),
	});
	const online = new Set(
		runners
			.filter((runner) => runner.status === "online")
			.map((runner) => runner.name),
	);
	await interruptJobs(
		running.filter((job) => !online.has(job.runnerName)),
		node.pool.rerunInterruptedJobs,
		() => `${node.name} became unreachable`,
	);
};

/** Marks jobs interrupted and queues their recovery when the pool re-runs them. */
const interruptJobs = (
	jobs: GithubRunnerJobRecord[],
	rerunEnabled: boolean,
	note: (job: GithubRunnerJobRecord) => string | null,
) => {
	const now = new Date();
	return Promise.all(
		jobs.map((job) => {
			const rerunStatus = initialRerunStatus(rerunEnabled, job.runAttempt);
			return db
				.update(githubRunnerJobs)
				.set({
					outcome: "interrupted",
					finishedAt: now.toISOString(),
					durationSeconds: Math.max(
						0,
						Math.round((now.getTime() - Date.parse(job.startedAt)) / 1000),
					),
					rerunStatus,
					rerunNote:
						rerunStatus === "skipped"
							? `not re-run: already attempt ${job.runAttempt}`
							: note(job),
				})
				.where(eq(githubRunnerJobs.githubRunnerJobId, job.githubRunnerJobId));
		}),
	);
};

const usageOf = (
	node: GithubRunnerNode,
	probe: NodeProbe,
	runtime: RuntimeStatus | null,
): NonNullable<GithubRunnerNodeObservation["usage"]> => {
	const now = Date.now();
	const previous = counters.get(node.githubRunnerNodeId);
	const usage = runtime?.slice.usageUsec ?? null;
	counters.set(node.githubRunnerNodeId, {
		at: now,
		usage,
		busy: runtime?.cpu?.busy ?? null,
		total: runtime?.cpu?.total ?? null,
	});
	let cpuPercent: number | null = null;
	if (previous && runtime) {
		if (
			node.platform === "linux" &&
			probe.host &&
			usage !== null &&
			previous.usage !== null
		) {
			const cpus = effectiveBudget("linux", probe.host, node).cpus;
			const elapsedUsec = (now - previous.at) * 1000;
			if (elapsedUsec > 0 && cpus > 0) {
				cpuPercent = ((usage - previous.usage) / (elapsedUsec * cpus)) * 100;
			}
		} else if (
			node.platform === "macos" &&
			runtime.cpu &&
			previous.busy !== null &&
			previous.total !== null &&
			runtime.cpu.total > previous.total
		) {
			cpuPercent =
				((runtime.cpu.busy - previous.busy) /
					(runtime.cpu.total - previous.total)) *
				100;
		}
	}
	const guestMemory = runtime?.host
		? runtime.host.memoryBytes - (runtime.host.availableBytes ?? 0)
		: null;
	return {
		cpuPercent:
			cpuPercent === null
				? null
				: Math.round(Math.min(100, Math.max(0, cpuPercent)) * 10) / 10,
		memoryBytes:
			node.platform === "linux"
				? (runtime?.slice.memoryCurrentBytes ?? null)
				: guestMemory,
		memoryLimitBytes:
			node.platform === "linux"
				? (runtime?.slice.memoryMaxBytes ?? probe.host?.memoryBytes ?? null)
				: (runtime?.host?.memoryBytes ?? null),
		hostMemoryFreePercent: probe.host?.memoryFreePercent ?? null,
		hostLoad: probe.host?.load ?? null,
	};
};

const LIVE_UNIT_STATES = new Set(["active", "activating", "deactivating"]);

const recordJobs = async (node: NodeWithRelations, runtime: RuntimeStatus) => {
	const now = new Date().toISOString();
	const owner = {
		organizationId: node.organizationId,
		githubRunnerNodeId: node.githubRunnerNodeId,
		githubRunnerPoolId: node.githubRunnerPoolId,
	};
	const rows = new Map<string, typeof githubRunnerJobs.$inferInsert>();
	for (const slot of runtime.slots) {
		if (!slot.runnerName || !slot.job || !LIVE_UNIT_STATES.has(slot.active)) {
			continue;
		}
		rows.set(slot.runnerName, {
			...owner,
			runnerName: slot.runnerName,
			slot: slot.slot,
			repository: slot.job.repository,
			workflow: slot.job.workflow,
			job: slot.job.job,
			runId: slot.job.runId,
			runAttempt: slot.job.runAttempt,
			startedAt: slot.job.startedAt ?? now,
		});
	}
	// A job that ended between two probes is only seen in its job file.
	const completed = runtime.jobFiles.flatMap((file) => {
		const { runnerName } = file;
		const completedAt = file.job.completedAt;
		if (!runnerName || !completedAt) return [];
		const startedAt = file.job.startedAt ?? completedAt;
		const durationSeconds = Math.max(
			0,
			Math.round((Date.parse(completedAt) - Date.parse(startedAt)) / 1000),
		);
		rows.set(runnerName, {
			...owner,
			runnerName,
			slot: file.slot,
			repository: file.job.repository,
			workflow: file.job.workflow,
			job: file.job.job,
			runId: file.job.runId,
			runAttempt: file.job.runAttempt,
			startedAt,
			outcome: "completed",
			finishedAt: completedAt,
			durationSeconds,
		});
		return [{ runnerName, completedAt, durationSeconds }];
	});
	if (rows.size) {
		await db
			.insert(githubRunnerJobs)
			.values([...rows.values()])
			.onConflictDoNothing({ target: githubRunnerJobs.runnerName });
	}
	await Promise.all(
		completed.map((job) =>
			db
				.update(githubRunnerJobs)
				.set({
					outcome: "completed",
					finishedAt: job.completedAt,
					durationSeconds: job.durationSeconds,
				})
				.where(
					and(
						eq(githubRunnerJobs.runnerName, job.runnerName),
						eq(githubRunnerJobs.outcome, "running"),
					),
				),
		),
	);
	const running = await db.query.githubRunnerJobs.findMany({
		where: and(
			eq(githubRunnerJobs.githubRunnerNodeId, node.githubRunnerNodeId),
			eq(githubRunnerJobs.outcome, "running"),
		),
	});
	await interruptJobs(
		running.filter((job) => !rows.has(job.runnerName)),
		node.pool.rerunInterruptedJobs,
		() => null,
	);
};

const measureCaches = (node: NodeWithRelations) =>
	runTask(node.githubRunnerNodeId, null, async ({ driver }) => {
		const { stdout } = await driver.guest(`${RUNNERCTL} caches`, {
			timeoutMs: 3 * 60_000,
			label: "Cache measurement",
		});
		const caches = parseCaches(stdout, new Date());
		const fresh = await loadRunnerNode(node.githubRunnerNodeId);
		if (fresh.observed) {
			await db
				.update(githubRunnerNodes)
				.set({ observed: { ...fresh.observed, caches } })
				.where(
					eq(githubRunnerNodes.githubRunnerNodeId, node.githubRunnerNodeId),
				);
		}
	});

const pushEvent = (nodeId: string, message: string) => {
	const pending = state.pendingEvents.get(nodeId) ?? [];
	pending.push({ at: new Date().toISOString(), message });
	state.pendingEvents.set(nodeId, pending.slice(-MAX_EVENTS));
};

const CLEANUP_KIND_LABELS: Record<
	GithubRunnerCleanup["freed"][number]["kind"],
	string
> = {
	containers: "containers",
	volumes: "volumes",
	images: "images",
	build_cache: "build cache",
	tool_cache: "tool cache",
	home: "home caches",
	workspaces: "workspaces",
	other: "other",
};

const freedTotal = (cleanup: GithubRunnerCleanup) =>
	cleanup.freed.reduce((sum, item) => sum + item.bytes, 0);

export const describeCleanup = (cleanup: GithubRunnerCleanup) => {
	if (cleanup.error) return `Disk cleanup failed: ${cleanup.error}`;
	const freed = freedTotal(cleanup);
	const detail = cleanup.freed
		.filter((item) => item.bytes >= 1024 ** 2)
		.slice(0, 4)
		.map(
			(item) => `${CLEANUP_KIND_LABELS[item.kind]} ${formatBytes(item.bytes)}`,
		)
		.join(", ");
	const parts = [
		freed < 1024 ** 2
			? `Disk cleanup found nothing to remove, ${formatBytes(cleanup.freeAfterBytes)} free`
			: `Disk cleanup freed ${formatBytes(freed)}${detail ? ` (${detail})` : ""}, ${formatBytes(cleanup.freeAfterBytes)} free`,
	];
	if (cleanup.targetBytes !== null && !cleanup.reached) {
		parts.push(`short of the ${formatBytes(cleanup.targetBytes)} target`);
	}
	if (cleanup.idle === "skipped-jobs") {
		parts.push("the caches in use go once the running jobs end");
	}
	return parts.join("; ");
};

interface CleanupRequest {
	trigger: GithubRunnerCleanup["trigger"];
	mode: GithubRunnerCleanup["mode"];
	/** Free space when it was requested, on the disk holding the caches. */
	freeBytes: number;
	hostFreeBytes: number | null;
	pressure?: DiskPressure;
}

/** Free space of the Mac volume holding the Lima VMs. */
const macFreeBytes = async (driver: NodeDriver) => {
	const { stdout } = await driver.host(
		`lima_home="\${LIMA_HOME:-$HOME/.lima}"; [ -d "$lima_home" ] || lima_home="$HOME"; df -Pk "$lima_home" | awk 'NR==2 {print $4}'`,
		{ timeoutMs: 30_000, label: "Mac disk space" },
	);
	const kib = Number(stdout.trim());
	return Number.isFinite(kib) ? kib * 1024 : null;
};

/**
 * Runs `runnerctl gc` in the background. Automatic cleanups pass the free space
 * to reach; manual ones remove waste only, or every cache.
 */
const startCleanup = (nodeId: string, request: CleanupRequest) =>
	runTask(nodeId, null, async ({ node, driver }) => {
		const startedAt = Date.now();
		const args =
			request.mode === "auto" && request.pressure
				? `auto ${Math.floor(request.pressure.thresholdBytes / 1024)} ${Math.ceil(request.pressure.targetBytes / 1024)}`
				: request.mode === "full"
					? "full"
					: "light";
		let cleanup: GithubRunnerCleanup;
		try {
			const { stdout } = await driver.guest(`${RUNNERCTL} gc ${args}`, {
				timeoutMs: 20 * 60_000,
				label: "Disk cleanup",
			});
			const result = parseCleanup(stdout);
			if (!result) throw new Error("the runtime reported no result");
			cleanup = {
				at: new Date().toISOString(),
				trigger: request.trigger,
				...result,
				...(node.platform === "macos"
					? {
							hostFreeBeforeBytes: request.hostFreeBytes,
							hostFreeAfterBytes: await macFreeBytes(driver).catch(() => null),
						}
					: {}),
				durationMs: Date.now() - startedAt,
			};
		} catch (error) {
			cleanup = {
				at: new Date().toISOString(),
				trigger: request.trigger,
				mode: request.mode,
				freeBeforeBytes: request.freeBytes,
				freeAfterBytes: request.freeBytes,
				targetBytes: request.pressure?.targetBytes ?? null,
				reached: false,
				idle: "not-needed",
				freed: [],
				durationMs: Date.now() - startedAt,
				error: error instanceof Error ? error.message : String(error),
			};
		}
		const fresh = await loadRunnerNode(nodeId);
		// Passes that found nothing are not worth a line each in the history: a
		// routine one, or the same cleanup again with nothing left to remove.
		const freedBytes = freedTotal(cleanup);
		const previous = fresh.cleanups[0];
		const quiet =
			!cleanup.error &&
			freedBytes < 1024 ** 2 &&
			(request.trigger === "routine" ||
				(previous !== undefined &&
					previous.trigger === cleanup.trigger &&
					!previous.error &&
					freedTotal(previous) < 1024 ** 2));
		await db
			.update(githubRunnerNodes)
			.set({
				cleanups: quiet
					? fresh.cleanups
					: [cleanup, ...fresh.cleanups].slice(0, MAX_CLEANUPS),
				lastPrunedAt: cleanup.at,
			})
			.where(eq(githubRunnerNodes.githubRunnerNodeId, nodeId));
		if (request.mode === "auto") {
			state.lastCleanups.set(nodeId, {
				at: Date.now(),
				trigger: request.trigger === "filling" ? "filling" : "low-disk",
				reached: cleanup.reached,
				freedBytes,
				skippedForJobs: cleanup.idle === "skipped-jobs",
			});
		}
		if (!quiet) pushEvent(nodeId, describeCleanup(cleanup));
		lastCachesAt.delete(nodeId);
	});

/** Cleans the caches of a machine now, on an operator request. */
export const cleanRunnerCaches = async (
	nodeId: string,
	mode: "light" | "full",
) => {
	const node = await loadRunnerNode(nodeId);
	if (!["ready", "draining"].includes(node.phase)) {
		throw new Error("The machine must be running to clean its caches");
	}
	const observed = node.observed;
	const started = startCleanup(nodeId, {
		trigger: mode === "full" ? "manual-full" : "manual-light",
		mode,
		freeBytes:
			(node.platform === "macos"
				? observed?.sandbox?.diskFreeBytes
				: observed?.host?.diskFreeBytes) ?? 0,
		hostFreeBytes: observed?.host?.diskFreeBytes ?? null,
	});
	if (!started) {
		throw new Error(
			"Another task is running on this machine; try again in a moment",
		);
	}
	return true;
};

/**
 * Whether the speed of a machine should be measured again: never measured, for
 * a while, or under another budget.
 */
const benchmarkDue = (node: GithubRunnerNode, now: number) => {
	const benchmark = node.benchmark;
	if (
		now - (state.lastBenchmarkAt.get(node.githubRunnerNodeId) ?? 0) <
		BENCHMARK_RETRY_MS
	) {
		return false;
	}
	return (
		!benchmark ||
		now - Date.parse(benchmark.at) > BENCHMARK_EVERY_MS ||
		benchmark.cpuPercent !== node.cpuPercent ||
		(node.platform === "macos" &&
			(node.applied?.cpus ?? null) !== benchmark.vmCpus)
	);
};

/** Measures what a job gets on the machine, for fastest-first placement. */
const measureSpeed = (node: NodeWithRelations) => {
	const started = runTask(
		node.githubRunnerNodeId,
		null,
		async ({ node, driver }) => {
			const { stdout } = await driver.guest(`${RUNNERCTL} bench`, {
				timeoutMs: 2 * 60_000,
				label: "Speed benchmark",
			});
			const result = parseBenchmark(stdout);
			if (!result) throw new Error("the benchmark reported nothing");
			await db
				.update(githubRunnerNodes)
				.set({
					benchmark: {
						at: new Date().toISOString(),
						...result,
						cpuPercent: node.cpuPercent,
						vmCpus:
							node.platform === "macos" ? (node.applied?.cpus ?? null) : null,
					},
				})
				.where(
					eq(githubRunnerNodes.githubRunnerNodeId, node.githubRunnerNodeId),
				);
			pushEvent(
				node.githubRunnerNodeId,
				`Speed measured: ${result.single} per core, about ${(result.multi / result.single).toFixed(1)} cores for the jobs`,
			);
		},
		async (error) => {
			pushEvent(
				node.githubRunnerNodeId,
				`Speed benchmark failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		},
	);
	if (started) state.lastBenchmarkAt.set(node.githubRunnerNodeId, Date.now());
};

/** Refreshes the cache sizes of a machine now (they are measured every 10 minutes). */
export const refreshRunnerCaches = async (nodeId: string) => {
	const node = await loadRunnerNode(nodeId);
	if (!["ready", "draining"].includes(node.phase)) return false;
	lastCachesAt.set(nodeId, Date.now());
	return measureCaches(node);
};

const executeActions = async (
	observation: Observation,
	actions: PlannedAction[],
	client: GithubRunnerClient,
	labels: string[],
	events: { at: string; message: string }[],
) => {
	const { node, driver } = observation;
	const prefix = runnerNamePrefix(node.name);
	const minFreeKib = Math.floor(
		(node.platform === "macos" ? VM_MIN_FREE_BYTES : node.diskReserveGb * GiB) /
			1024,
	);
	const operationId = node.drain?.operationId ?? null;
	const note = async (message: string) => {
		recordEvent(events, message);
		await appendOperationLog(operationId, message);
	};

	const kills = actions.filter(
		(action): action is Extract<PlannedAction, { type: "stop" }> =>
			action.type === "stop",
	);
	if (isKillDrain(node.drain, Date.now()) && kills.length) {
		const busy = kills.filter((action) =>
			action.reason.startsWith("interrupting"),
		).length;
		await note(
			`Stopping ${kills.length} runner(s)${busy ? `, interrupting ${busy} running job(s)` : ""}`,
		);
		await driver.guest(`${RUNNERCTL} stop-all`, {
			timeoutMs: 3 * 60_000,
			label: "Stopping the runners",
		});
		await Promise.all(
			kills.map((action) =>
				action.runnerId
					? client.deleteRunner(action.runnerId).catch(() => "missing")
					: null,
			),
		);
	}

	// One after the other: each opens its own channel on the machine.
	await sequentially(actions, async (action) => {
		try {
			switch (action.type) {
				case "arm": {
					const name = `${prefix}${action.slot}-${randomBytes(3).toString("hex")}`;
					const jit = await client.generateJitConfig({ name, labels });
					try {
						const files = decodeJitConfig(jit.encodedJitConfig);
						const input = `${[
							...files.map((file) => `${file.name} ${file.base64}`),
							`name ${name}`,
						].join("\n")}\n`;
						const result = await driver.guest(
							`${RUNNERCTL} arm ${action.slot} ${minFreeKib}`,
							{
								input,
								allowFailure: true,
								timeoutMs: 3 * 60_000,
								label: `Arming slot ${action.slot}`,
							},
						);
						if (result.exitCode === 3) {
							await client.deleteRunner(jit.runnerId);
							await note(
								`Slot ${action.slot}: not started, disk below the reserve`,
							);
							break;
						}
						if (result.exitCode !== 0) {
							throw new Error(
								(result.stderr || result.stdout)
									.trim()
									.split("\n")
									.slice(-3)
									.join(" ") || `exit ${result.exitCode}`,
							);
						}
						recordEvent(events, `Slot ${action.slot}: runner ${name} started`);
					} catch (error) {
						await client.deleteRunner(jit.runnerId).catch(() => "missing");
						throw error;
					}
					break;
				}
				case "release": {
					const result = await client.deleteRunner(action.runnerId);
					if (result === "busy") {
						recordEvent(
							events,
							`Slot ${action.slot}: took a job meanwhile, kept`,
						);
						break;
					}
					await driver.guest(`${RUNNERCTL} stop ${action.slot}`, {
						timeoutMs: 2 * 60_000,
						label: `Stopping slot ${action.slot}`,
					});
					await note(
						`Slot ${action.slot}: idle runner removed (${action.reason})`,
					);
					break;
				}
				case "stop": {
					if (isKillDrain(node.drain, Date.now())) break; // done above
					await driver.guest(`${RUNNERCTL} stop ${action.slot}`, {
						timeoutMs: 2 * 60_000,
						label: `Stopping slot ${action.slot}`,
					});
					if (action.runnerId) {
						await client.deleteRunner(action.runnerId).catch(() => "missing");
					}
					await note(`Slot ${action.slot}: stopped (${action.reason})`);
					break;
				}
				case "forget": {
					const result = await client.deleteRunner(action.runnerId);
					if (result !== "busy") {
						recordEvent(
							events,
							`Unregistered ${action.runnerName} (${action.reason})`,
						);
					}
					break;
				}
				case "drained":
					break;
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await note(
				`${action.type === "arm" || action.type === "release" || action.type === "stop" ? `Slot ${action.slot}` : action.type}: ${message}`,
			);
		}
	});
};

/**
 * Whether the caches of a machine must be cleaned now. On a Mac the caches live
 * in the VM disk, whose freed blocks go back to the Mac: the VM aims for its own
 * goal plus what the Mac volume is missing.
 */
const diskGoal = (
	node: NodeWithRelations,
	host: NonNullable<NodeProbe["host"]>,
	runtime: RuntimeStatus,
	now: number,
): DiskPressure | null => {
	const samples = state.diskSamples.get(node.githubRunnerNodeId) ?? {
		host: [],
		vm: [],
	};
	samples.host = [
		...trimSamples(samples.host, now),
		{ at: now, freeBytes: host.diskFreeBytes },
	];
	if (node.platform === "macos" && runtime.disk) {
		samples.vm = [
			...trimSamples(samples.vm, now),
			{ at: now, freeBytes: runtime.disk.freeBytes },
		];
	}
	state.diskSamples.set(node.githubRunnerNodeId, samples);
	const hostPressure = diskPressure(
		host.diskFreeBytes,
		host.diskTotalBytes,
		diskThresholds(host.diskTotalBytes, node),
		fillRate(samples.host, now),
	);
	if (node.platform !== "macos") return hostPressure;
	if (!runtime.disk) return null;
	return vmCleanupGoal(
		{
			freeBytes: runtime.disk.freeBytes,
			totalBytes: runtime.disk.totalBytes,
			pressure: diskPressure(
				runtime.disk.freeBytes,
				runtime.disk.totalBytes,
				vmDiskThresholds(runtime.disk.totalBytes),
				fillRate(samples.vm, now),
			),
		},
		{ freeBytes: host.diskFreeBytes, pressure: hostPressure },
	);
};

const describePressure = (node: NodeWithRelations, pressure: DiskPressure) => {
	const where = node.platform === "macos" ? " in the VM" : "";
	const why =
		pressure.trigger === "low-disk"
			? "Low disk space"
			: `Disk filling up (${formatBytes(pressure.expectedBytes)} expected within ${FILL_HORIZON_MS / 60_000} minutes)`;
	return `${why}: removing the least recently used caches${where} until ${formatBytes(pressure.targetBytes)} are free`;
};

const UPDATE_REASONS: Record<UpdateReason, string> = {
	requested: " (asked from Dokploy)",
	required: ": this Dokploy needs it, whatever the update window",
	deadline:
		" outside the update window: GitHub stops queuing jobs on the installed release within 3 days",
	window: " (update window)",
	anytime: "",
};

const OS_REPORT_EVERY_MS = 12 * 60 * 60_000;
const OS_RELEASES_TTL_MS = 24 * 60 * 60_000;
const OS_RELEASES_RETRY_MS = 60 * 60_000;

/** Support dates of an OS product, refreshed daily in the background. */
const refreshOsReleases = (product: string) => {
	const known = state.osReleases.get(product);
	const tried = state.osReleasesTriedAt.get(product) ?? 0;
	if (known && Date.now() - known.at < OS_RELEASES_TTL_MS) return;
	if (Date.now() - tried < OS_RELEASES_RETRY_MS) return;
	state.osReleasesTriedAt.set(product, Date.now());
	void fetchOsReleases(product)
		.then((releases) => {
			state.osReleases.set(product, { at: Date.now(), releases });
		})
		.catch((error) =>
			console.error(
				`GitHub runners: unable to read the ${product} support dates`,
				error instanceof Error ? error.message : error,
			),
		);
};

/**
 * Release lines of an OS product, or null while they have not been read: an
 * alert cannot tell then whether the OS is still supported. An OS that
 * endoflife.date does not list has none to read.
 */
const osReleasesIfKnown = (id: string) => {
	const product = osProduct(id);
	if (!product) return [];
	refreshOsReleases(product);
	return state.osReleases.get(product)?.releases ?? null;
};

/** Release lines of an OS known to the controller, for the overview. */
export const knownOsReleases = (id: string) => {
	const product = osProduct(id);
	if (product) refreshOsReleases(product);
	return product ? (state.osReleases.get(product)?.releases ?? []) : [];
};

/**
 * Reads the OS of a machine (and of a Mac's VM) every 12 hours, in the
 * background: softwareupdate can take a minute and must not hold the tick.
 */
const refreshOsReport = (
	node: NodeWithRelations,
	driver: NodeDriver,
	vmRunning: boolean,
) => {
	const nodeId = node.githubRunnerNodeId;
	const last = state.osReportAt.get(nodeId) ?? 0;
	// "Check now" may come from another process: it is read from the machine.
	const requested = Date.parse(node.osReport?.requestedAt ?? "") || 0;
	if (Date.now() - last < OS_REPORT_EVERY_MS && last >= requested) return;
	state.osReportAt.set(nodeId, Date.now());
	void (async () => {
		const report: GithubRunnerOsReport = {
			at: new Date().toISOString(),
			host: null,
			guest: null,
		};
		const errors: string[] = [];
		const read = async (
			where: string,
			run: () => Promise<{ stdout: string }>,
		) => {
			try {
				return parseOsReport((await run()).stdout);
			} catch (error) {
				errors.push(
					`${where}: ${error instanceof Error ? error.message : String(error)}`,
				);
				return null;
			}
		};
		report.host = await read("machine", () =>
			driver.host(
				node.platform === "macos" ? macOsReportScript() : linuxOsReportScript(),
				{ label: "OS report", timeoutMs: 3 * 60_000, allowFailure: true },
			),
		);
		if (node.platform === "macos" && vmRunning) {
			report.guest = await read("VM", () =>
				driver.guest(`bash -c ${shellQuote(linuxOsReportScript())}`, {
					label: "VM OS report",
					timeoutMs: 2 * 60_000,
					allowFailure: true,
				}),
			);
		}
		if (errors.length) report.error = errors.join("; ");
		await db
			.update(githubRunnerNodes)
			.set({ osReport: report })
			.where(eq(githubRunnerNodes.githubRunnerNodeId, nodeId));
		for (const info of [report.host, report.guest]) {
			const product = info && osProduct(info.id);
			if (product) refreshOsReleases(product);
		}
	})().catch((error) => {
		// Tried again at the next tick rather than in 12 hours.
		state.osReportAt.delete(nodeId);
		console.error(`GitHub runners: OS report of ${node.name} failed`, error);
	});
};

/** Asks for a new OS report of a machine at the next tick. */
export const checkRunnerNodeOs = async (nodeId: string) => {
	state.osReportAt.delete(nodeId);
	// Read by the leading controller, which may run in another process.
	await db
		.update(githubRunnerNodes)
		.set({
			osReport: sql`coalesce(${githubRunnerNodes.osReport}, '{"at":"","host":null,"guest":null}'::jsonb) || jsonb_build_object('requestedAt', ${new Date().toISOString()}::text)`,
		})
		.where(eq(githubRunnerNodes.githubRunnerNodeId, nodeId));
	requestTick();
};

// ------------------------------------------------------------- firewall

const FIREWALLS_TTL_MS = 3_000;
const FIREWALL_RETRY_MS = 60_000;

const currentRunnerFirewalls = async () => {
	if (state.firewalls && Date.now() - state.firewalls.at < FIREWALLS_TTL_MS) {
		return state.firewalls.value;
	}
	const value = await loadRunnerFirewalls();
	state.firewalls = { at: Date.now(), value };
	return value;
};

/** Loads a ruleset on the machine; returns what the machine reports. */
const loadFirewall = async (
	driver: NodeDriver,
	platform: "linux" | "macos",
	ruleset: Ruleset,
) => {
	const { stdout } =
		platform === "macos"
			? await driver.host(`sudo -n ${MAC_FIREWALL_HELPER} apply`, {
					input: ruleset.text,
					label: "Firewall",
					timeoutMs: 60_000,
				})
			: await driver.guest("bash -s", {
					input: linuxFirewallApplyScript(ruleset),
					label: "Firewall",
					timeoutMs: 5 * 60_000,
				});
	return parseFirewallStatus(stdout);
};

const clearFirewall = (driver: NodeDriver, platform: "linux" | "macos") =>
	platform === "macos"
		? driver.host(`sudo -n ${MAC_FIREWALL_HELPER} clear`, {
				input: "",
				label: "Firewall removal",
				timeoutMs: 60_000,
			})
		: driver.guest("bash -s", {
				input: linuxFirewallClearScript(),
				label: "Firewall removal",
				timeoutMs: 60_000,
			});

/**
 * Puts the rules of the firewall the machine follows in place, or removes the
 * ones it no longer follows. Returns why the machine must not take jobs: the
 * rules are not loaded, or their state is unknown. Never throws: a firewall
 * that cannot be checked keeps jobs away.
 */
export const enforceFirewall = async (
	node: NodeWithRelations,
	driver: NodeDriver,
	probe: NodeProbe,
	events: { at: string; message: string }[],
): Promise<string | null> => {
	const nodeId = node.githubRunnerNodeId;
	const save = (firewall: GithubRunnerFirewallState | null) =>
		db
			.update(githubRunnerNodes)
			.set({ firewall })
			.where(eq(githubRunnerNodes.githubRunnerNodeId, nodeId));
	try {
		const firewall = runnerNodeFirewall(await currentRunnerFirewalls(), node);
		const compiled = firewall
			? compileFirewall(firewall, {
					dokployAddresses: await dokployServerAddresses(),
				})
			: null;
		const loaded = probe.firewall?.loaded ?? null;
		state.firewallExpected.set(nodeId, null);
		if (!firewall || !compiled || !filters(compiled.outbound)) {
			if (loaded) {
				await clearFirewall(driver, node.platform);
				recordEvent(events, "Firewall removed");
			}
			if (node.firewall) await save(null);
			return null;
		}
		const ruleset =
			node.platform === "macos"
				? pfRuleset(compiled)
				: nftablesRuleset(compiled);
		state.firewallExpected.set(nodeId, ruleset.hash);
		// A deny rule that cannot be written (no address known) would let its
		// traffic through: no job until it can be.
		const unenforced = compiled.skipped.find(
			(item) =>
				firewall.rules.find((rule) => rule.id === item.ruleId)?.action ===
				"deny",
		);
		const applied = (appliedAt: string): GithubRunnerFirewallState => ({
			firewallId: firewall.firewallId,
			revision: firewall.revision,
			hash: ruleset.hash,
			appliedAt,
			error: null,
			errorAt: null,
		});
		const current = node.firewall;
		const fail = async (message: string) => {
			if (current?.error !== message) {
				await save({
					firewallId: firewall.firewallId,
					revision: firewall.revision,
					hash: null,
					appliedAt: null,
					error: message,
					errorAt: new Date().toISOString(),
				});
				recordEvent(
					events,
					`Firewall "${firewall.name}" not applied: ${message}`,
				);
			}
			return `Firewall "${firewall.name}" not applied: ${message}`;
		};
		if (unenforced) {
			return fail(
				`a rule that denies traffic cannot be written: ${unenforced.reason}`,
			);
		}
		if (loaded === ruleset.hash) {
			if (
				current?.hash !== ruleset.hash ||
				current.error ||
				current.firewallId !== firewall.firewallId ||
				current.revision !== firewall.revision
			) {
				await save(
					applied(
						current?.hash === ruleset.hash && current.appliedAt
							? current.appliedAt
							: new Date().toISOString(),
					),
				);
			}
			return null;
		}
		if (node.platform === "macos" && probe.firewall?.helper !== "yes") {
			return fail(
				probe.firewall?.helper === "denied"
					? "the account Dokploy logs in with may not run the firewall helper: run the setup script of the machine again"
					: "the Mac has no firewall helper: run the setup script of the machine again (machine menu › Setup script)",
			);
		}
		if (Date.now() < (state.firewallRetryAt.get(nodeId) ?? 0)) {
			return `Firewall "${firewall.name}" not applied: ${current?.error ?? "waiting to try again"}`;
		}
		try {
			const status = await loadFirewall(driver, node.platform, ruleset);
			if (status?.loaded !== ruleset.hash) {
				throw new Error("the machine does not report the rules as loaded");
			}
		} catch (error) {
			state.firewallRetryAt.set(nodeId, Date.now() + FIREWALL_RETRY_MS);
			return fail(error instanceof Error ? error.message : String(error));
		}
		state.firewallRetryAt.delete(nodeId);
		await save(applied(new Date().toISOString()));
		recordEvent(events, `Firewall "${firewall.name}" applied`);
		return null;
	} catch (error) {
		return `Firewall state unknown: ${error instanceof Error ? error.message : String(error)}`;
	}
};

// ------------------------------------------------------------- rollouts

/**
 * Takes a place among the machines of the pool updated at the same time (and
 * the canary's role for a new release), or says why the machine waits. One
 * transaction per pool at a time, so two machines never take the last place.
 */
export const claimUpdate = (
	node: NodeWithRelations,
	kind: GithubRunnerUpdateKind,
	target: string,
	reason: UpdateReason,
) =>
	db.transaction(async (tx) => {
		const poolId = node.githubRunnerPoolId;
		await tx.execute(
			sql`SELECT 1 FROM ${githubRunnerPools} WHERE ${githubRunnerPools.githubRunnerPoolId} = ${poolId} FOR UPDATE`,
		);
		const [pool, machines] = await Promise.all([
			tx.query.githubRunnerPools.findFirst({
				where: eq(githubRunnerPools.githubRunnerPoolId, poolId),
				columns: { rolloutPolicy: true, rollouts: true },
			}),
			tx.query.githubRunnerNodes.findMany({
				where: eq(githubRunnerNodes.githubRunnerPoolId, poolId),
				columns: {
					githubRunnerNodeId: true,
					name: true,
					enabled: true,
					updateState: true,
					drain: true,
				},
			}),
		]);
		const self = machines.find(
			(machine) => machine.githubRunnerNodeId === node.githubRunnerNodeId,
		);
		if (!pool || !self)
			return { go: false, reason: "machine removed" } as const;
		const now = new Date();
		const gate = rolloutGate({
			kind,
			target,
			reason,
			selfId: node.githubRunnerNodeId,
			policy: pool.rolloutPolicy,
			rollout: kind === "os" ? undefined : pool.rollouts[kind],
			machines,
			now: now.getTime(),
		});
		if (!gate.go) return gate;
		await tx
			.update(githubRunnerNodes)
			.set({
				updateState: {
					...self.updateState,
					inProgress: { kind, target, startedAt: now.toISOString() },
				},
			})
			.where(eq(githubRunnerNodes.githubRunnerNodeId, node.githubRunnerNodeId));
		const current = kind === "os" ? undefined : pool.rollouts[kind];
		if (
			gate.canary &&
			kind !== "os" &&
			(current?.target !== target ||
				current.canaryNodeId !== node.githubRunnerNodeId)
		) {
			await tx
				.update(githubRunnerPools)
				.set({
					rollouts: {
						...pool.rollouts,
						[kind]: {
							target,
							canaryNodeId: node.githubRunnerNodeId,
							startedAt: now.toISOString(),
							installedAt: null,
							passedAt: null,
							failedAt: null,
							error: null,
						},
					},
				})
				.where(eq(githubRunnerPools.githubRunnerPoolId, poolId));
		}
		return gate;
	});

/** Changes the rollout of a kind, unless another one replaced it meanwhile. */
const setRollout = async (
	poolId: string,
	kind: "runner" | "runtime",
	expected: GithubRunnerRollout,
	next: GithubRunnerRollout,
) => {
	await db
		.update(githubRunnerPools)
		.set({
			rollouts: sql`jsonb_set(${githubRunnerPools.rollouts}, ${`{${kind}}`}, ${JSON.stringify(next)}::jsonb)`,
		})
		.where(
			and(
				eq(githubRunnerPools.githubRunnerPoolId, poolId),
				sql`${githubRunnerPools.rollouts} -> ${kind} ->> 'target' = ${expected.target}`,
				sql`${githubRunnerPools.rollouts} -> ${kind} ->> 'canaryNodeId' = ${expected.canaryNodeId}`,
			),
		);
};

/** Tells once in the machine's events why its update waits. */
const noteWaiting = (
	nodeId: string,
	message: string,
	events: { at: string; message: string }[],
) => {
	if (state.updateWaiting.get(nodeId) === message) return;
	state.updateWaiting.set(nodeId, message);
	recordEvent(events, message);
};

/** Forgets the rollout of a kind: the next machine to update leads it again. */
export const resumeGithubRunnerRollout = (
	poolId: string,
	kind: "runner" | "runtime",
) =>
	db
		.update(githubRunnerPools)
		.set({ rollouts: sql`${githubRunnerPools.rollouts} - ${kind}` })
		.where(eq(githubRunnerPools.githubRunnerPoolId, poolId));

/** The update of a machine ended: its place is free for the next one. */
const endUpdate = async (
	nodeId: string,
	outcome: { error: string | null; keepRequest: boolean },
) => {
	const fresh = await db.query.githubRunnerNodes.findFirst({
		where: eq(githubRunnerNodes.githubRunnerNodeId, nodeId),
		columns: { updateState: true },
	});
	const current = fresh?.updateState ?? {};
	await db
		.update(githubRunnerNodes)
		.set({
			updateState: {
				...current,
				inProgress: null,
				requestedAt: outcome.keepRequest ? (current.requestedAt ?? null) : null,
				error: outcome.error,
				errorAt: outcome.error ? new Date().toISOString() : null,
			},
			...(outcome.error ? { lastError: outcome.error } : {}),
		})
		.where(eq(githubRunnerNodes.githubRunnerNodeId, nodeId));
};

/**
 * Follows the canaries the machine leads: the soak starts once it reports the
 * release, the others follow once it stayed healthy, and an unhealthy canary
 * pauses the rollout.
 */
const followCanary = async (
	node: NodeWithRelations,
	installed: Record<"runner" | "runtime", string | null>,
	healthy: boolean,
	events: { at: string; message: string }[],
) => {
	await Promise.all(
		(["runtime", "runner"] as const).map(async (kind) => {
			const rollout = node.pool.rollouts[kind];
			if (rollout?.canaryNodeId !== node.githubRunnerNodeId) return;
			const next = canaryProgress({
				rollout,
				installed: installed[kind],
				healthy,
				now: Date.now(),
			});
			if (!next) return;
			await setRollout(node.githubRunnerPoolId, kind, rollout, next);
			const what = `${UPDATE_KIND_LABELS[kind]} ${rollout.target}`;
			if (next.passedAt) {
				recordEvent(
					events,
					`Canary passed: the other machines can install ${what}`,
				);
			} else if (next.failedAt) {
				recordEvent(events, `Rollout of ${what} paused: ${next.error}`);
			}
		}),
	);
};

/** Pauses the rollout this machine leads after its update failed. */
const failCanary = async (
	node: NodeWithRelations,
	kind: "runner" | "runtime",
	target: string,
	error: string,
) => {
	const fresh = await db.query.githubRunnerPools.findFirst({
		where: eq(githubRunnerPools.githubRunnerPoolId, node.githubRunnerPoolId),
		columns: { rollouts: true },
	});
	const rollout = fresh?.rollouts[kind];
	if (
		rollout?.target !== target ||
		rollout.canaryNodeId !== node.githubRunnerNodeId
	) {
		return;
	}
	await setRollout(node.githubRunnerPoolId, kind, rollout, {
		...rollout,
		installedAt: null,
		failedAt: new Date().toISOString(),
		error,
	});
};

// ------------------------------------------------------------- OS updates

/** Without an update window, OS updates give up after this long waiting for jobs. */
const PATCH_WAIT_MS = 2 * 60 * 60_000;
/** A machine that rebooted for its updates answers again within this long. */
const REBOOT_TIMEOUT_MS = 15 * 60_000;
/** OS updates are installed at most this often on a machine. */
const PATCH_EVERY_MS = 12 * 60 * 60_000;

/** The system Dokploy updates on the machine: the Linux host, or the VM of a Mac. */
const patchableOs = (node: GithubRunnerNode) =>
	node.platform === "macos"
		? (node.osReport?.guest ?? null)
		: (node.osReport?.host ?? null);

/**
 * Starts the OS updates of a machine: it stops taking jobs, its jobs end, then
 * completeDrain installs the updates and reboots if needed (finishPatch).
 * Given up, the machine back to work, if jobs still run at the end of the
 * update window.
 */
const startPatch = async (
	node: NodeWithRelations,
	reason: UpdateReason,
	events: { at: string; message: string }[],
) => {
	const nodeId = node.githubRunnerNodeId;
	const gate = await claimUpdate(node, "os", "os", reason);
	if (!gate.go) {
		noteWaiting(nodeId, `OS updates wait: ${gate.reason}`, events);
		return;
	}
	state.updateWaiting.delete(nodeId);
	const now = new Date();
	const end = updateWindowEnd(
		effectiveUpdatePolicy(node.pool, node).window,
		now,
	);
	let operationId: string | null = null;
	try {
		operationId = (
			await createOperation(node, "patch", "Install the OS updates", null)
		).githubRunnerOperationId;
	} catch {
		// Another operation runs: the updates wait for the next tick.
		await endUpdate(nodeId, { error: null, keepRequest: true });
		return;
	}
	const drain: GithubRunnerDrain = {
		mode: "wait",
		reason: "patch",
		requestedAt: now.toISOString(),
		deadline: null,
		operationId,
		abortAt: (end ?? new Date(now.getTime() + PATCH_WAIT_MS)).toISOString(),
	};
	const started = await db
		.update(githubRunnerNodes)
		.set({ phase: "draining", drain })
		.where(
			and(
				eq(githubRunnerNodes.githubRunnerNodeId, nodeId),
				eq(githubRunnerNodes.phase, "ready"),
				isNull(githubRunnerNodes.drain),
			),
		)
		.returning({ id: githubRunnerNodes.githubRunnerNodeId });
	if (!started.length) {
		await finishOperation(
			operationId,
			"cancelled",
			"The machine changed meanwhile",
		);
		await endUpdate(nodeId, { error: null, keepRequest: true });
		return;
	}
	await appendOperationLog(
		operationId,
		`No new job; the OS updates are installed once the running jobs end (given up at ${drain.abortAt?.slice(11, 16)} UTC otherwise)`,
	);
	recordEvent(events, "OS updates: no new job until they are installed");
};

/** Back to work, with the outcome of the OS updates recorded. */
const endPatch = async (
	node: NodeWithRelations,
	drain: GithubRunnerDrain,
	outcome: { error: string | null; installed: boolean },
) => {
	const nodeId = node.githubRunnerNodeId;
	const fresh = await loadRunnerNode(nodeId);
	await endDrain(nodeId, drain, fresh.enabled ? "ready" : "stopped");
	const current = fresh.updateState ?? {};
	const at = new Date().toISOString();
	await db
		.update(githubRunnerNodes)
		.set({
			updateState: {
				...current,
				inProgress: null,
				patchedAt: outcome.installed ? at : (current.patchedAt ?? null),
				// Installed, failed or given up: the next try waits PATCH_EVERY_MS.
				patchTriedAt: at,
				patchError: outcome.error,
				patchErrorAt: outcome.error ? at : null,
			},
		})
		.where(eq(githubRunnerNodes.githubRunnerNodeId, nodeId));
	// The OS report shows the updates gone at the next tick.
	state.osReportAt.delete(nodeId);
	await finishOperation(
		drain.operationId,
		outcome.error ? "error" : outcome.installed ? "done" : "cancelled",
		outcome.error ?? undefined,
	);
	// A failure is told by its alert ("OS updates failed"), which lasts.
	if (outcome.error) return;
	notify(node.pool, {
		event: "info",
		severity: "info",
		title: outcome.installed
			? `OS updates installed on ${node.name}`
			: `OS updates postponed on ${node.name}`,
		message: outcome.installed
			? `${node.name} installed its OS updates and takes jobs again.`
			: `Jobs still ran when the update window closed: ${node.name} takes jobs again, and the updates wait for the next try.`,
		pool: node.pool.name,
		machine: node.name,
		at: new Date(),
	});
};

/** Waits for a Linux machine that rebooted: it answers with another boot id. */
const waitForReboot = async (
	node: NodeWithRelations,
	bootId: string | null,
	log: (line: string) => Promise<void>,
) => {
	const deadline = Date.now() + REBOOT_TIMEOUT_MS;
	await new Promise((resolve) => setTimeout(resolve, 20_000));
	while (Date.now() < deadline) {
		let session: NodeSession | null = null;
		try {
			session = await connect(node);
			const { stdout } = await createNodeDriver(session, node).guest(
				"cat /proc/sys/kernel/random/boot_id",
				{ label: "Boot id", timeoutMs: 20_000 },
			);
			if (stdout.trim() && stdout.trim() !== bootId) {
				await log("The machine is back");
				return;
			}
		} catch {
			// Still rebooting.
		} finally {
			session?.close();
		}
		await new Promise((resolve) => setTimeout(resolve, 10_000));
	}
	throw new Error(
		`${node.name} did not answer within ${REBOOT_TIMEOUT_MS / 60_000} minutes of its reboot`,
	);
};

/** completeDrain for OS updates: the machine runs no job any more. */
const finishPatch = async (
	{ node, driver }: TaskContext,
	drain: GithubRunnerDrain,
) => {
	const log = (line: string) => appendOperationLog(drain.operationId, line);
	const where = node.platform === "macos" ? ` in VM ${node.vmName}` : "";
	let error: string | null = null;
	try {
		await log(`Installing the OS updates${where} (apt)`);
		const { stdout } = await driver.guest("bash -s", {
			input: osPatchScript(),
			label: "OS updates",
			timeoutMs: 45 * 60_000,
		});
		const result = parsePatchResult(stdout);
		if (!result) throw new Error("the update script did not finish");
		await log("Updates installed");
		if (result.reboot && node.platform === "macos") {
			await log(`Restarting VM ${node.vmName} to finish them`);
			await driver.host(macStopVmScript(node.vmName), {
				timeoutMs: 5 * 60_000,
				label: "VM stop",
			});
			await startVm(driver, node, log);
		} else if (result.reboot) {
			await log("Rebooting the machine to finish them");
			await driver.guest(
				"systemd-run --on-active=5 --unit=dokploy-reboot systemctl reboot",
				{ label: "Reboot", timeoutMs: 30_000 },
			);
			await waitForReboot(node, result.bootId, log);
		}
	} catch (cause) {
		error = cause instanceof Error ? cause.message : String(cause);
		await log(`Error: ${error}`);
	}
	await endPatch(node, drain, { error, installed: !error });
};

// ------------------------------------------------------------- autonomy

/** The first runtime that keeps a reserve and arms itself (runnerctl autoarm). */
const AUTONOMY_RUNTIME = 7;

/**
 * Keeps the machine's reserve of runner registrations full and fresh, and
 * tells it when it may arm itself: only while it takes jobs, behind the
 * firewall it must run them behind.
 */
const maintainReserve = async (
	observation: Observation,
	runtime: RuntimeStatus,
	context: {
		runners: GithubRunner[] | null;
		client: GithubRunnerClient;
		labels: string[];
		/** The machine takes jobs: it keeps its reserve. */
		accepting: boolean;
		/** The controller would start a job there now (disk, firewall). */
		admitted: boolean;
		maxRunners: number;
		events: { at: string; message: string }[];
	},
) => {
	const { node, driver } = observation;
	const nodeId = node.githubRunnerNodeId;
	const prefix = runnerNamePrefix(node.name);
	const reserve = node.pool.autonomyReserve;
	const planner = {
		enabled: node.enabled,
		phase: node.phase,
		drain: node.drain,
		maxRunners: context.maxRunners,
		namePrefix: prefix,
		labels: context.labels,
		runnerVersion: null,
		admission: { ok: true },
		maxArmsPerTick: 0,
	};
	const actions = planSpares({
		now: Date.now(),
		accepting: context.accepting,
		maxRunners: context.maxRunners,
		reserve,
		spares: runtime.spares,
		runners:
			context.runners?.filter((runner) => isRunnerOf(prefix, runner.name)) ??
			null,
		isStale: (runner) => isStale(runner, planner),
	});
	// Off first, so a machine about to stop taking jobs never arms itself.
	const minFreeKib = Math.floor(
		(node.platform === "macos" ? VM_MIN_FREE_BYTES : node.diskReserveGb * GiB) /
			1024,
	);
	const firewall =
		node.platform === "macos"
			? "host"
			: (state.firewallExpected.get(nodeId) ?? "none");
	const setting = autonomySetting({
		accepting: context.accepting,
		admitted: context.admitted,
		reserve,
		maxRunners: context.maxRunners,
		minFreeKib,
		firewall,
	});
	const writeSetting = async () => {
		if (state.autonomyApplied.get(nodeId) === setting) return;
		await driver.guest(`${RUNNERCTL} autonomy ${setting}`, {
			label: "Autonomy",
			timeoutMs: 60_000,
		});
		state.autonomyApplied.set(nodeId, setting);
	};
	if (setting === "off") await writeSetting();
	await sequentially(actions, async (action) => {
		if (action.type === "drop") {
			if (action.runnerId !== null) {
				await context.client.deleteRunner(action.runnerId).catch(() => null);
			}
			await driver.guest(
				`${RUNNERCTL} spare-drop ${action.slot} ${action.name}`,
				{ label: "Reserve", timeoutMs: 60_000 },
			);
			return;
		}
		const name = `${prefix}${action.slot}-${randomBytes(3).toString("hex")}`;
		const jit = await context.client.generateJitConfig({
			name,
			labels: context.labels,
		});
		try {
			const files = decodeJitConfig(jit.encodedJitConfig);
			await driver.guest(`${RUNNERCTL} spare-add ${action.slot}`, {
				input: `${[...files.map((file) => `${file.name} ${file.base64}`), `name ${name}`].join("\n")}\n`,
				label: "Reserve",
				timeoutMs: 60_000,
			});
		} catch (error) {
			await context.client.deleteRunner(jit.runnerId).catch(() => null);
			throw error;
		}
	});
	if (setting !== "off") await writeSetting();
	const previous = node.observed?.autonomy?.last ?? null;
	const armed = runtime.autonomy;
	if (armed && (!previous || Date.parse(previous) < armed.last * 1000)) {
		recordEvent(
			context.events,
			`Armed its runners on its own while no controller answered (${armed.armed} so far, last at ${new Date(armed.last * 1000).toISOString().slice(11, 16)} UTC)`,
		);
	}
};

const actOnNode = async (
	observation: Observation,
	runners: GithubRunner[] | null,
	listError: string | null,
	waiting: WaitingTarget | undefined,
) => {
	const { node, driver, probe } = observation;
	const now = Date.now();
	const events = [...(node.observed?.events ?? [])];
	const nodeId = node.githubRunnerNodeId;
	for (const event of state.pendingEvents.get(nodeId) ?? []) {
		events.unshift(event);
	}
	events.splice(MAX_EVENTS);
	state.pendingEvents.delete(nodeId);
	let phase = node.phase;
	let lastError: string | null = listError;
	let runtime = probe.runtime;
	let admission: GithubRunnerNodeObservation["admission"] = { ok: true };
	let busy = 0;
	let slots: GithubRunnerNodeObservation["slots"] = [];
	let drained = false;

	try {
		// A Mac whose VM stopped while enabled is started again (after a reboot).
		if (node.platform === "macos" && probe.vm) {
			if (probe.vm.status === "missing") {
				if (phase === "ready") {
					phase = "error";
					lastError = `VM ${node.vmName} no longer exists on the Mac`;
				}
				runtime = null;
			} else if (probe.vm.status !== "Running") {
				runtime = null;
				if (
					node.enabled &&
					phase === "ready" &&
					now - (lastHealAt.get(nodeId) ?? 0) > HEAL_EVERY_MS
				) {
					lastHealAt.set(nodeId, now);
					recordEvent(
						events,
						`VM ${node.vmName} is ${probe.vm.status}: starting it`,
					);
					setTimeout(() => {
						runTask(nodeId, null, async ({ node, driver }) => {
							await startVm(driver, node, async (line) =>
								console.log(`[github-runners] ${node.name}: ${line}`),
							);
						});
					}, 0);
				}
			} else if (!runtime && probe.runtimeError) {
				lastError = `Runtime does not answer: ${probe.runtimeError}`;
			}
		}

		const host = probe.host;
		if (runtime && host) {
			// Runtime and runner updates happen in the background, between ticks,
			// when the machine's update policy allows them (see updates.ts).
			const policy = effectiveUpdatePolicy(node.pool, node);
			const requestedAt = node.updateState?.requestedAt ?? null;
			const failedAt = node.updateState?.errorAt ?? null;
			let updateStarted = false;
			const startUpdate = async (
				what: string,
				kind: "runner" | "runtime",
				target: string,
				reason: UpdateReason,
				install: (context: TaskContext) => Promise<void>,
			) => {
				const gate = await claimUpdate(node, kind, target, reason);
				if (!gate.go) {
					noteWaiting(nodeId, `${what} waits: ${gate.reason}`, events);
					return;
				}
				updateStarted = true;
				state.updateWaiting.delete(nodeId);
				setTimeout(() => {
					const started = runTask(
						nodeId,
						null,
						async (context) => {
							await install(context);
							// An "update now" stays until nothing is left to update.
							await endUpdate(nodeId, { error: null, keepRequest: true });
						},
						async (error) => {
							const message = `${what} failed: ${error instanceof Error ? error.message : String(error)}`;
							pushEvent(nodeId, message);
							await endUpdate(nodeId, { error: message, keepRequest: false });
							if (gate.canary) await failCanary(node, kind, target, message);
						},
					);
					if (started) {
						pushEvent(
							nodeId,
							`${what}${UPDATE_REASONS[reason]}${gate.canary ? " (canary of the pool)" : ""}`,
						);
					} else {
						void endUpdate(nodeId, { error: null, keepRequest: true });
					}
				}, 0);
			};
			const decide = (extra: {
				required?: boolean;
				deadline?: string | null;
			}) =>
				updateDecision({
					policy,
					now: new Date(now),
					requested: requestedAt !== null,
					failedAt,
					...extra,
				});
			if (
				runtime.runtimeVersion < RUNTIME_VERSION &&
				(phase === "ready" || phase === "draining") &&
				// OS updates own the machine until they end.
				node.drain?.reason !== "patch"
			) {
				const decision = decide({
					required: runtime.runtimeVersion < MIN_RUNTIME_VERSION,
				});
				if (decision.allowed) {
					await startUpdate(
						`Updating the runtime to v${RUNTIME_VERSION}`,
						"runtime",
						String(RUNTIME_VERSION),
						decision.reason,
						async ({ driver }) => {
							await installRuntime(driver, async () => undefined);
						},
					);
				}
			} else if (phase === "ready" && node.enabled && runtime.host?.arch) {
				const release = await desiredRelease(
					node.pool,
					runtime.host.arch,
				).catch(() => null);
				if (release && runtime.release !== release.version) {
					const { deadline } = runnerVersionStatus({
						installed: runtime.release,
						releases: knownRunnerReleases(),
						pinned: node.pool.runnerVersion,
						updating: true,
						now,
					});
					const decision = decide({ deadline });
					if (decision.allowed) {
						await startUpdate(
							`Installing actions/runner ${release.version}`,
							"runner",
							release.version,
							decision.reason,
							async ({ node, driver }) => {
								await installRelease(driver, release, async () => undefined);
								await db
									.update(githubRunnerNodes)
									.set({
										applied: node.applied
											? { ...node.applied, runnerVersion: release.version }
											: node.applied,
									})
									.where(eq(githubRunnerNodes.githubRunnerNodeId, nodeId));
							},
						);
					}
				} else if (release && requestedAt) {
					// Asked to update, and nothing is left to update.
					await db
						.update(githubRunnerNodes)
						.set({
							updateState: {
								...node.updateState,
								requestedAt: null,
								error: null,
								errorAt: null,
							},
						})
						.where(eq(githubRunnerNodes.githubRunnerNodeId, nodeId));
					recordEvent(events, "Runner and runtime are up to date");
				}
			}
			// OS updates, when the policy installs them, once nothing else updates.
			const pending = patchableOs(node);
			if (
				policy.osPatches &&
				!updateStarted &&
				phase === "ready" &&
				node.enabled &&
				!node.drain &&
				!node.updateState?.inProgress &&
				pending &&
				((pending.updates ?? 0) > 0 || pending.reboot === true) &&
				now -
					Date.parse(
						node.updateState?.patchTriedAt ??
							node.updateState?.patchedAt ??
							"1970-01-01",
					) >
					PATCH_EVERY_MS
			) {
				const decision = updateDecision({
					policy,
					now: new Date(now),
					requested: false,
					failedAt: node.updateState?.patchErrorAt ?? null,
				});
				if (decision.allowed) await startPatch(node, decision.reason, events);
			}
			refreshOsReport(node, driver, probe.vm?.status === "Running");

			// Kept out of the planning: a machine whose environment or limits
			// cannot be written still runs, drains and cleans its disk.
			const maintain = async (what: string, action: () => Promise<void>) => {
				try {
					await action();
				} catch (error) {
					lastError = `${what}: ${error instanceof Error ? error.message : String(error)}`;
				}
			};
			// Macs set up before the boot script waited for pf get the new one.
			if (
				node.platform === "macos" &&
				node.applied &&
				(node.applied.bootScript ?? 1) < MAC_BOOT_SCRIPT_VERSION
			) {
				const applied = node.applied;
				await maintain("Boot script not updated", async () => {
					await driver.host(macWriteBootScript(node.vmName), {
						timeoutMs: 30_000,
						label: "Boot script",
					});
					node.applied = { ...applied, bootScript: MAC_BOOT_SCRIPT_VERSION };
					recordEvent(
						events,
						"Boot script updated: after a reboot, the VM waits for the firewall of its jobs",
					);
				});
			}
			const envHash = environmentHash(node.pool);
			if (node.applied && node.applied.envHash !== envHash) {
				const applied = node.applied;
				await maintain("Runner environment not updated", async () => {
					await writeEnvironment(driver, node.pool);
					node.applied = { ...applied, envHash };
					recordEvent(events, "Runner environment updated");
				});
			}
			if (
				node.platform === "linux" &&
				node.applied &&
				(node.applied.cpuPercent !== node.cpuPercent ||
					node.applied.memoryPercent !== node.memoryPercent)
			) {
				const applied = node.applied;
				await maintain("Budget not applied", async () => {
					await applySliceLimits(driver, node, host);
					node.applied = {
						...applied,
						cpuPercent: node.cpuPercent,
						memoryPercent: node.memoryPercent,
					};
					recordEvent(
						events,
						`Budget applied: ${node.cpuPercent}% CPU, ${node.memoryPercent}% memory`,
					);
				});
			}

			// Admission: the host disk reserve (the Mac APFS volume on macOS).
			const reserve = node.diskReserveGb * GiB;
			if (host.diskFreeBytes < reserve) {
				admission = {
					ok: false,
					reason: `${formatBytes(host.diskFreeBytes)} free, below the ${node.diskReserveGb} GiB reserve`,
				};
			} else if (
				node.platform === "macos" &&
				runtime.disk &&
				runtime.disk.freeBytes < VM_MIN_FREE_BYTES
			) {
				admission = {
					ok: false,
					reason: `VM disk almost full (${formatBytes(runtime.disk.freeBytes)} free)`,
				};
			}
		}

		// Admission: the firewall of the jobs, when the machine follows one.
		const blocked = await enforceFirewall(node, driver, probe, events);
		if (blocked && admission.ok) admission = { ok: false, reason: blocked };

		const effectiveSlots = runtime?.slots ?? [];
		const labels = runnerLabels(
			node.pool,
			node,
			runtime?.host?.arch ?? host?.arch ?? "x86_64",
		);
		const plan = planNode({
			now,
			node: {
				enabled: node.enabled,
				phase,
				drain: node.drain,
				maxRunners: resolveMaxRunners(
					node.maxRunners,
					node.platform,
					host,
					node,
				),
				namePrefix: runnerNamePrefix(node.name),
				labels,
				runnerVersion: runtime?.release ?? null,
				admission,
				stopIdle: blocked,
				maxArmsPerTick: MAX_ARMS_PER_TICK,
				waiting,
			},
			slots: effectiveSlots,
			runners: runners ?? [],
			spares: runtime?.spares.map((spare) => spare.name) ?? [],
		});
		busy = plan.busy;
		slots = plan.slots;

		if (runtime) {
			const client = await poolClient(node.pool);
			// Without the GitHub view, only stopping runners is safe.
			const actions =
				runners === null
					? plan.actions.filter(
							(action) =>
								action.type === "stop" && isKillDrain(node.drain, now),
						)
					: plan.actions;
			await executeActions(observation, actions, client, labels, events);
			await recordJobs(node, runtime);
			await followCanary(
				node,
				{
					runtime: String(runtime.runtimeVersion),
					runner: runtime.release,
				},
				admission.ok &&
					plan.slots.some(
						(slot) => slot.state === "idle" || slot.state === "busy",
					),
				events,
			);
			if (runtime.runtimeVersion >= AUTONOMY_RUNTIME) {
				await maintainReserve(observation, runtime, {
					runners,
					client,
					labels,
					accepting: node.enabled && phase === "ready" && !node.drain,
					admitted: admission.ok,
					maxRunners: resolveMaxRunners(
						node.maxRunners,
						node.platform,
						host,
						node,
					),
					events,
				}).catch((error) => {
					lastError = `Reserve not kept: ${error instanceof Error ? error.message : String(error)}`;
				});
			}
		}
		// A stopped VM runs nothing; a running VM whose runtime does not answer
		// may still run jobs, so it is never taken for drained.
		drained =
			plan.actions.some((action) => action.type === "drained") ||
			(Boolean(node.drain) &&
				node.platform === "macos" &&
				probe.vm !== null &&
				probe.vm.status !== "Running");
		// OS updates that could not start before the end of the window wait for the next one.
		const patch = node.drain?.reason === "patch" ? node.drain : null;
		if (
			patch?.abortAt &&
			!drained &&
			!tasks.has(nodeId) &&
			now >= Date.parse(patch.abortAt)
		) {
			await endPatch(node, patch, { error: null, installed: false });
			phase = "ready";
		}

		const pressure =
			runtime && host ? diskGoal(node, host, runtime, now) : null;
		if (
			pressure &&
			cleanupDue(state.lastCleanups.get(nodeId), now, busy, pressure.trigger) &&
			startCleanup(nodeId, {
				trigger: pressure.trigger,
				mode: "auto",
				freeBytes:
					(node.platform === "macos" ? runtime?.disk?.freeBytes : null) ??
					host?.diskFreeBytes ??
					0,
				hostFreeBytes: host?.diskFreeBytes ?? null,
				pressure,
			})
		) {
			recordEvent(events, describePressure(node, pressure));
		} else if (
			runtime &&
			busy === 0 &&
			phase === "ready" &&
			benchmarkDue(node, now)
		) {
			measureSpeed(node);
		} else if (
			!pressure &&
			runtime &&
			busy === 0 &&
			now - Date.parse(node.lastPrunedAt ?? "1970-01-01") >
				ROUTINE_CLEANUP_EVERY_MS
		) {
			startCleanup(nodeId, {
				trigger: "routine",
				mode: "light",
				freeBytes: runtime.disk?.freeBytes ?? 0,
				hostFreeBytes: host?.diskFreeBytes ?? null,
			});
		} else if (
			runtime &&
			now - (lastCachesAt.get(nodeId) ?? 0) > CACHES_EVERY_MS
		) {
			lastCachesAt.set(nodeId, now);
			setTimeout(() => measureCaches(node), 0);
		}
	} catch (error) {
		lastError = error instanceof Error ? error.message : String(error);
	}

	const usage = usageOf(node, probe, runtime);
	const observed: GithubRunnerNodeObservation = {
		at: new Date().toISOString(),
		reachable: true,
		...(lastError ? { error: lastError } : {}),
		host: probe.host
			? {
					os: probe.host.os,
					arch: probe.host.arch,
					cpus: probe.host.cpus,
					memoryBytes: probe.host.memoryBytes,
					diskFreeBytes: probe.host.diskFreeBytes,
					diskTotalBytes: probe.host.diskTotalBytes,
				}
			: node.observed?.host,
		sandbox:
			node.platform === "macos"
				? {
						kind: "vm",
						state: probe.vm?.status ?? "unknown",
						cpus: probe.vm?.cpus ?? null,
						memoryBytes: probe.vm?.memoryBytes ?? null,
						diskFreeBytes: runtime?.disk?.freeBytes ?? null,
						diskTotalBytes: runtime?.disk?.totalBytes ?? null,
						memoryCurrentBytes: usage.memoryBytes,
					}
				: {
						kind: "slice",
						state: runtime ? "active" : "missing",
						cpus: probe.host
							? effectiveBudget("linux", probe.host, node).cpus
							: null,
						memoryBytes: usage.memoryLimitBytes,
						diskFreeBytes: runtime?.disk?.freeBytes ?? null,
						memoryCurrentBytes: usage.memoryBytes,
					},
		runtime: runtime
			? { version: runtime.runtimeVersion, runnerVersion: runtime.release }
			: node.observed?.runtime,
		admission,
		slots,
		usage,
		caches: node.observed?.caches,
		events,
		autonomy:
			runtime && runtime.runtimeVersion >= AUTONOMY_RUNTIME
				? {
						reserve: node.pool.autonomyReserve,
						spares: runtime.spares.length,
						armed: runtime.autonomy?.armed ?? 0,
						last: runtime.autonomy
							? new Date(runtime.autonomy.last * 1000).toISOString()
							: null,
					}
				: node.observed?.autonomy,
	};

	await db
		.update(githubRunnerNodes)
		.set({
			observed,
			applied: node.applied,
			lastSeenAt: observed.at,
			lastError,
		})
		.where(eq(githubRunnerNodes.githubRunnerNodeId, nodeId));
	// An operator action may have moved the phase during the tick: only change it
	// from the phase this tick started from.
	if (phase !== node.phase) {
		await db
			.update(githubRunnerNodes)
			.set({ phase })
			.where(
				and(
					eq(githubRunnerNodes.githubRunnerNodeId, nodeId),
					eq(githubRunnerNodes.phase, node.phase),
				),
			);
	}

	if (now - (lastMetricAt.get(nodeId) ?? 0) >= METRIC_EVERY_MS) {
		lastMetricAt.set(nodeId, now);
		await db.insert(githubRunnerMetrics).values({
			githubRunnerNodeId: nodeId,
			at: observed.at,
			cpuPercent: usage.cpuPercent,
			memoryBytes: usage.memoryBytes,
			memoryLimitBytes: usage.memoryLimitBytes,
			hostMemoryFreePercent: usage.hostMemoryFreePercent,
			diskFreeBytes: probe.host?.diskFreeBytes ?? null,
			busyRunners: busy,
			runners: slots.length,
		});
	}

	return drained;
};

const RECOVERY_EVERY_MS = 20_000;
const RECOVERY_GIVE_UP_MS = 6 * 60 * 60_000;

/**
 * Re-runs the jobs machines interrupted, so they land on the healthy machines
 * of the pool. One decision per run: a crash can interrupt several of its jobs.
 */
const recoverInterruptedJobs = async (pool: GithubRunnerPool) => {
	const last = state.lastRecoveryAt.get(pool.githubRunnerPoolId) ?? 0;
	if (Date.now() - last < RECOVERY_EVERY_MS) return;
	state.lastRecoveryAt.set(pool.githubRunnerPoolId, Date.now());
	const pending = await db.query.githubRunnerJobs.findMany({
		where: and(
			eq(githubRunnerJobs.githubRunnerPoolId, pool.githubRunnerPoolId),
			inArray(githubRunnerJobs.rerunStatus, ["pending", "cancelling"]),
		),
		orderBy: asc(githubRunnerJobs.finishedAt),
		limit: 50,
	});
	if (!pending.length) return;
	const client = await poolClient(pool);
	const runs = new Map<string, typeof pending>();
	for (const job of pending) {
		const key = `${job.repository}#${job.runId}#${job.runAttempt}`;
		runs.set(key, [...(runs.get(key) ?? []), job]);
	}
	await sequentially([...runs.values()], async (jobs) => {
		const [first] = jobs;
		if (!first) return;
		const ids = jobs.map((job) => job.githubRunnerJobId);
		const mark = (
			rerunStatus: "cancelling" | "requested" | "skipped" | "failed",
			rerunNote: string,
		) =>
			db
				.update(githubRunnerJobs)
				.set({ rerunStatus, rerunNote, rerunAt: new Date().toISOString() })
				.where(inArray(githubRunnerJobs.githubRunnerJobId, ids));
		if (
			Date.now() - Date.parse(first.finishedAt ?? first.startedAt) >
			RECOVERY_GIVE_UP_MS
		) {
			await mark("skipped", "the run did not complete within 6 hours");
			return;
		}
		try {
			const [run, runJobs] = await Promise.all([
				client.getRun(first.repository, first.runId),
				client.listRunJobs(first.repository, first.runId),
			]);
			const decision = decideRerun(first, run, runJobs);
			if (decision.action === "wait") return;
			if (decision.action === "cancel") {
				await client.forceCancelRun(first.repository, first.runId);
				await mark("cancelling", decision.note);
			} else if (decision.action === "rerun") {
				await client.rerunFailedJobs(first.repository, first.runId);
				await mark("requested", decision.note);
			} else {
				await mark("skipped", decision.note);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (isPermanentGithubError(error)) {
				await mark("failed", message);
				return;
			}
			// GitHub down, slow or rate limited: the next recovery tries again,
			// until the 6-hour limit above.
			await db
				.update(githubRunnerJobs)
				.set({ rerunNote: `Retrying: ${message}` })
				.where(inArray(githubRunnerJobs.githubRunnerJobId, ids));
		}
	});
};

// ------------------------------------------------------------- routing

const REPOSITORIES_TTL_MS = 60 * 60_000;
const REROUTE_SCAN_EVERY_MS = 60_000;
const REROUTE_FORCE_CANCEL_MS = 3 * 60_000;
const REROUTE_VERIFY_AFTER_MS = 60_000;
const REROUTE_SCAN_CONCURRENCY = 4;
/** Failures GitHub may heal from after which a scan stops until the next one. */
const REROUTE_SCAN_MAX_FAILURES = 3;

/**
 * A machine whose runners take jobs: enabled, provisioned, reachable, above its
 * disk reserve, with at least one of its runners online on GitHub.
 */
const runnerOn = (node: GithubRunnerNode, runners: GithubRunner[]): boolean =>
	node.enabled &&
	node.phase === "ready" &&
	node.observed?.reachable !== false &&
	node.observed?.admission?.ok !== false &&
	runners.some(
		(runner) =>
			runner.status === "online" &&
			isRunnerOf(runnerNamePrefix(node.name), runner.name),
	);

const routingChanged = (
	previous: GithubRunnerPool["routing"],
	next: GithubRunnerPool["routing"],
) => JSON.stringify(previous) !== JSON.stringify(next);

/**
 * Publishes where the jobs of a pool go: its runners while at least one is ON,
 * the fallback otherwise. Runs after every tick, for every pool with routing.
 */
export const routePool = async (pool: GithubRunnerPool) => {
	const poolId = pool.githubRunnerPoolId;
	const client = await poolClient(pool);
	const variable = pool.routingVariable;
	const now = Date.now();
	if (!variable) {
		// Routing turned off: the variable goes, and workflows use their default.
		// The routing state stays, with the error, until GitHub deleted it.
		const previous = pool.routing;
		if (previous?.variable) {
			const since = now - Date.parse(previous.attemptedAt ?? "1970-01-01");
			if (previous.error && since < ROUTING_RETRY_MS) return;
			const error = await client
				.deleteVariable(previous.variable)
				.then(() => null)
				.catch((failure: unknown) =>
					failure instanceof Error ? failure.message : String(failure),
				);
			if (error) {
				await db
					.update(githubRunnerPools)
					.set({
						routing: {
							...previous,
							attemptedAt: new Date(now).toISOString(),
							error: `Cannot delete ${previous.variable}: ${error}`,
						},
					})
					.where(eq(githubRunnerPools.githubRunnerPoolId, poolId));
				return;
			}
		}
		await db
			.update(githubRunnerPools)
			.set({ routing: null })
			.where(eq(githubRunnerPools.githubRunnerPoolId, poolId));
		return;
	}
	const nodes = await db.query.githubRunnerNodes.findMany({
		where: eq(githubRunnerNodes.githubRunnerPoolId, poolId),
	});
	const listed = state.poolRunners.get(poolId);
	const candidates = nodes.filter(
		(node) => node.enabled && node.phase === "ready",
	);
	// Without a recent view of GitHub, the jobs keep going where they go.
	if (candidates.length && (!listed || now - listed.at > 60_000)) return;
	let routing = decideRouting({
		previous: pool.routing,
		available: candidates.some((node) => runnerOn(node, listed?.runners ?? [])),
		anyEnabled: nodes.some((node) => node.enabled),
		labels: pool.labels,
		fallbackLabels: pool.fallbackLabels,
		now,
	});
	if (routingSyncDue(routing, variable, now)) {
		const at = new Date(now).toISOString();
		try {
			await client.setVariable(variable, routing.value);
			// Renamed: the previous variable goes once the new one holds the value.
			// Until then the sync counts as failed, so it is tried again.
			const previous = routing.variable;
			if (previous && previous !== variable) {
				await client.deleteVariable(previous).catch((error: unknown) => {
					throw new Error(
						`${variable} is written, but ${previous} could not be deleted: ${error instanceof Error ? error.message : String(error)}`,
					);
				});
			}
			routing = {
				...routing,
				variable,
				syncedValue: routing.value,
				syncedAt: at,
				attemptedAt: at,
				error: null,
			};
		} catch (error) {
			routing = {
				...routing,
				attemptedAt: at,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}
	if (routing.target !== pool.routing?.target) {
		console.log(
			`[github-runners] ${pool.name}: jobs now go to ${routing.target === "pool" ? "the pool" : routing.value}`,
		);
	}
	if (routingChanged(pool.routing, routing)) {
		await db
			.update(githubRunnerPools)
			.set({ routing })
			.where(eq(githubRunnerPools.githubRunnerPoolId, poolId));
	}
	// Jobs queued for the pool before GitHub saw the fallback go there too.
	if (
		routing.target === "fallback" &&
		routing.syncedValue === routing.value &&
		now - (state.lastRerouteScan.get(poolId) ?? 0) >= REROUTE_SCAN_EVERY_MS &&
		!state.rerouteScans.has(poolId)
	) {
		state.lastRerouteScan.set(poolId, now);
		state.rerouteScans.add(poolId);
		// Outside the tick: one call per private repository, which a slow or
		// failing GitHub could stretch to minutes.
		void rerouteQueuedRuns(pool, client)
			.catch((error) =>
				console.error(
					`[github-runners] ${pool.name}: reroute scan failed`,
					error,
				),
			)
			.finally(() => state.rerouteScans.delete(poolId));
	}
	await advanceReroutes(pool, client);
};

const poolRepositories = async (
	pool: GithubRunnerPool,
	client: GithubRunnerClient,
) => {
	const cached = state.repositories.get(pool.githubRunnerPoolId);
	if (cached && Date.now() - cached.at < REPOSITORIES_TTL_MS) {
		return cached.names;
	}
	const names = await client.listRepositories();
	state.repositories.set(pool.githubRunnerPoolId, { at: Date.now(), names });
	return names;
};

/**
 * Cancels the runs whose jobs wait for the pool while none of its runners is
 * ON, once nothing else of the run is still running: their re-run reads the
 * variable again and lands on the fallback runners.
 */
export const rerouteQueuedRuns = async (
	pool: GithubRunnerPool,
	client: GithubRunnerClient,
) => {
	const repositories = await poolRepositories(pool, client);
	const known = new Set(
		(
			await db.query.githubRunnerReroutes.findMany({
				where: eq(
					githubRunnerReroutes.githubRunnerPoolId,
					pool.githubRunnerPoolId,
				),
				columns: { repository: true, runId: true },
			})
		).map((row) => `${row.repository}#${row.runId}`),
	);
	// GitHub down or rate limited: the scan stops after a few failures instead
	// of waiting out a timeout for every repository.
	const failures: string[] = [];
	let transient = 0;
	const failed = (what: string, error: unknown) => {
		failures.push(
			`${what}: ${error instanceof Error ? error.message : String(error)}`,
		);
		if (!isPermanentGithubError(error)) transient++;
	};
	await mapWithConcurrency(
		repositories,
		REROUTE_SCAN_CONCURRENCY,
		async (repository) => {
			if (transient >= REROUTE_SCAN_MAX_FAILURES) return;
			const runs = await client
				.listQueuedRuns(repository)
				.catch((error: unknown) => {
					failed(repository, error);
					return [];
				});
			await sequentially(runs, async (run) => {
				const runId = String(run.id);
				if (known.has(`${repository}#${runId}`)) return;
				if (transient >= REROUTE_SCAN_MAX_FAILURES) return;
				const jobs = await client
					.listRunJobs(repository, runId)
					.catch((error: unknown) => {
						failed(`${repository} run ${runId}`, error);
						return [];
					});
				const waiting = jobs.filter(
					(job) =>
						job.status === "queued" &&
						waitsForPool(job.labels, pool.labels) &&
						Date.now() - Date.parse(job.createdAt ?? run.createdAt) >=
							REROUTE_MIN_QUEUED_MS,
				);
				// Cancelling stops the whole run: wait for the jobs that do run.
				if (
					!waiting.length ||
					jobs.some((job) => job.status === "in_progress")
				) {
					return;
				}
				try {
					await client.cancelRun(repository, runId);
					await db.insert(githubRunnerReroutes).values({
						githubRunnerPoolId: pool.githubRunnerPoolId,
						repository,
						runId,
						runAttempt: run.runAttempt,
						workflow: run.workflow,
						note: `${waiting.length} job(s) waited for the pool`,
					});
					console.log(
						`[github-runners] ${pool.name}: rerouting ${repository} run ${runId}`,
					);
				} catch (error) {
					console.error(
						`[github-runners] ${pool.name}: cannot reroute ${repository} run ${runId}`,
						error,
					);
				}
			});
		},
	);
	if (failures.length) {
		console.error(
			`[github-runners] ${pool.name}: the reroute scan could not read ${failures.length} item(s)${transient >= REROUTE_SCAN_MAX_FAILURES ? " and stopped early" : ""}; first: ${failures[0]}`,
		);
	}
};

/** Re-runs the cancelled runs, then checks their jobs left the pool. */
const advanceReroutes = async (
	pool: GithubRunnerPool,
	client: GithubRunnerClient,
) => {
	const open = await db.query.githubRunnerReroutes.findMany({
		where: and(
			eq(githubRunnerReroutes.githubRunnerPoolId, pool.githubRunnerPoolId),
			inArray(githubRunnerReroutes.status, ["cancelling", "requested"]),
		),
	});
	await sequentially(open, async (row) => {
		const mark = (status: "requested" | "rerouted" | "failed", note: string) =>
			db
				.update(githubRunnerReroutes)
				.set({ status, note, updatedAt: new Date().toISOString() })
				.where(
					eq(
						githubRunnerReroutes.githubRunnerRerouteId,
						row.githubRunnerRerouteId,
					),
				);
		try {
			if (row.status === "requested") {
				if (Date.now() - Date.parse(row.updatedAt) < REROUTE_VERIFY_AFTER_MS) {
					return;
				}
				const jobs = await client.listRunJobs(row.repository, row.runId);
				const stuck = jobs.some(
					(job) =>
						job.status === "queued" && waitsForPool(job.labels, pool.labels),
				);
				await (stuck
					? mark(
							"failed",
							"Re-run, but its jobs ask for the pool labels directly: use the routing variable in runs-on",
						)
					: mark(
							"rerouted",
							`Re-run on ${fallbackRunsOn(pool.fallbackLabels)}`,
						));
				return;
			}
			const run = await client.getRun(row.repository, row.runId);
			if (run.status !== "completed") {
				if (Date.now() - Date.parse(row.createdAt) > REROUTE_FORCE_CANCEL_MS) {
					await client.forceCancelRun(row.repository, row.runId);
				}
				return;
			}
			if (run.conclusion !== "cancelled") {
				await mark("failed", `The run ended on its own (${run.conclusion})`);
				return;
			}
			await client.rerunFailedJobs(row.repository, row.runId);
			await mark("requested", "Cancelled, then its jobs re-run");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			// The run is already cancelled: only give up when GitHub will not
			// accept the request, or after the recovery limit.
			const expired =
				Date.now() - Date.parse(row.createdAt) > RECOVERY_GIVE_UP_MS;
			if (isPermanentGithubError(error) || expired) {
				await mark("failed", message);
				return;
			}
			await db
				.update(githubRunnerReroutes)
				.set({ note: `Retrying: ${message}` })
				.where(
					eq(
						githubRunnerReroutes.githubRunnerRerouteId,
						row.githubRunnerRerouteId,
					),
				);
		}
	});
};

const routePools = async () => {
	const pools = await db.query.githubRunnerPools.findMany({
		where: or(
			isNotNull(githubRunnerPools.routingVariable),
			isNotNull(githubRunnerPools.routing),
		),
	});
	await Promise.all(
		pools.map((pool) =>
			routePool(pool).catch((error) =>
				console.error(`GitHub runner routing failed for ${pool.name}`, error),
			),
		),
	);
};

/** "dokploy-runner@<machine>", the comment of a machine key. */
export const machineKeyComment = (name: string) => `dokploy-runner@${name}`;

/** A new ed25519 key for one machine (OpenSSH format, for ssh2 and authorized_keys). */
export const generateMachineKey = (name: string) => {
	const keys = ssh2.utils.generateKeyPairSync("ed25519", {
		comment: machineKeyComment(name),
	});
	return { privateKey: keys.private, publicKey: keys.public.trim() };
};

/**
 * Replaces the key of an enrolled machine without a gap: the new key is
 * authorized next to the old one, Dokploy logs in with it and saves it, then
 * only the new one is kept and the old connections are closed. At every step
 * the key Dokploy holds is one the machine accepts.
 */
export const rotateRunnerNodeKey = async (nodeId: string) => {
	const node = await loadRunnerNode(nodeId);
	if (!node.sshPrivateKey || !node.sshPublicKey) {
		throw new Error(
			`${node.name} uses a shared SSH key: only machines set up with the setup script have a key of their own`,
		);
	}
	if (node.phase === "enrolling" || node.phase === "provisioning") {
		throw new Error(`${node.name} is not set up yet`);
	}
	let failure: unknown = null;
	let saved = false;
	const started = runTask(
		nodeId,
		null,
		async ({ node, session }) => {
			const keys = generateMachineKey(node.name);
			const line = shellQuote(`restrict ${keys.publicKey}`);
			await session.run(
				`set -eu\numask 077\nprintf '%s\\n' ${line} >>"$HOME/.ssh/authorized_keys"`,
				{ label: "Authorizing the new key" },
			);
			const check = await openNodeSession({
				name: node.name,
				host: node.host,
				port: node.port,
				username: node.username,
				privateKey: keys.privateKey,
				hostKeyFingerprint: node.hostKeyFingerprint,
			});
			try {
				await check.run("true", { label: "Login with the new key" });
			} finally {
				check.close();
			}
			// Saved while both keys log in: the old one only goes afterwards.
			await db
				.update(githubRunnerNodes)
				.set({
					sshPrivateKey: keys.privateKey,
					sshPublicKey: keys.publicKey,
					sshKeyRotatedAt: new Date().toISOString(),
				})
				.where(eq(githubRunnerNodes.githubRunnerNodeId, nodeId));
			saved = true;
			try {
				await session.run(
					`set -eu\numask 077\nfile="$HOME/.ssh/authorized_keys"\nprintf '%s\\n' ${line} >"$file.new"\nmv -f "$file.new" "$file"`,
					{ label: "Removing the old key" },
				);
			} finally {
				closeSharedSessions(node);
			}
			pushEvent(nodeId, "SSH key rotated: the previous key no longer logs in");
		},
		async (error) => {
			const message = error instanceof Error ? error.message : String(error);
			failure = saved
				? new Error(
						`The new SSH key is in use, but the previous one is still authorized (${message}): rotate again to remove it`,
					)
				: error;
			pushEvent(
				nodeId,
				saved
					? `SSH key rotated, but the previous key is still authorized: ${message}`
					: `SSH key rotation failed, the previous key still works: ${message}`,
			);
		},
	);
	if (!started) {
		throw new Error(
			"Another task is running on this machine; try again in a moment",
		);
	}
	await state.tasks.get(nodeId);
	if (failure) throw failure;
};

/**
 * Removes the routing variable of a pool being deleted. A failure does not
 * keep the pool (its credentials may be gone): it is returned for the operator.
 */
export const clearPoolRouting = async (pool: GithubRunnerPool) => {
	const variable = pool.routing?.variable ?? pool.routingVariable;
	if (!variable) return null;
	try {
		await (await poolClient(pool)).deleteVariable(variable);
		return null;
	} catch (error) {
		return `The Actions variable ${variable} could not be deleted (${error instanceof Error ? error.message : String(error)}): delete it on GitHub, or the workflows keep reading it.`;
	}
};

const LIVE_SLOT = new Set(["active", "activating", "reloading"]);

/** A machine as fastest-first placement sees it, before this tick acts. */
const placementMachine = (
	observation: Observation,
	runners: GithubRunner[],
): PlacementMachine => {
	const { node, probe } = observation;
	const host = probe.host;
	const busyRunners = new Set(
		runners.filter((runner) => runner.busy).map((runner) => runner.name),
	);
	const busy = (probe.runtime?.slots ?? []).filter(
		(slot) =>
			LIVE_SLOT.has(slot.active) &&
			((slot.job && !slot.job.completedAt) ||
				(slot.runnerName !== null && busyRunners.has(slot.runnerName))),
	).length;
	return {
		id: node.githubRunnerNodeId,
		accepting:
			node.enabled &&
			node.phase === "ready" &&
			!node.drain &&
			Boolean(probe.runtime) &&
			node.observed?.admission?.ok !== false,
		maxRunners: host
			? resolveMaxRunners(node.maxRunners, node.platform, host, node)
			: 0,
		busy,
		speed: node.benchmark
			? { single: node.benchmark.single, multi: node.benchmark.multi }
			: null,
		cpus: host ? effectiveBudget(node.platform, host, node).cpus : 1,
	};
};

const tickPool = async (nodes: NodeWithRelations[]) => {
	const pool = nodes[0]?.pool;
	if (!pool) return;
	for (const node of nodes) ticking.add(node.githubRunnerNodeId);
	const observations: Observation[] = [];
	try {
		observations.push(
			...(await Promise.all(nodes.map(observeNode))).filter(
				(item): item is Observation => item !== null,
			),
		);
		const lost = nodes.filter((node) =>
			unreachable.has(node.githubRunnerNodeId),
		);
		if (!observations.length && !lost.length) return;
		let runners: GithubRunner[] | null = null;
		let listError: string | null = null;
		try {
			runners = await (await poolClient(pool)).listRunners();
			state.poolRunners.set(pool.githubRunnerPoolId, {
				at: Date.now(),
				runners,
			});
		} catch (error) {
			listError = `GitHub: ${error instanceof Error ? error.message : String(error)}`;
		}
		if (runners) {
			for (const node of lost) await detectLostJobs(node, runners);
		}
		// Where runners wait across the pool: only where a new job runs fastest.
		const waiting = placeWaitingRunners(
			observations.map((observation) =>
				placementMachine(observation, runners ?? []),
			),
			pool.placement,
		);
		await Promise.all(
			observations.map(async (observation) => {
				const id = observation.node.githubRunnerNodeId;
				let drained = false;
				try {
					drained = await actOnNode(
						observation,
						runners,
						listError,
						waiting.get(id),
					);
				} catch (error) {
					console.error(
						`GitHub runner tick failed for ${observation.node.name}`,
						error,
					);
				} finally {
					observation.session.close();
					await releaseLease(id).catch(() => undefined);
					ticking.delete(id);
				}
				if (drained) startDrainCompletion(id);
			}),
		);
	} finally {
		for (const node of nodes) ticking.delete(node.githubRunnerNodeId);
	}
};

const RUNNER_RELEASES_TTL_MS = 6 * 60 * 60_000;
const RUNNER_RELEASES_RETRY_MS = 15 * 60_000;

/** Refreshes the known actions/runner releases in the background, every 6 hours. */
const refreshRunnerReleases = (pools: GithubRunnerPool[]) => {
	const known = state.runnerReleases;
	if (known && Date.now() - known.at < RUNNER_RELEASES_TTL_MS) return;
	if (Date.now() - state.runnerReleasesTriedAt < RUNNER_RELEASES_RETRY_MS) {
		return;
	}
	state.runnerReleasesTriedAt = Date.now();
	void (async () => {
		// Authenticated when a pool allows it: the anonymous quota is shared by
		// every tool behind the same public IP.
		const pool = pools.find(
			(item) => new URL(item.apiUrl).hostname === "api.github.com",
		);
		const authorization = pool
			? await (await poolClient(pool)).authorization().catch(() => undefined)
			: undefined;
		const releases = await listRunnerReleases({ authorization });
		state.runnerReleases = { at: Date.now(), releases };
	})().catch((error) =>
		console.error(
			"GitHub runners: unable to list the actions/runner releases",
			error instanceof Error ? error.message : error,
		),
	);
};

/**
 * The actions/runner releases this process knows, newest first or not. Given
 * the pools, a stale list is refreshed in the background: a process that does
 * not lead (the Dokploy server next to a standalone controller) does not tick.
 */
export const knownRunnerReleases = (pools?: GithubRunnerPool[]) => {
	if (pools?.length) refreshRunnerReleases(pools);
	return state.runnerReleases?.releases ?? [];
};

// ------------------------------------------------------------- alerts

const ALERTS_EVERY_MS = 30_000;
const TOKEN_CHECK_EVERY_MS = 6 * 60 * 60_000;
const TOKEN_CHECK_RETRY_MS = 15 * 60_000;

/**
 * Asks GitHub whether each pool's personal access token is still accepted and
 * when it expires, in the background. A failed check keeps the last answer.
 */
const refreshTokenChecks = (pools: GithubRunnerPool[]) => {
	const now = Date.now();
	for (const pool of pools) {
		const poolId = pool.githubRunnerPoolId;
		if (pool.authType !== "token" || !pool.token) {
			state.tokenChecks.delete(poolId);
			continue;
		}
		const token = pool.token;
		const hash = createHash("sha256").update(token).digest("hex");
		const known = state.tokenChecks.get(poolId);
		const sameToken = known?.hash === hash;
		const wait = known?.result ? TOKEN_CHECK_EVERY_MS : TOKEN_CHECK_RETRY_MS;
		if (sameToken && now - known.at < wait) continue;
		const entry = {
			at: now,
			hash,
			result: sameToken ? (known?.result ?? null) : null,
		};
		state.tokenChecks.set(poolId, entry);
		void checkToken(token, pool.apiUrl)
			.then((result) => {
				entry.result = result;
			})
			.catch(() => undefined);
	}
};

/**
 * Opens, updates and resolves the alerts of every pool, and notifies them.
 * Every Dokploy instance evaluates them; the conditional writes of
 * syncRunnerAlerts make a single one notify each change.
 */
const evaluateAlerts = async () => {
	const now = Date.now();
	if (now - state.lastAlertsAt < ALERTS_EVERY_MS) return;
	state.lastAlertsAt = now;
	const [pools, nodes] = await Promise.all([
		db.query.githubRunnerPools.findMany(),
		db.query.githubRunnerNodes.findMany(),
	]);
	refreshTokenChecks(pools);
	const runnerReleases = knownRunnerReleases();
	await Promise.all(
		pools.map(async (pool) => {
			const poolNodes = nodes.filter(
				(node) => node.githubRunnerPoolId === pool.githubRunnerPoolId,
			);
			try {
				const { conditions, unknown } = runnerAlerts({
					pool,
					nodes: poolNodes,
					now,
					runnerReleases,
					osReleases: osReleasesIfKnown,
					token: state.tokenChecks.get(pool.githubRunnerPoolId)?.result ?? null,
				});
				const notices = await syncRunnerAlerts({
					pool,
					nodes: poolNodes,
					conditions,
					unknown,
					now,
				});
				for (const notice of notices) notify(pool, notice);
			} catch (error) {
				console.error(`GitHub runner alerts failed for ${pool.name}`, error);
			}
		}),
	);
};

const tickGithubRunners = async () => {
	if (!state.leader) return;
	if (state.running) {
		state.rerun = true;
		return;
	}
	state.running = true;
	try {
		const nodes = (await db.query.githubRunnerNodes.findMany({
			with: { pool: true, sshKey: { columns: { privateKey: true } } },
		})) as NodeWithRelations[];
		const ids = new Set(nodes.map((node) => node.githubRunnerNodeId));
		for (const nodeId of state.reconnects.keys()) {
			if (!ids.has(nodeId)) state.reconnects.delete(nodeId);
		}
		const byPool = new Map<string, NodeWithRelations[]>();
		for (const node of nodes) {
			if (
				node.phase === "enrolling" ||
				node.phase === "new" ||
				node.phase === "provisioning"
			) {
				continue;
			}
			const list = byPool.get(node.githubRunnerPoolId) ?? [];
			list.push(node);
			byPool.set(node.githubRunnerPoolId, list);
		}
		await Promise.all([...byPool.values()].map(tickPool));
		await routePools();
		const pools = new Map(
			nodes.map((node) => [node.githubRunnerPoolId, node.pool]),
		);
		refreshRunnerReleases([...pools.values()]);
		await Promise.all(
			[...pools.values()].map((pool) =>
				recoverInterruptedJobs(pool).catch((error) =>
					console.error(
						`GitHub runner job recovery failed for ${pool.name}`,
						error,
					),
				),
			),
		);
		await evaluateAlerts();
		if (Date.now() - state.lastPurge > 60 * 60_000) {
			state.lastPurge = Date.now();
			await db
				.delete(githubRunnerMetrics)
				.where(
					lt(
						githubRunnerMetrics.at,
						new Date(Date.now() - METRIC_RETENTION_MS).toISOString(),
					),
				);
			const historyCutoff = new Date(
				Date.now() - HISTORY_RETENTION_MS,
			).toISOString();
			await db
				.delete(githubRunnerJobs)
				.where(
					and(
						lt(githubRunnerJobs.startedAt, historyCutoff),
						or(
							isNull(githubRunnerJobs.rerunStatus),
							notInArray(githubRunnerJobs.rerunStatus, [
								"pending",
								"cancelling",
							]),
						),
					),
				);
			await db
				.delete(githubRunnerOperations)
				.where(
					and(
						lt(githubRunnerOperations.createdAt, historyCutoff),
						ne(githubRunnerOperations.status, "running"),
					),
				);
			await db
				.delete(githubRunnerAlerts)
				.where(lt(githubRunnerAlerts.resolvedAt, historyCutoff));
		}
	} catch (error) {
		console.error("GitHub runner controller tick failed", error);
	} finally {
		state.running = false;
		if (state.rerun) {
			state.rerun = false;
			requestTick();
		}
	}
};

/** Runs a tick soon, e.g. right after an operator action. */
export const requestTick = () => {
	if (!state.timer || state.pendingTick) return;
	state.pendingTick = setTimeout(() => {
		state.pendingTick = null;
		void tickGithubRunners();
	}, 250);
};

/**
 * Work left behind by a process that stopped: its leases expired, so nobody
 * renews them. Provisioning starts again from scratch (by the operator); a drain
 * is level-triggered and simply goes on. Operations younger than a minute are
 * left alone: their task may not hold its lease yet.
 */
const recoverOrphanedWork = async () => {
	const now = new Date();
	const nowIso = now.toISOString();
	const leased = (node: { lockedUntil: string | null } | undefined) =>
		Boolean(node?.lockedUntil && node.lockedUntil > nowIso);
	const [running, nodes] = await Promise.all([
		db.query.githubRunnerOperations.findMany({
			where: and(
				eq(githubRunnerOperations.status, "running"),
				lt(
					githubRunnerOperations.createdAt,
					new Date(now.getTime() - 60_000).toISOString(),
				),
			),
			columns: { logs: false },
		}),
		db.query.githubRunnerNodes.findMany({
			columns: {
				githubRunnerNodeId: true,
				phase: true,
				drain: true,
				lockedUntil: true,
				updateState: true,
			},
		}),
	]);
	const byId = new Map(nodes.map((node) => [node.githubRunnerNodeId, node]));
	const orphaned = running.filter((operation) => {
		const node = byId.get(operation.githubRunnerNodeId);
		if (node?.drain?.operationId === operation.githubRunnerOperationId) {
			return false;
		}
		return !leased(node) && !tasks.has(operation.githubRunnerNodeId);
	});
	await Promise.all(
		orphaned.map(async (operation) => {
			const message = "Interrupted: the Dokploy process running it stopped";
			await appendOperationLog(operation.githubRunnerOperationId, message);
			await finishOperation(
				operation.githubRunnerOperationId,
				"error",
				message,
			);
		}),
	);
	const free = nodes.filter(
		(node) => !leased(node) && !tasks.has(node.githubRunnerNodeId),
	);
	const stuck = free.filter((node) => node.phase === "provisioning");
	if (stuck.length) {
		await db
			.update(githubRunnerNodes)
			.set({
				phase: "error",
				lastError:
					"Provisioning interrupted: the Dokploy process running it stopped",
			})
			.where(
				and(
					inArray(
						githubRunnerNodes.githubRunnerNodeId,
						stuck.map((node) => node.githubRunnerNodeId),
					),
					eq(githubRunnerNodes.phase, "provisioning"),
				),
			);
	}
	// An update counted against the pool, left by a process that stopped. A
	// drain for OS updates holds no lease between ticks: its place stays.
	await Promise.all(
		free
			.filter(
				(node) =>
					node.updateState?.inProgress && node.drain?.reason !== "patch",
			)
			.map((node) =>
				db
					.update(githubRunnerNodes)
					.set({ updateState: { ...node.updateState, inProgress: null } })
					.where(
						eq(githubRunnerNodes.githubRunnerNodeId, node.githubRunnerNodeId),
					),
			),
	);
};

// ------------------------------------------------------------- leadership

/**
 * Takes or renews the leadership, in the database's clock so the instances'
 * clocks do not matter. Returns whether this process leads.
 */
const renewLeadership = async () => {
	const ttl = sql`now() + make_interval(secs => ${LEADER_TTL_S})`;
	const rows = await db
		.insert(githubRunnerLeader)
		.values({ id: 1, owner: OWNER, since: sql`now()`, until: ttl })
		.onConflictDoUpdate({
			target: githubRunnerLeader.id,
			set: {
				owner: OWNER,
				since: sql`CASE WHEN ${githubRunnerLeader.owner} = ${OWNER} THEN ${githubRunnerLeader.since} ELSE now() END`,
				until: ttl,
			},
			setWhere: sql`${githubRunnerLeader.owner} = ${OWNER} OR ${githubRunnerLeader.until} < now()`,
		})
		.returning({ owner: githubRunnerLeader.owner });
	return rows.length > 0;
};

const heartbeat = async () => {
	const now = new Date().toISOString();
	await db
		.insert(githubRunnerControllers)
		.values({
			owner: OWNER,
			kind: state.kind,
			host: hostname(),
			version: state.version,
			startedAt: state.startedAt,
			seenAt: now,
		})
		.onConflictDoUpdate({
			target: githubRunnerControllers.owner,
			set: { seenAt: now, version: state.version },
		});
	const leading = await renewLeadership();
	if (leading && !state.leader) {
		console.log(`GitHub runner controller: leading (${OWNER})`);
		state.leader = true;
		state.lastOrphanCheck = 0;
		requestTick();
	} else if (!leading && state.leader) {
		console.log(`GitHub runner controller: standing by (${OWNER})`);
		state.leader = false;
	}
	if (state.leader && Date.now() - state.lastOrphanCheck > ORPHANS_EVERY_MS) {
		state.lastOrphanCheck = Date.now();
		await recoverOrphanedWork();
		await db
			.delete(githubRunnerControllers)
			.where(
				lt(
					githubRunnerControllers.seenAt,
					new Date(Date.now() - 24 * 60 * 60_000).toISOString(),
				),
			);
	}
};

/** Who leads, and which controller processes answered lately. */
export const githubRunnerControllerStatus = async () => {
	const [leader, instances] = await Promise.all([
		db.query.githubRunnerLeader.findFirst({
			where: and(
				eq(githubRunnerLeader.id, 1),
				sql`${githubRunnerLeader.until} > now()`,
			),
		}),
		db.query.githubRunnerControllers.findMany({
			where: gte(
				githubRunnerControllers.seenAt,
				new Date(Date.now() - 30_000).toISOString(),
			),
		}),
	]);
	return {
		leader: leader
			? {
					owner: leader.owner,
					since: leader.since,
					instance:
						instances.find((instance) => instance.owner === leader.owner) ??
						null,
				}
			: null,
		standby: instances.filter((instance) => instance.owner !== leader?.owner),
	};
};

/**
 * Starts the controller of this process. Every process runs one: the Dokploy
 * server and, for high availability, standalone controllers on the same
 * database (dist/runner-controller.mjs). One leads and ticks; the others
 * renew their candidacy and take over within LEADER_TTL_S of its end. Every
 * process still runs the operations its users start, under machine leases.
 */
export const startGithubRunnerController = async (
	options: { kind?: "dokploy" | "standalone"; version?: string | null } = {},
) => {
	if (
		state.heartbeat ||
		process.env.DOKPLOY_GITHUB_RUNNERS_CONTROLLER === "false"
	)
		return;
	state.kind = options.kind ?? "dokploy";
	state.version = options.version ?? null;
	await heartbeat();
	state.heartbeat = setInterval(
		() =>
			void heartbeat().catch((error) => {
				// Without the database, nobody can tell who leads: stop ticking.
				if (state.leader)
					console.error("GitHub runner controller: lost the database", error);
				state.leader = false;
			}),
		HEARTBEAT_MS,
	);
	state.timer = setInterval(() => void tickGithubRunners(), TICK_MS);
	console.log(`GitHub runner controller started (${state.kind})`);
};

/** Stops ticking and hands the leadership over at once. */
export const stopGithubRunnerController = async () => {
	if (state.timer) clearInterval(state.timer);
	if (state.heartbeat) clearInterval(state.heartbeat);
	state.timer = null;
	state.heartbeat = null;
	if (state.leader) {
		state.leader = false;
		await db
			.delete(githubRunnerLeader)
			.where(eq(githubRunnerLeader.owner, OWNER))
			.catch(() => undefined);
	}
};

/** The host key a machine presents now, for the operator to approve after a reinstall. */
export const readPresentedHostKey = async (nodeId: string) => {
	const node = await loadRunnerNode(nodeId);
	// The machine's own key (setup script) or the shared SSH key.
	const session = await openNodeSession({
		name: node.name,
		host: node.host,
		port: node.port,
		username: node.username,
		privateKey: nodePrivateKey(node),
		hostKeyFingerprint: null,
	});
	session.close();
	return session.fingerprint;
};
