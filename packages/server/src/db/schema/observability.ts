import { relations } from "drizzle-orm";
import {
	boolean,
	doublePrecision,
	index,
	jsonb,
	pgEnum,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { z } from "zod";
import { organization } from "./account";
import { notifications } from "./notification";
import { server } from "./server";
import { encryptedText } from "./utils";

export const observabilityStackStatus = pgEnum("observabilityStackStatus", [
	"not_installed",
	"installing",
	"ready",
	"degraded",
	"disabled",
	"error",
]);

export const observabilityAgentStatus = pgEnum("observabilityAgentStatus", [
	"pending",
	"healthy",
	"degraded",
	"disabled",
	"error",
]);

export const observabilityDatabaseType = pgEnum("observabilityDatabaseType", [
	"postgres",
	"redis",
]);

export const databaseAlertOperator = pgEnum("databaseAlertOperator", [
	"gt",
	"gte",
	"lt",
	"lte",
	"eq",
	"neq",
]);

export const databaseAlertSeverity = pgEnum("databaseAlertSeverity", [
	"info",
	"warning",
	"critical",
]);

export const databaseAlertSyncStatus = pgEnum("databaseAlertSyncStatus", [
	"pending",
	"synced",
	"error",
]);

export const databaseAlertEventStatus = pgEnum("databaseAlertEventStatus", [
	"pending",
	"firing",
	"resolved",
]);

export const databaseAlertDeliveryStatus = pgEnum(
	"databaseAlertDeliveryStatus",
	["pending", "sent", "failed"],
);

/**
 * One managed observability stack is provisioned for each organization.
 * Tokens are encrypted at rest and never selected by the public router.
 */
export const observabilitySettings = pgTable(
	"observabilitySettings",
	{
		observabilitySettingsId: text("observabilitySettingsId")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organizationId")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		enabled: boolean("enabled").notNull().default(false),
		status: observabilityStackStatus("status")
			.notNull()
			.default("not_installed"),
		publicUrl: text("publicUrl"),
		grafanaPath: text("grafanaPath")
			.notNull()
			.default("/api/observability/grafana"),
		gatewayToken: encryptedText("gatewayToken"),
		alertmanagerToken: encryptedText("alertmanagerToken"),
		lastReconciledAt: timestamp("lastReconciledAt", {
			withTimezone: true,
		}),
		lastError: text("lastError"),
		createdAt: timestamp("createdAt", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updatedAt", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		uniqueIndex("observabilitySettings_organizationId_unique").on(
			table.organizationId,
		),
	],
);

export const observabilityAgents = pgTable(
	"observabilityAgent",
	{
		observabilityAgentId: text("observabilityAgentId")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organizationId")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		serverId: text("serverId").references(() => server.serverId, {
			onDelete: "cascade",
		}),
		// "local" for the Dokploy host, otherwise the immutable server id.
		serverKey: text("serverKey").notNull(),
		authToken: encryptedText("authToken").notNull(),
		tokenHash: text("tokenHash").notNull(),
		status: observabilityAgentStatus("status").notNull().default("pending"),
		lastSeenAt: timestamp("lastSeenAt", { withTimezone: true }),
		lastReconciledAt: timestamp("lastReconciledAt", {
			withTimezone: true,
		}),
		walBacklogBytes: doublePrecision("walBacklogBytes"),
		lastError: text("lastError"),
		createdAt: timestamp("createdAt", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updatedAt", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		uniqueIndex("observabilityAgent_organization_server_unique").on(
			table.organizationId,
			table.serverKey,
		),
		index("observabilityAgent_serverId_idx").on(table.serverId),
	],
);

export const databaseAlertRules = pgTable(
	"databaseAlertRule",
	{
		databaseAlertRuleId: text("databaseAlertRuleId")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organizationId")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		serviceId: text("serviceId").notNull(),
		databaseType: observabilityDatabaseType("databaseType").notNull(),
		metricKey: text("metricKey").notNull(),
		operator: databaseAlertOperator("operator").notNull(),
		threshold: doublePrecision("threshold").notNull(),
		lookbackWindow: text("lookbackWindow").notNull(),
		forDuration: text("forDuration").notNull(),
		severity: databaseAlertSeverity("severity").notNull(),
		name: text("name").notNull(),
		description: text("description").notNull().default(""),
		enabled: boolean("enabled").notNull().default(true),
		syncStatus: databaseAlertSyncStatus("syncStatus")
			.notNull()
			.default("pending"),
		syncError: text("syncError"),
		createdAt: timestamp("createdAt", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updatedAt", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		index("databaseAlertRule_organizationId_idx").on(table.organizationId),
		index("databaseAlertRule_serviceId_idx").on(table.serviceId),
	],
);

export const databaseAlertDestinations = pgTable(
	"databaseAlertDestination",
	{
		databaseAlertRuleId: text("databaseAlertRuleId")
			.notNull()
			.references(() => databaseAlertRules.databaseAlertRuleId, {
				onDelete: "cascade",
			}),
		notificationId: text("notificationId")
			.notNull()
			.references(() => notifications.notificationId, {
				onDelete: "cascade",
			}),
		createdAt: timestamp("createdAt", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		primaryKey({
			columns: [table.databaseAlertRuleId, table.notificationId],
		}),
		index("databaseAlertDestination_notificationId_idx").on(
			table.notificationId,
		),
	],
);

export const databaseAlertEvents = pgTable(
	"databaseAlertEvent",
	{
		databaseAlertEventId: text("databaseAlertEventId")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organizationId")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		databaseAlertRuleId: text("databaseAlertRuleId").references(
			() => databaseAlertRules.databaseAlertRuleId,
			{ onDelete: "set null" },
		),
		serviceId: text("serviceId").notNull(),
		fingerprint: text("fingerprint").notNull(),
		status: databaseAlertEventStatus("status").notNull(),
		startsAt: timestamp("startsAt", { withTimezone: true }).notNull(),
		endsAt: timestamp("endsAt", { withTimezone: true }),
		value: doublePrecision("value"),
		payload: jsonb("payload").$type<Record<string, unknown>>(),
		createdAt: timestamp("createdAt", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		uniqueIndex("databaseAlertEvent_fingerprint_status_unique").on(
			table.organizationId,
			table.fingerprint,
			table.status,
			table.startsAt,
		),
		index("databaseAlertEvent_service_created_idx").on(
			table.serviceId,
			table.createdAt,
		),
	],
);

export const databaseAlertDeliveries = pgTable(
	"databaseAlertDelivery",
	{
		databaseAlertDeliveryId: text("databaseAlertDeliveryId")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		databaseAlertEventId: text("databaseAlertEventId")
			.notNull()
			.references(() => databaseAlertEvents.databaseAlertEventId, {
				onDelete: "cascade",
			}),
		notificationId: text("notificationId").references(
			() => notifications.notificationId,
			{ onDelete: "set null" },
		),
		status: databaseAlertDeliveryStatus("status").notNull().default("pending"),
		attemptedAt: timestamp("attemptedAt", { withTimezone: true }),
		error: text("error"),
		createdAt: timestamp("createdAt", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		index("databaseAlertDelivery_event_idx").on(table.databaseAlertEventId),
	],
);

export const observabilitySettingsRelations = relations(
	observabilitySettings,
	({ one, many }) => ({
		organization: one(organization, {
			fields: [observabilitySettings.organizationId],
			references: [organization.id],
		}),
		agents: many(observabilityAgents),
	}),
);

export const observabilityAgentsRelations = relations(
	observabilityAgents,
	({ one }) => ({
		settings: one(observabilitySettings, {
			fields: [observabilityAgents.organizationId],
			references: [observabilitySettings.organizationId],
		}),
		server: one(server, {
			fields: [observabilityAgents.serverId],
			references: [server.serverId],
		}),
	}),
);

export const databaseAlertRulesRelations = relations(
	databaseAlertRules,
	({ many }) => ({
		destinations: many(databaseAlertDestinations),
		events: many(databaseAlertEvents),
	}),
);

export const databaseAlertDestinationsRelations = relations(
	databaseAlertDestinations,
	({ one }) => ({
		rule: one(databaseAlertRules, {
			fields: [databaseAlertDestinations.databaseAlertRuleId],
			references: [databaseAlertRules.databaseAlertRuleId],
		}),
		notification: one(notifications, {
			fields: [databaseAlertDestinations.notificationId],
			references: [notifications.notificationId],
		}),
	}),
);

export const databaseAlertEventsRelations = relations(
	databaseAlertEvents,
	({ one, many }) => ({
		rule: one(databaseAlertRules, {
			fields: [databaseAlertEvents.databaseAlertRuleId],
			references: [databaseAlertRules.databaseAlertRuleId],
		}),
		deliveries: many(databaseAlertDeliveries),
	}),
);

export const databaseAlertDeliveriesRelations = relations(
	databaseAlertDeliveries,
	({ one }) => ({
		event: one(databaseAlertEvents, {
			fields: [databaseAlertDeliveries.databaseAlertEventId],
			references: [databaseAlertEvents.databaseAlertEventId],
		}),
		notification: one(notifications, {
			fields: [databaseAlertDeliveries.notificationId],
			references: [notifications.notificationId],
		}),
	}),
);

export const PrometheusDuration = z
	.string()
	.regex(/^(?:0|[1-9]\d*)(?:s|m|h|d|w)$/, "Invalid Prometheus duration");

export const DATABASE_ALERT_NAME_PATTERN = /^alert-[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const DATABASE_ALERT_NAME_MESSAGE =
	'Alert names must use lowercase kebab-case, start with "alert-", and contain only letters, numbers, and single hyphens';

export const DatabaseAlertName = z
	.string()
	.trim()
	.min(1)
	.max(120)
	.regex(DATABASE_ALERT_NAME_PATTERN, DATABASE_ALERT_NAME_MESSAGE);

/**
 * Public builder contract. The server derives databaseType and compiles PromQL;
 * callers can never submit free-form PromQL.
 */
export const DatabaseAlertRuleInput = z.object({
	serviceId: z.string().min(1),
	metricKey: z.string().min(1),
	operator: z.enum(["gt", "gte", "lt", "lte", "eq", "neq"]),
	threshold: z.number().finite(),
	lookbackWindow: PrometheusDuration,
	forDuration: PrometheusDuration,
	severity: z.enum(["info", "warning", "critical"]),
	name: DatabaseAlertName,
	description: z.string().trim().max(500).default(""),
	notificationIds: z.array(z.string().min(1)).max(50),
	enabled: z.boolean(),
});

export type DatabaseAlertRuleInputType = z.infer<typeof DatabaseAlertRuleInput>;
