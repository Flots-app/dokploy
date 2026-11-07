import { relations, sql } from "drizzle-orm";
import {
	boolean,
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
 * OS updates of one server: its configuration, and what its last assessment
 * found. A server without a row has never been assessed nor assigned.
 */
export const osUpdateServers = pgTable("os_update_server", {
	serverId: text("serverId")
		.notNull()
		.primaryKey()
		.references(() => server.serverId, { onDelete: "cascade" }),
	osUpdateConfigurationId: text("osUpdateConfigurationId").references(
		() => osUpdateConfigurations.osUpdateConfigurationId,
		{ onDelete: "set null" },
	),
	/** Windows before this are never reported missed for the server. */
	assignedAt: text("assignedAt"),
	/** Assessed again every 24 hours. */
	periodicAssessment: boolean("periodicAssessment").notNull().default(true),
	assessment: jsonb("assessment").$type<ServerAssessment>(),
	assessedAt: text("assessedAt"),
	assessmentError: text("assessmentError"),
	/** "Check now": the controller assesses the server at its next tick. */
	assessmentRequestedAt: text("assessmentRequestedAt"),
	assessmentTriedAt: text("assessmentTriedAt"),
});

/** Where a run stands, so another Dokploy process can resume it. */
export interface OsUpdateRunProgress {
	step: "prepare" | "install" | "reboot";
	/** Bytes of the current step's log already copied. */
	logOffset: number;
	/** Packages the install step may change. */
	allowed: string[] | null;
	/** Boot id before the reboot Dokploy asked for. */
	bootId: string | null;
	rebootRequestedAt: string | null;
}

export interface OsUpdateRunPackage extends PackageChange {
	/** From a security pocket; null for a package pulled in as a dependency. */
	security: boolean | null;
}

/** One installation on one server: scheduled in a window, or on demand. */
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
		serverId: text("serverId")
			.notNull()
			.references(() => server.serverId, { onDelete: "cascade" }),
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
		// One run per server and window, whatever the restarts.
		uniqueIndex("os_update_run_window_unique")
			.on(table.serverId, table.osUpdateConfigurationId, table.windowStart)
			.where(sql`${table.trigger} = 'schedule'`),
		// One run at a time on a server...
		uniqueIndex("os_update_run_server_running_unique")
			.on(table.serverId)
			.where(sql`${table.status} = 'running'`),
		// ...and one server at a time per configuration.
		uniqueIndex("os_update_run_configuration_running_unique")
			.on(table.osUpdateConfigurationId)
			.where(
				sql`${table.status} = 'running' AND ${table.trigger} = 'schedule'`,
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

export const osUpdateRunsRelations = relations(osUpdateRuns, ({ one }) => ({
	server: one(server, {
		fields: [osUpdateRuns.serverId],
		references: [server.serverId],
	}),
	configuration: one(osUpdateConfigurations, {
		fields: [osUpdateRuns.osUpdateConfigurationId],
		references: [osUpdateConfigurations.osUpdateConfigurationId],
	}),
}));

export type OsUpdateConfiguration = typeof osUpdateConfigurations.$inferSelect;
export type OsUpdateServer = typeof osUpdateServers.$inferSelect;
export type OsUpdateRun = typeof osUpdateRuns.$inferSelect;

// ------------------------------------------------------------- API

const configurationFields = {
	name: z.string().trim().min(1).max(64),
	description: z.string().trim().max(500).nullable().default(null),
	enabled: z.boolean().default(true),
	schedule: osUpdateScheduleSchema,
	notifyOnSuccess: z.boolean().default(false),
	serverIds: z.array(z.string().min(1)).max(500).default([]),
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

export const apiOsUpdateServer = z.object({ serverId: z.string().min(1) });

export const apiAssignOsUpdateConfiguration = z.object({
	serverId: z.string().min(1),
	osUpdateConfigurationId: z.string().min(1).nullable(),
});

export const apiSetOsUpdateAssessment = z.object({
	serverId: z.string().min(1),
	periodicAssessment: z.boolean(),
});

/** A one-time installation, outside any window. */
export const apiInstallOsUpdatesNow = osUpdateSettingsSchema.extend({
	serverId: z.string().min(1),
	/** No install starts after this long. */
	maxDurationMinutes: z.number().int().min(30).max(720).default(120),
});

export const apiListOsUpdateRuns = z.object({
	serverId: z.string().min(1).optional(),
	limit: z.number().int().min(1).max(200).default(50),
});

export const apiFindOsUpdateRun = z.object({
	osUpdateRunId: z.string().min(1),
});
