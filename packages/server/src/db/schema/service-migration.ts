import { relations, sql } from "drizzle-orm";
import {
	index,
	jsonb,
	pgEnum,
	pgTable,
	text,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { z } from "zod";
import { organization } from "./account";
import { serviceType } from "./mount";
import { user } from "./user";

export const serviceMigrationStatus = pgEnum("serviceMigrationStatus", [
	"running",
	"done",
	"error",
	"rolled_back",
]);

export const migratableServiceTypes = [
	"application",
	"compose",
	"postgres",
	"mysql",
	"mariadb",
	"mongo",
	"redis",
	"libsql",
] as const;

export type MigratableServiceType = (typeof migratableServiceTypes)[number];

export type ServiceMigrationCheckStatus = "pass" | "warn" | "fail" | "skip";

export interface ServiceMigrationCheck {
	id: string;
	label: string;
	status: ServiceMigrationCheckStatus;
	message: string;
}

export type ServiceMigrationPlanCategory =
	| "runtime"
	| "data"
	| "configuration"
	| "routing"
	| "automation"
	| "history";

export type ServiceMigrationPlanAction =
	/** Data is streamed from the source server to the target server. */
	| "copy"
	/** Dokploy rebuilds the resource on the target from its database state. */
	| "recreate"
	/** The image is pulled by the target (or streamed when it is not pullable). */
	| "pull"
	/** Stored in the Dokploy database and follows the service automatically. */
	| "follow"
	/** Removed from the source once the target is healthy. */
	| "remove"
	/** Not migrated; the detail explains why. */
	| "skip";

export interface ServiceMigrationPlanItem {
	category: ServiceMigrationPlanCategory;
	action: ServiceMigrationPlanAction;
	label: string;
	detail?: string;
	sizeBytes?: number;
}

export interface ServiceMigrationOptions {
	/** Delete the source volumes and service directories once the target is healthy. */
	removeSourceData: boolean;
	/** Overwrite volumes that already exist on the target instead of failing the checks. */
	replaceTargetData: boolean;
	/**
	 * Start the target before stopping the source. Only for overlap-safe services
	 * (applications and zero-downtime Compose projects); volumes are copied live.
	 */
	zeroDowntime: boolean;
	/** With zeroDowntime: leave the source running until the migration is finalized (DNS switched). */
	keepSourceRunning: boolean;
}

/** What remains on the source server once a migration succeeded, removed by the cleanup. */
export interface ServiceMigrationSourceCleanup {
	serviceType: MigratableServiceType;
	serviceId: string;
	appName: string;
	composeType: "docker-compose" | "stack" | null;
	swarmServices: string[];
	traefik: { appName: string; middlewares: string[] }[];
	volumes: string[];
	directories: string[];
	removeSourceData: boolean;
}

export const defaultServiceMigrationOptions: ServiceMigrationOptions = {
	removeSourceData: false,
	replaceTargetData: false,
	zeroDowntime: false,
	keepSourceRunning: false,
};

export const serviceMigrations = pgTable(
	"service_migration",
	{
		serviceMigrationId: text("serviceMigrationId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		serviceType: serviceType("serviceType").notNull(),
		serviceId: text("serviceId").notNull(),
		appName: text("appName").notNull(),
		organizationId: text("organizationId")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		// Servers are not foreign keys: the history must survive a server deletion,
		// and null means the Dokploy server itself.
		sourceServerId: text("sourceServerId"),
		sourceServerName: text("sourceServerName").notNull(),
		targetServerId: text("targetServerId"),
		targetServerName: text("targetServerName").notNull(),
		status: serviceMigrationStatus("status").notNull().default("running"),
		options: jsonb("options")
			.$type<ServiceMigrationOptions>()
			.notNull()
			.default(defaultServiceMigrationOptions),
		checks: jsonb("checks")
			.$type<ServiceMigrationCheck[]>()
			.notNull()
			.default([]),
		plan: jsonb("plan")
			.$type<ServiceMigrationPlanItem[]>()
			.notNull()
			.default([]),
		logs: text("logs").notNull().default(""),
		// Set while the source runtime is kept running after a zero-downtime migration.
		pendingCleanup: jsonb(
			"pendingCleanup",
		).$type<ServiceMigrationSourceCleanup | null>(),
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
		index("service_migration_service_idx").on(table.serviceId),
		uniqueIndex("service_migration_running_unique")
			.on(table.serviceId)
			.where(sql`${table.status} = 'running'`),
	],
);

export const serviceMigrationsRelations = relations(
	serviceMigrations,
	({ one }) => ({
		organization: one(organization, {
			fields: [serviceMigrations.organizationId],
			references: [organization.id],
		}),
		user: one(user, {
			fields: [serviceMigrations.createdBy],
			references: [user.id],
		}),
	}),
);

export type ServiceMigration = typeof serviceMigrations.$inferSelect;

const serviceTarget = z.object({
	serviceType: z.enum(migratableServiceTypes),
	serviceId: z.string().min(1),
});

const migrationOptions = z
	.object({
		removeSourceData: z.boolean().default(false),
		replaceTargetData: z.boolean().default(false),
		zeroDowntime: z.boolean().default(false),
		keepSourceRunning: z.boolean().default(false),
	})
	.transform((options) => ({
		...options,
		keepSourceRunning: options.zeroDowntime && options.keepSourceRunning,
	}));

export const apiServiceMigrationTargets = serviceTarget;

export const apiAnalyzeServiceMigration = serviceTarget.extend({
	// null migrates the service to the Dokploy server itself.
	targetServerId: z.string().min(1).nullable(),
	options: migrationOptions.default(defaultServiceMigrationOptions),
});

export const apiStartServiceMigration = apiAnalyzeServiceMigration;

export const apiFindServiceMigration = z.object({
	serviceMigrationId: z.string().min(1),
});

export const apiServiceMigrationHistory = serviceTarget;
