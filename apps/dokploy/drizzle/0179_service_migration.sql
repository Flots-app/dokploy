CREATE TYPE "public"."serviceMigrationStatus" AS ENUM('running', 'done', 'error', 'rolled_back');--> statement-breakpoint
CREATE TABLE "service_migration" (
	"serviceMigrationId" text PRIMARY KEY NOT NULL,
	"serviceType" "serviceType" NOT NULL,
	"serviceId" text NOT NULL,
	"appName" text NOT NULL,
	"organizationId" text NOT NULL,
	"sourceServerId" text,
	"sourceServerName" text NOT NULL,
	"targetServerId" text,
	"targetServerName" text NOT NULL,
	"status" "serviceMigrationStatus" DEFAULT 'running' NOT NULL,
	"options" jsonb DEFAULT '{"removeSourceData":false,"replaceTargetData":false,"zeroDowntime":false,"keepSourceRunning":false}'::jsonb NOT NULL,
	"checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"plan" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"logs" text DEFAULT '' NOT NULL,
	"pendingCleanup" jsonb,
	"errorMessage" text,
	"createdBy" text,
	"createdAt" text NOT NULL,
	"finishedAt" text
);
--> statement-breakpoint
ALTER TABLE "service_migration" ADD CONSTRAINT "service_migration_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_migration" ADD CONSTRAINT "service_migration_createdBy_user_id_fk" FOREIGN KEY ("createdBy") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "service_migration_service_idx" ON "service_migration" USING btree ("serviceId");--> statement-breakpoint
CREATE UNIQUE INDEX "service_migration_running_unique" ON "service_migration" USING btree ("serviceId") WHERE "service_migration"."status" = 'running';