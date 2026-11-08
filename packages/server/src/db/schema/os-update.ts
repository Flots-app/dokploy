import { relations, sql } from "drizzle-orm";
import {
	boolean,
	check,
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { z } from "zod";
import {
	type OsUpdateSettings,
	osUpdateSettingsSchema,
} from "../../utils/os-updates/filters";
import {
	type OsUpdateSchedule,
	osUpdateScheduleSchema,
} from "../../utils/os-updates/schedule";
import type {
	PackageChange,
	ServerAssessment,
} from "../../utils/os-updates/scripts";
import { organization } from "./account";
import { githubRunnerNodes } from "./github-runner";
import { server } from "./server";

export const osUpdateClassification = pgEnum("osUpdateClassification", [
	"security",
	"all",
]);
export const osUpdateReboot = pgEnum("osUpdateReboot", [
	"if-required",
	"never",
	"always",
]);
/**
 * pending: waits for its turn; running: a Dokploy process holds it;
 * succeeded / failed; skipped: never started (the window closed before its
 * turn, the server is inactive...); missed: no Dokploy ran during its window;
 * cancelled: by a user before it started.
 */
export const osUpdateRunStatus = pgEnum("osUpdateRunStatus", [
	"pending",
	"running",
	"succeeded",
	"failed",
	"skipped",
	"missed",
	"cancelled",
]);
export const osUpdateTrigger = pgEnum("osUpdateTrigger", [
	"schedule",
	"manual",
]);

/**
 * A maintenance configuration: when the servers assigned to it may install
 * their OS updates, and which ones.
 */
export const osUpdateConfigurations = pgTable(
	"os_update_configuration",
	{
		osUpdateConfigurationId: text("osUpdateConfigurationId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organizationId")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		description: text("description"),
		enabled: boolean("enabled").notNull().default(true),
		schedule: jsonb("schedule").$type<OsUpdateSchedule>().notNull(),
		classification: osUpdateClassification("classification")
			.notNull()
			.default("security"),
		includePackages: jsonb("includePackages")
			.$type<string[]>()
			.notNull()
			.default([]),
		excludePackages: jsonb("excludePackages")
			.$type<string[]>()
			.notNull()
			.default([]),
		reboot: osUpdateReboot("reboot").notNull().default("if-required"),
		allowDockerUpdates: boolean("allowDockerUpdates").notNull().default(false),
		notifyOnSuccess: boolean("notifyOnSuccess").notNull().default(false),
		createdAt: text("createdAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
		/** Changes the windows: earlier ones are never reported missed. */
		updatedAt: text("updatedAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
	},
	(table) => [
		uniqueIndex("os_update_configuration_org_name_unique").on(
			table.organizationId,
			table.name,
		),
	],
);

/**
 * What OS updates keep for a machine (a server, a runner machine): its
 * configuration, and what its last assessment found.
 */
const machineColumns = () => ({
	osUpdateConfigurationId: text("osUpdateConfigurationId").references(
		() => osUpdateConfigurations.osUpdateConfigurationId,
		{ onDelete: "set null" },
	),
	/** Windows before this are never reported missed for the machine. */
	assignedAt: text("assignedAt"),
	/** Assessed again every 24 hours. */
	periodicAssessment: boolean("periodicAssessment").notNull().default(true),
	assessment: jsonb("assessment").$type<ServerAssessment>(),
	assessedAt: text("assessedAt"),
	assessmentError: text("assessmentError"),
	/** "Check now": the controller assesses the machine at its next tick. */
	assessmentRequestedAt: text("assessmentRequestedAt"),
	assessmentTriedAt: text("assessmentTriedAt"),
});

/**
 * OS updates of one server: its configuration, and what its last assessment
 * found. A server without a row has never been assessed nor assigned.
 */
export const osUpdateServers = pgTable("os_update_server", {
	serverId: text("serverId")
		.notNull()
		.primaryKey()
		.references(() => server.serverId, { onDelete: "cascade" }),
	...machineColumns(),
});

/**
 * OS updates of one Linux GitHub runner machine, as os_update_server for a
 * server. Its runs drain it first: no new job, and the running ones end.
 */
export const osUpdateRunnerNodes = pgTable("os_update_runner_node", {
	githubRunnerNodeId: text("githubRunnerNodeId")
		.notNull()
		.primaryKey()
		.references(() => githubRunnerNodes.githubRunnerNodeId, {
			onDelete: "cascade",
		}),
	...machineColumns(),
});

/** Where a run stands, so another Dokploy process can resume it. */
export interface OsUpdateRunProgress {
	/** drain: a runner machine waits for its jobs to end (runner machines only). */
	step: "drain" | "prepare" | "install" | "reboot";
	/** Bytes of the current step's log already copied. */
	logOffset: number;
	/** Packages the install step may change. */
	allowed: string[] | null;
	/** Boot id before the reboot Dokploy asked for. */
	bootId: string | null;
	rebootRequestedAt: string | null;
	/** Runner machines: when the run took the machine out of service. */
	drainStartedAt?: string | null;
}

export interface OsUpdateRunPackage extends PackageChange {
	/** From a security pocket; null for a package pulled in as a dependency. */
	security: boolean | null;
}

/**
 * One installation on one machine (a server, or a runner machine): scheduled
 * in a window, or on demand.
 */
export const osUpdateRuns = pgTable(
	"os_update_run",
	{
		osUpdateRunId: text("osUpdateRunId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organizationId")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		serverId: text("serverId").references(() => server.serverId, {
			onDelete: "cascade",
		}),
		githubRunnerNodeId: text("githubRunnerNodeId").references(
			() => githubRunnerNodes.githubRunnerNodeId,
			{ onDelete: "cascade" },
		),
		osUpdateConfigurationId: text("osUpdateConfigurationId").references(
			() => osUpdateConfigurations.osUpdateConfigurationId,
			{ onDelete: "set null" },
		),
		trigger: osUpdateTrigger("trigger").notNull(),
		status: osUpdateRunStatus("status").notNull().default("pending"),
		/** Scheduled runs: the window they belong to. */
		windowStart: text("windowStart"),
		/** No install starts after this (the window's end, or a manual run's limit). */
		deadline: text("deadline").notNull(),
		settings: jsonb("settings").$type<OsUpdateSettings>().notNull(),
		requestedBy: text("requestedBy"),
		createdAt: text("createdAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
		startedAt: text("startedAt"),
		finishedAt: text("finishedAt"),
		attempts: integer("attempts").notNull().default(0),
		lockedBy: text("lockedBy"),
		lockedUntil: timestamp("lockedUntil", {
			withTimezone: true,
			mode: "string",
		}),
		progress: jsonb("progress").$type<OsUpdateRunProgress>(),
		packages: jsonb("packages")
			.$type<OsUpdateRunPackage[]>()
			.notNull()
			.default([]),
		rebootRequired: boolean("rebootRequired"),
		rebooted: boolean("rebooted").notNull().default(false),
		/** The outcome in a sentence (the error of a failed run). */
		message: text("message"),
		log: text("log").notNull().default(""),
	},
	(table) => [
		index("os_update_run_org_created_idx").on(
			table.organizationId,
			table.createdAt,
		),
		index("os_update_run_server_idx").on(table.serverId),
		index("os_update_run_runner_node_idx").on(table.githubRunnerNodeId),
		// A server or a runner machine, never both.
		check(
			"os_update_run_one_machine",
			sql`num_nonnulls(${table.serverId}, ${table.githubRunnerNodeId}) = 1`,
		),
		// One run per machine and window, whatever the restarts.
		uniqueIndex("os_update_run_window_unique")
			.on(table.serverId, table.osUpdateConfigurationId, table.windowStart)
			.where(sql`${table.trigger} = 'schedule'`),
		uniqueIndex("os_update_run_runner_window_unique")
			.on(
				table.githubRunnerNodeId,
				table.osUpdateConfigurationId,
				table.windowStart,
			)
			.where(sql`${table.trigger} = 'schedule'`),
		// One run at a time on a machine...
		uniqueIndex("os_update_run_server_running_unique")
			.on(table.serverId)
			.where(sql`${table.status} = 'running'`),
		uniqueIndex("os_update_run_runner_running_unique")
			.on(table.githubRunnerNodeId)
			.where(sql`${table.status} = 'running'`),
		// ...and one machine at a time per configuration.
		uniqueIndex("os_update_run_configuration_running_unique")
			.on(table.osUpdateConfigurationId)
			.where(
				sql`${table.status} = 'running' AND ${table.trigger} = 'schedule'`,
			),
		// One Install now queued or running per machine, even for two
		// requests at the same instant.
		uniqueIndex("os_update_run_manual_active_unique")
			.on(table.serverId)
			.where(
				sql`${table.trigger} = 'manual' AND ${table.status} IN ('pending', 'running')`,
			),
		uniqueIndex("os_update_run_runner_manual_active_unique")
			.on(table.githubRunnerNodeId)
			.where(
				sql`${table.trigger} = 'manual' AND ${table.status} IN ('pending', 'running')`,
			),
	],
);

/**
 * Leases in the database's clock: the controller's leadership ("leader") and
 * the reboot of a Swarm manager ("swarm:<cluster id>").
 */
export const osUpdateLocks = pgTable("os_update_lock", {
	key: text("key").notNull().primaryKey(),
	owner: text("owner").notNull(),
	until: timestamp("until", { withTimezone: true, mode: "string" }).notNull(),
});

export const osUpdateConfigurationsRelations = relations(
	osUpdateConfigurations,
	({ one, many }) => ({
		organization: one(organization, {
			fields: [osUpdateConfigurations.organizationId],
			references: [organization.id],
		}),
		servers: many(osUpdateServers),
		runnerNodes: many(osUpdateRunnerNodes),
	}),
);

export const osUpdateServersRelations = relations(
	osUpdateServers,
	({ one }) => ({
		server: one(server, {
			fields: [osUpdateServers.serverId],
			references: [server.serverId],
		}),
		configuration: one(osUpdateConfigurations, {
			fields: [osUpdateServers.osUpdateConfigurationId],
			references: [osUpdateConfigurations.osUpdateConfigurationId],
		}),
	}),
);

export const osUpdateRunnerNodesRelations = relations(
	osUpdateRunnerNodes,
	({ one }) => ({
		node: one(githubRunnerNodes, {
			fields: [osUpdateRunnerNodes.githubRunnerNodeId],
			references: [githubRunnerNodes.githubRunnerNodeId],
		}),
		configuration: one(osUpdateConfigurations, {
			fields: [osUpdateRunnerNodes.osUpdateConfigurationId],
			references: [osUpdateConfigurations.osUpdateConfigurationId],
		}),
	}),
);

export const osUpdateRunsRelations = relations(osUpdateRuns, ({ one }) => ({
	server: one(server, {
		fields: [osUpdateRuns.serverId],
		references: [server.serverId],
	}),
	runnerNode: one(githubRunnerNodes, {
		fields: [osUpdateRuns.githubRunnerNodeId],
		references: [githubRunnerNodes.githubRunnerNodeId],
	}),
	configuration: one(osUpdateConfigurations, {
		fields: [osUpdateRuns.osUpdateConfigurationId],
		references: [osUpdateConfigurations.osUpdateConfigurationId],
	}),
}));

export type OsUpdateConfiguration = typeof osUpdateConfigurations.$inferSelect;
export type OsUpdateServer = typeof osUpdateServers.$inferSelect;
export type OsUpdateRunnerNode = typeof osUpdateRunnerNodes.$inferSelect;
export type OsUpdateRun = typeof osUpdateRuns.$inferSelect;

// ------------------------------------------------------------- API

const configurationFields = {
	name: z.string().trim().min(1).max(64),
	description: z.string().trim().max(500).nullable().default(null),
	enabled: z.boolean().default(true),
	schedule: osUpdateScheduleSchema,
	notifyOnSuccess: z.boolean().default(false),
	serverIds: z.array(z.string().min(1)).max(500).default([]),
	/** Linux GitHub runner machines. */
	runnerNodeIds: z.array(z.string().min(1)).max(500).default([]),
};

/** A server or a runner machine: one of the two ids, never both. */
const machineFields = {
	serverId: z.string().min(1).optional(),
	githubRunnerNodeId: z.string().min(1).optional(),
};
const oneMachine = (value: {
	serverId?: string;
	githubRunnerNodeId?: string;
}) => Boolean(value.serverId) !== Boolean(value.githubRunnerNodeId);
const ONE_MACHINE = {
	message: "Name a server or a runner machine",
	path: ["serverId"],
};

export const apiCreateOsUpdateConfiguration =
	osUpdateSettingsSchema.extend(configurationFields);

export const apiUpdateOsUpdateConfiguration =
	apiCreateOsUpdateConfiguration.extend({
		osUpdateConfigurationId: z.string().min(1),
	});

export const apiFindOsUpdateConfiguration = z.object({
	osUpdateConfigurationId: z.string().min(1),
});

export const apiSetOsUpdateConfigurationEnabled = z.object({
	osUpdateConfigurationId: z.string().min(1),
	enabled: z.boolean(),
});

export const apiOsUpdateMachine = z
	.object(machineFields)
	.refine(oneMachine, ONE_MACHINE);

export const apiAssignOsUpdateConfiguration = z
	.object({
		...machineFields,
		osUpdateConfigurationId: z.string().min(1).nullable(),
	})
	.refine(oneMachine, ONE_MACHINE);

export const apiSetOsUpdateAssessment = z
	.object({ ...machineFields, periodicAssessment: z.boolean() })
	.refine(oneMachine, ONE_MACHINE);

/** A one-time installation, outside any window. */
export const apiInstallOsUpdatesNow = osUpdateSettingsSchema
	.extend({
		...machineFields,
		/** No install starts after this long. */
		maxDurationMinutes: z.number().int().min(30).max(720).default(120),
	})
	.refine(oneMachine, ONE_MACHINE);

export const apiListOsUpdateRuns = z.object({
	...machineFields,
	limit: z.number().int().min(1).max(200).default(50),
});

export const apiFindOsUpdateRun = z.object({
	osUpdateRunId: z.string().min(1),
});
