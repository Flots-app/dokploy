import { relations, sql } from "drizzle-orm";
import {
	bigint,
	bigserial,
	boolean,
	check,
	doublePrecision,
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	text,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { z } from "zod";
import { organization } from "./account";
import { github } from "./github";
import { sshKeys } from "./ssh-key";
import { user } from "./user";
import { encryptedText } from "./utils";

export const githubRunnerScope = pgEnum("githubRunnerScope", [
	"organization",
	"repository",
]);

export const githubRunnerAuthType = pgEnum("githubRunnerAuthType", [
	"token",
	"app",
	"provider",
]);

export const githubRunnerPlatform = pgEnum("githubRunnerPlatform", [
	"linux",
	"macos",
]);

/**
 * Controller phase of a runner machine. `enabled` holds what the operator wants;
 * the phase is where the controller currently is on the way there.
 */
export const githubRunnerNodePhase = pgEnum("githubRunnerNodePhase", [
	"new",
	"provisioning",
	"ready",
	"draining",
	"stopped",
	"error",
]);

export const githubRunnerOperationType = pgEnum("githubRunnerOperationType", [
	"provision",
	"apply",
	"disable",
	"enable",
	"remove",
	"upgrade",
]);

export const githubRunnerOperationStatus = pgEnum(
	"githubRunnerOperationStatus",
	["running", "done", "error", "cancelled"],
);

export type GithubRunnerDrainMode = "wait" | "kill";

/** Why a machine stops taking jobs: once it is empty the controller finishes that action. */
export type GithubRunnerDrainReason = "disable" | "apply" | "remove";

export interface GithubRunnerDrain {
	mode: GithubRunnerDrainMode;
	reason: GithubRunnerDrainReason;
	requestedAt: string;
	/** With mode "wait": jobs still running at this time are interrupted. */
	deadline: string | null;
	operationId: string | null;
	/** With reason "remove": also delete the runtime (and the VM on macOS). */
	uninstall?: boolean;
}

/** What the controller last applied on the machine, compared with the desired settings. */
export interface GithubRunnerAppliedConfig {
	runtimeVersion: number;
	runnerVersion: string;
	cpuPercent: number;
	memoryPercent: number;
	vmDiskGb: number | null;
	cpus: number;
	memoryBytes: number;
	envHash: string;
	/** macOS: the VM was created by Dokploy, so removing the machine may delete it. */
	vmCreatedByDokploy?: boolean;
}

export type GithubRunnerSlotState =
	| "starting"
	| "idle"
	| "busy"
	| "stopping"
	| "exited";

export interface GithubRunnerJob {
	repository: string;
	runId: string;
	runAttempt: string;
	workflow: string;
	job: string;
	startedAt: string | null;
}

export interface GithubRunnerSlotObservation {
	slot: number;
	state: GithubRunnerSlotState;
	runnerName: string | null;
	runnerId: number | null;
	since: string | null;
	job: GithubRunnerJob | null;
}

export interface GithubRunnerNodeObservation {
	at: string;
	reachable: boolean;
	error?: string;
	host?: {
		os: string;
		arch: string;
		cpus: number;
		memoryBytes: number;
		diskFreeBytes: number;
		diskTotalBytes: number;
	};
	sandbox?: {
		kind: "vm" | "slice";
		state: string;
		cpus: number | null;
		memoryBytes: number | null;
		diskFreeBytes: number | null;
		diskTotalBytes?: number | null;
		memoryCurrentBytes: number | null;
	};
	runtime?: { version: number; runnerVersion: string | null };
	admission: { ok: boolean; reason?: string };
	slots: GithubRunnerSlotObservation[];
	/** Instant usage, computed from the counters of two consecutive probes. */
	usage?: {
		/** CPU used by the runners, in percent of their budget. */
		cpuPercent: number | null;
		memoryBytes: number | null;
		memoryLimitBytes: number | null;
		/** Host memory still available (macOS: memory_pressure free percentage). */
		hostMemoryFreePercent: number | null;
		hostLoad: number | null;
	};
	caches?: GithubRunnerCaches;
	/** Latest controller actions on the machine, newest first. */
	events?: { at: string; message: string }[];
}

export type GithubRunnerCleanupKind =
	| "containers"
	| "volumes"
	| "images"
	| "build_cache"
	| "tool_cache"
	| "home"
	| "workspaces"
	| "other";

/** One run of `runnerctl gc`, kept on the machine (latest first). */
export interface GithubRunnerCleanup {
	at: string;
	trigger: "low-disk" | "filling" | "routine" | "manual-light" | "manual-full";
	mode: "auto" | "light" | "full";
	/** Free space of the disk holding the caches (the VM disk on a Mac). */
	freeBeforeBytes: number;
	freeAfterBytes: number;
	targetBytes: number | null;
	reached: boolean;
	/** The step removing every cache: not needed, done, or skipped for running jobs. */
	idle: "not-needed" | "done" | "skipped-jobs";
	freed: { kind: GithubRunnerCleanupKind; bytes: number; count: number }[];
	/** Mac volume, before and after (macOS). */
	hostFreeBeforeBytes?: number | null;
	hostFreeAfterBytes?: number | null;
	durationMs: number;
	error?: string;
}

/** Disk used by what makes jobs fast; measured every few minutes. */
export interface GithubRunnerCaches {
	at: string;
	dockerImagesBytes: number | null;
	dockerBuildCacheBytes: number | null;
	dockerVolumesBytes: number | null;
	dockerContainersBytes: number | null;
	dockerReclaimableBytes: number | null;
	toolCacheBytes: number | null;
	homeCacheBytes: number | null;
	workspacesBytes: number | null;
}

/** Where the routing variable of a pool sends the jobs, as last published. */
export interface GithubRunnerRouting {
	/** Variable last written; differs from the pool setting until synced. */
	variable: string | null;
	target: "pool" | "fallback";
	value: string;
	/** When the target last changed. */
	since: string;
	/** Since when no runner of the pool is ON; the pool stays the target for a short grace. */
	unavailableSince: string | null;
	/** Value GitHub holds since the last successful write. */
	syncedValue: string | null;
	syncedAt: string | null;
	attemptedAt: string | null;
	error: string | null;
}

export const githubRunnerPools = pgTable(
	"github_runner_pool",
	{
		githubRunnerPoolId: text("githubRunnerPoolId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organizationId")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		description: text("description"),
		scope: githubRunnerScope("scope").notNull(),
		owner: text("owner").notNull(),
		repository: text("repository"),
		/** Organization runner group; repository runners always use the default group. */
		runnerGroup: text("runnerGroup").notNull().default("Default"),
		labels: jsonb("labels").$type<string[]>().notNull().default([]),
		apiUrl: text("apiUrl").notNull().default("https://api.github.com"),
		authType: githubRunnerAuthType("authType").notNull(),
		token: encryptedText("token"),
		appId: integer("appId"),
		appInstallationId: text("appInstallationId"),
		appPrivateKey: encryptedText("appPrivateKey"),
		githubId: text("githubId").references(() => github.githubId, {
			onDelete: "set null",
		}),
		/** null tracks the latest actions/runner release. */
		runnerVersion: text("runnerVersion"),
		/** KEY=VALUE lines added to the environment of every job. */
		runnerEnv: encryptedText("runnerEnv").notNull().default(""),
		jobStartedHook: text("jobStartedHook"),
		jobCompletedHook: text("jobCompletedHook"),
		/** Re-run the jobs a crashed or stopped machine interrupted, on the other machines. */
		rerunInterruptedJobs: boolean("rerunInterruptedJobs")
			.notNull()
			.default(true),
		/**
		 * GitHub Actions variable holding the runs-on of the pool while at least one
		 * of its runners is ON, and the fallback otherwise; null disables routing.
		 */
		routingVariable: text("routingVariable"),
		fallbackLabels: jsonb("fallbackLabels")
			.$type<string[]>()
			.notNull()
			.default(["ubuntu-24.04"]),
		routing: jsonb("routing").$type<GithubRunnerRouting | null>(),
		createdAt: text("createdAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
	},
	(table) => [
		uniqueIndex("github_runner_pool_org_name_unique").on(
			table.organizationId,
			table.name,
		),
		check(
			"github_runner_pool_repository_scope",
			sql`(${table.scope} = 'repository') = (${table.repository} IS NOT NULL)`,
		),
	],
);

export const githubRunnerNodes = pgTable(
	"github_runner_node",
	{
		githubRunnerNodeId: text("githubRunnerNodeId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		githubRunnerPoolId: text("githubRunnerPoolId")
			.notNull()
			.references(() => githubRunnerPools.githubRunnerPoolId, {
				onDelete: "cascade",
			}),
		organizationId: text("organizationId")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		description: text("description"),
		host: text("host").notNull(),
		port: integer("port").notNull().default(22),
		username: text("username").notNull(),
		sshKeyId: text("sshKeyId").references(() => sshKeys.sshKeyId, {
			onDelete: "set null",
		}),
		/** SHA256 fingerprint pinned on first contact; any other host key is refused. */
		hostKeyFingerprint: text("hostKeyFingerprint"),
		platform: githubRunnerPlatform("platform").notNull(),
		vmName: text("vmName").notNull().default("dokploy-runners"),
		vmDiskGb: integer("vmDiskGb").notNull().default(60),
		cpuPercent: integer("cpuPercent").notNull().default(70),
		memoryPercent: integer("memoryPercent").notNull().default(70),
		diskReserveGb: integer("diskReserveGb").notNull().default(15),
		/** Below this much free space, the least recently used caches are removed. */
		diskCleanupGb: integer("diskCleanupGb").notNull().default(30),
		/** Concurrent jobs; 0 sizes it from the budget (2 CPUs and 3 GiB per job). */
		maxRunners: integer("maxRunners").notNull().default(0),
		extraLabels: jsonb("extraLabels").$type<string[]>().notNull().default([]),
		enabled: boolean("enabled").notNull().default(true),
		phase: githubRunnerNodePhase("phase").notNull().default("new"),
		drain: jsonb("drain").$type<GithubRunnerDrain | null>(),
		applied: jsonb("applied").$type<GithubRunnerAppliedConfig | null>(),
		observed: jsonb("observed").$type<GithubRunnerNodeObservation | null>(),
		lastSeenAt: text("lastSeenAt"),
		lastError: text("lastError"),
		lastPrunedAt: text("lastPrunedAt"),
		cleanups: jsonb("cleanups")
			.$type<GithubRunnerCleanup[]>()
			.notNull()
			.default([]),
		// Lease taken by the controller (or an operation) working on this machine.
		lockedBy: text("lockedBy"),
		lockedUntil: text("lockedUntil"),
		createdAt: text("createdAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
	},
	(table) => [
		// The name prefixes the GitHub runner names, which must not collide.
		uniqueIndex("github_runner_node_org_name_unique").on(
			table.organizationId,
			table.name,
		),
		check(
			"github_runner_node_budget",
			sql`${table.cpuPercent} BETWEEN 10 AND 100 AND ${table.memoryPercent} BETWEEN 10 AND 100 AND ${table.maxRunners} BETWEEN 0 AND 32 AND ${table.diskReserveGb} >= 0 AND ${table.diskCleanupGb} >= ${table.diskReserveGb}`,
		),
	],
);

export const githubRunnerOperations = pgTable(
	"github_runner_operation",
	{
		githubRunnerOperationId: text("githubRunnerOperationId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organizationId")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		// Not foreign keys: the history outlives a removed machine or pool.
		githubRunnerNodeId: text("githubRunnerNodeId").notNull(),
		githubRunnerPoolId: text("githubRunnerPoolId").notNull(),
		nodeName: text("nodeName").notNull(),
		type: githubRunnerOperationType("type").notNull(),
		status: githubRunnerOperationStatus("status").notNull().default("running"),
		summary: text("summary").notNull().default(""),
		logs: text("logs").notNull().default(""),
		errorMessage: text("errorMessage"),
		createdBy: text("createdBy").references(() => user.id, {
			onDelete: "set null",
		}),
		createdAt: text("createdAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
		finishedAt: text("finishedAt"),
	},
	(table) => [
		index("github_runner_operation_node_idx").on(table.githubRunnerNodeId),
		uniqueIndex("github_runner_operation_running_unique")
			.on(table.githubRunnerNodeId)
			.where(sql`${table.status} = 'running'`),
	],
);

export const githubRunnerJobOutcome = pgEnum("githubRunnerJobOutcome", [
	"running",
	"completed",
	"interrupted",
]);

/**
 * Recovery of an interrupted job: "pending" until its run can be re-run,
 * "cancelling" while its run is force-cancelled, then "requested", "skipped" or
 * "failed" (see rerunNote).
 */
export const githubRunnerRerunStatus = pgEnum("githubRunnerRerunStatus", [
	"pending",
	"cancelling",
	"requested",
	"skipped",
	"failed",
]);

/** One row per job: every runner is ephemeral and runs a single job. */
export const githubRunnerJobs = pgTable(
	"github_runner_job",
	{
		githubRunnerJobId: text("githubRunnerJobId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organizationId")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		githubRunnerNodeId: text("githubRunnerNodeId")
			.notNull()
			.references(() => githubRunnerNodes.githubRunnerNodeId, {
				onDelete: "cascade",
			}),
		githubRunnerPoolId: text("githubRunnerPoolId").notNull(),
		runnerName: text("runnerName").notNull(),
		slot: integer("slot").notNull(),
		repository: text("repository").notNull(),
		workflow: text("workflow").notNull(),
		job: text("job").notNull(),
		runId: text("runId").notNull(),
		runAttempt: text("runAttempt").notNull(),
		outcome: githubRunnerJobOutcome("outcome").notNull().default("running"),
		startedAt: text("startedAt").notNull(),
		finishedAt: text("finishedAt"),
		durationSeconds: integer("durationSeconds"),
		rerunStatus: githubRunnerRerunStatus("rerunStatus"),
		rerunNote: text("rerunNote"),
		rerunAt: text("rerunAt"),
	},
	(table) => [
		uniqueIndex("github_runner_job_runner_unique").on(table.runnerName),
		index("github_runner_job_node_started_idx").on(
			table.githubRunnerNodeId,
			table.startedAt,
		),
	],
);

/** cancelling → requested (re-run asked) → rerouted (seen on the fallback) or failed. */
export const githubRunnerRerouteStatus = pgEnum("githubRunnerRerouteStatus", [
	"cancelling",
	"requested",
	"rerouted",
	"failed",
]);

/**
 * Runs whose jobs waited for the pool while none of its runners was ON: they
 * are cancelled, then their jobs re-run, which reads the routing variable again
 * and lands on the fallback runners. One reroute per run at most.
 */
export const githubRunnerReroutes = pgTable(
	"github_runner_reroute",
	{
		githubRunnerRerouteId: text("githubRunnerRerouteId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		githubRunnerPoolId: text("githubRunnerPoolId")
			.notNull()
			.references(() => githubRunnerPools.githubRunnerPoolId, {
				onDelete: "cascade",
			}),
		repository: text("repository").notNull(),
		runId: text("runId").notNull(),
		runAttempt: integer("runAttempt").notNull(),
		workflow: text("workflow").notNull(),
		status: githubRunnerRerouteStatus("status").notNull().default("cancelling"),
		note: text("note"),
		createdAt: text("createdAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
		updatedAt: text("updatedAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
	},
	(table) => [
		uniqueIndex("github_runner_reroute_run_unique").on(
			table.githubRunnerPoolId,
			table.repository,
			table.runId,
		),
	],
);

/** Usage samples behind the monitoring charts, kept seven days. */
export const githubRunnerMetrics = pgTable(
	"github_runner_metric",
	{
		id: bigserial("id", { mode: "number" }).primaryKey(),
		githubRunnerNodeId: text("githubRunnerNodeId")
			.notNull()
			.references(() => githubRunnerNodes.githubRunnerNodeId, {
				onDelete: "cascade",
			}),
		at: text("at").notNull(),
		cpuPercent: doublePrecision("cpuPercent"),
		memoryBytes: bigint("memoryBytes", { mode: "number" }),
		memoryLimitBytes: bigint("memoryLimitBytes", { mode: "number" }),
		hostMemoryFreePercent: doublePrecision("hostMemoryFreePercent"),
		diskFreeBytes: bigint("diskFreeBytes", { mode: "number" }),
		busyRunners: integer("busyRunners").notNull(),
		runners: integer("runners").notNull(),
	},
	(table) => [
		index("github_runner_metric_node_at_idx").on(
			table.githubRunnerNodeId,
			table.at,
		),
	],
);

export const githubRunnerPoolsRelations = relations(
	githubRunnerPools,
	({ one, many }) => ({
		organization: one(organization, {
			fields: [githubRunnerPools.organizationId],
			references: [organization.id],
		}),
		github: one(github, {
			fields: [githubRunnerPools.githubId],
			references: [github.githubId],
		}),
		nodes: many(githubRunnerNodes),
	}),
);

export const githubRunnerNodesRelations = relations(
	githubRunnerNodes,
	({ one }) => ({
		pool: one(githubRunnerPools, {
			fields: [githubRunnerNodes.githubRunnerPoolId],
			references: [githubRunnerPools.githubRunnerPoolId],
		}),
		sshKey: one(sshKeys, {
			fields: [githubRunnerNodes.sshKeyId],
			references: [sshKeys.sshKeyId],
		}),
		organization: one(organization, {
			fields: [githubRunnerNodes.organizationId],
			references: [organization.id],
		}),
	}),
);

export const githubRunnerOperationsRelations = relations(
	githubRunnerOperations,
	({ one }) => ({
		user: one(user, {
			fields: [githubRunnerOperations.createdBy],
			references: [user.id],
		}),
	}),
);

export type GithubRunnerPool = typeof githubRunnerPools.$inferSelect;
export type GithubRunnerNode = typeof githubRunnerNodes.$inferSelect;
export type GithubRunnerOperation = typeof githubRunnerOperations.$inferSelect;
export type GithubRunnerJobRecord = typeof githubRunnerJobs.$inferSelect;
export type GithubRunnerMetric = typeof githubRunnerMetrics.$inferSelect;

// GitHub accepts letters, digits, "-", "_" and "." in labels; the runtime
// writes them in shell files, so nothing else gets through.
const label = z
	.string()
	.trim()
	.min(1)
	.max(100)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "Invalid label");

const githubName = z
	.string()
	.trim()
	.min(1)
	.max(100)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "Invalid GitHub name");

const absolutePath = z
	.string()
	.trim()
	.regex(/^\/[A-Za-z0-9._/-]+$/, "Must be an absolute path")
	.nullable()
	.default(null);

const envLines = z
	.string()
	.default("")
	.refine(
		(value) =>
			value
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line && !line.startsWith("#"))
				.every((line) => /^[A-Za-z_][A-Za-z0-9_]*=[^\0\r]*$/.test(line)),
		"Each line must be KEY=VALUE",
	);

const poolFields = z.object({
	name: z.string().trim().min(1).max(64),
	description: z.string().trim().max(500).nullable().default(null),
	scope: z.enum(["organization", "repository"]),
	owner: githubName,
	repository: githubName.nullable().default(null),
	runnerGroup: z.string().trim().min(1).max(100).default("Default"),
	labels: z.array(label).max(50).default([]),
	apiUrl: z
		.string()
		.trim()
		.url()
		.regex(/^https:\/\//, "Must use https")
		.default("https://api.github.com"),
	authType: z.enum(["token", "app", "provider"]),
	token: z.string().trim().min(1).nullable().default(null),
	appId: z.number().int().positive().nullable().default(null),
	appInstallationId: z.string().trim().regex(/^\d+$/).nullable().default(null),
	appPrivateKey: z.string().trim().min(1).nullable().default(null),
	githubId: z.string().min(1).nullable().default(null),
	runnerVersion: z
		.string()
		.trim()
		.regex(/^\d+\.\d+\.\d+$/, "Use a version such as 2.329.0")
		.nullable()
		.default(null),
	runnerEnv: envLines,
	jobStartedHook: absolutePath,
	jobCompletedHook: absolutePath,
	rerunInterruptedJobs: z.boolean().default(true),
	routingVariable: z
		.string()
		.trim()
		.max(100)
		.regex(
			/^[A-Za-z_][A-Za-z0-9_]*$/,
			"Letters, digits and underscores, not starting with a digit",
		)
		.refine((name) => !/^github_/i.test(name), "Cannot start with GITHUB_")
		.nullable()
		.default(null),
	fallbackLabels: z.array(label).min(1).max(10).default(["ubuntu-24.04"]),
});

const checkPoolTarget = (
	pool: {
		scope: "organization" | "repository";
		repository: string | null;
		labels: string[];
		routingVariable: string | null;
	},
	ctx: z.RefinementCtx,
) => {
	if ((pool.scope === "repository") !== Boolean(pool.repository)) {
		ctx.addIssue({
			code: "custom",
			path: ["repository"],
			message:
				"A repository pool needs a repository, an organization pool none",
		});
	}
	if (pool.routingVariable && !pool.labels.length) {
		ctx.addIssue({
			code: "custom",
			path: ["labels"],
			message:
				"The fallback needs a label: without one, every self-hosted job would count as waiting for this pool",
		});
	}
};

export const apiCreateGithubRunnerPool = poolFields.superRefine((pool, ctx) => {
	checkPoolTarget(pool, ctx);
	const missing =
		(pool.authType === "token" && !pool.token) ||
		(pool.authType === "app" && (!pool.appId || !pool.appPrivateKey)) ||
		(pool.authType === "provider" && !pool.githubId);
	if (missing) {
		ctx.addIssue({
			code: "custom",
			path: ["authType"],
			message: "Missing credentials for this authentication method",
		});
	}
});

/** Secrets (token, App key, environment) left null keep their stored value. */
export const apiUpdateGithubRunnerPool = poolFields
	.extend({
		githubRunnerPoolId: z.string().min(1),
		runnerEnv: envLines.nullable().default(null),
	})
	.superRefine(checkPoolTarget);

export const apiFindGithubRunnerPool = z.object({
	githubRunnerPoolId: z.string().min(1),
});

export const apiTestGithubRunnerCredentials = poolFields
	.extend({ githubRunnerPoolId: z.string().min(1).nullable().default(null) })
	.superRefine(checkPoolTarget);

const nodeName = z
	.string()
	.trim()
	.min(1)
	.max(24)
	.regex(
		/^[a-z0-9][a-z0-9-]*$/,
		"Lowercase letters, digits and hyphens; it prefixes the runner names",
	);

const budgetFields = {
	cpuPercent: z.number().int().min(10).max(100),
	memoryPercent: z.number().int().min(10).max(100),
	diskReserveGb: z.number().int().min(0).max(10_000),
	diskCleanupGb: z.number().int().min(1).max(10_000),
	maxRunners: z.number().int().min(0).max(32),
	vmDiskGb: z.number().int().min(20).max(4096),
	extraLabels: z.array(label).max(20),
};

const cleanupAboveReserve = (value: {
	diskReserveGb: number;
	diskCleanupGb: number;
}) => value.diskCleanupGb > value.diskReserveGb;

const cleanupAboveReserveError = {
	message: "Caches must be cleaned before the disk reaches the reserve",
	path: ["diskCleanupGb"],
};

const connectionFields = {
	host: z
		.string()
		.trim()
		.min(1)
		.max(255)
		.regex(/^[A-Za-z0-9.:_-]+$/, "Invalid host"),
	port: z.number().int().min(1).max(65535).default(22),
	username: z
		.string()
		.trim()
		.min(1)
		.max(64)
		.regex(/^[a-z_][a-z0-9_.-]*$/i, "Invalid username"),
	sshKeyId: z.string().min(1),
	platform: z.enum(["linux", "macos"]),
	vmName: z
		.string()
		.trim()
		.min(1)
		.max(40)
		.regex(/^[a-z0-9][a-z0-9-]*$/, "Invalid VM name")
		.default("dokploy-runners"),
};

export const apiCheckGithubRunnerNode = z.object({
	...connectionFields,
	githubRunnerNodeId: z.string().min(1).nullable().default(null),
	cpuPercent: budgetFields.cpuPercent.default(70),
	memoryPercent: budgetFields.memoryPercent.default(70),
	diskReserveGb: budgetFields.diskReserveGb.default(15),
	diskCleanupGb: budgetFields.diskCleanupGb.default(30),
	maxRunners: budgetFields.maxRunners.default(0),
	vmDiskGb: budgetFields.vmDiskGb.default(60),
});

export const apiCreateGithubRunnerNode = z
	.object({
		githubRunnerPoolId: z.string().min(1),
		name: nodeName,
		description: z.string().trim().max(500).nullable().default(null),
		...connectionFields,
		/** Fingerprint shown by the checks and accepted by the operator. */
		hostKeyFingerprint: z.string().min(1),
		cpuPercent: budgetFields.cpuPercent.default(70),
		memoryPercent: budgetFields.memoryPercent.default(70),
		diskReserveGb: budgetFields.diskReserveGb.default(15),
		diskCleanupGb: budgetFields.diskCleanupGb.default(30),
		maxRunners: budgetFields.maxRunners.default(0),
		vmDiskGb: budgetFields.vmDiskGb.default(60),
		extraLabels: budgetFields.extraLabels.default([]),
	})
	.refine(cleanupAboveReserve, cleanupAboveReserveError);

export const apiFindGithubRunnerNode = z.object({
	githubRunnerNodeId: z.string().min(1),
});

const drainMode = z.enum(["wait", "kill"]);

export const apiUpdateGithubRunnerNode = z
	.object({
		githubRunnerNodeId: z.string().min(1),
		description: z.string().trim().max(500).nullable(),
		...budgetFields,
		/** How running jobs are handled when the change needs a VM restart. */
		mode: drainMode.default("wait"),
	})
	.refine(cleanupAboveReserve, cleanupAboveReserveError);

export const apiCleanGithubRunnerNode = z.object({
	githubRunnerNodeId: z.string().min(1),
	/** light: only waste; full: every cache, once no job runs. */
	mode: z.enum(["light", "full"]),
});

export const apiDisableGithubRunnerNode = z.object({
	githubRunnerNodeId: z.string().min(1),
	mode: drainMode,
	/** With mode "wait": interrupt the jobs still running after this many minutes. */
	timeoutMinutes: z
		.number()
		.int()
		.min(1)
		.max(24 * 60)
		.nullable()
		.default(null),
});

export const apiRemoveGithubRunnerNode = z.object({
	githubRunnerNodeId: z.string().min(1),
	mode: drainMode,
	uninstall: z.boolean().default(true),
	timeoutMinutes: z
		.number()
		.int()
		.min(1)
		.max(24 * 60)
		.nullable()
		.default(null),
	/** Forget the machine without reaching it (it is gone or unreachable). */
	force: z.boolean().default(false),
});

export const apiGithubRunnerOperations = z.object({
	githubRunnerNodeId: z.string().min(1),
	limit: z.number().int().min(1).max(100).default(20),
});

export const apiGithubRunnerMetrics = z.object({
	githubRunnerNodeId: z.string().min(1),
	hours: z.number().int().min(1).max(168).default(6),
});

export const apiGithubRunnerJobs = z.object({
	githubRunnerPoolId: z.string().min(1),
	githubRunnerNodeId: z.string().min(1).nullable().default(null),
	limit: z.number().int().min(1).max(200).default(50),
});

export const apiFindGithubRunnerOperation = z.object({
	githubRunnerOperationId: z.string().min(1),
});
