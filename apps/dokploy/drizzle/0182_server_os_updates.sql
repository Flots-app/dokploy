CREATE TYPE "public"."osUpdateClassification" AS ENUM('security', 'all');--> statement-breakpoint
CREATE TYPE "public"."osUpdateReboot" AS ENUM('if-required', 'never', 'always');--> statement-breakpoint
CREATE TYPE "public"."osUpdateRunStatus" AS ENUM('pending', 'running', 'succeeded', 'failed', 'skipped', 'missed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."osUpdateTrigger" AS ENUM('schedule', 'manual');--> statement-breakpoint
CREATE TABLE "os_update_configuration" (
	"osUpdateConfigurationId" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"schedule" jsonb NOT NULL,
	"classification" "osUpdateClassification" DEFAULT 'security' NOT NULL,
	"includePackages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"excludePackages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reboot" "osUpdateReboot" DEFAULT 'if-required' NOT NULL,
	"allowDockerUpdates" boolean DEFAULT false NOT NULL,
	"notifyOnSuccess" boolean DEFAULT false NOT NULL,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "os_update_lock" (
	"key" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"until" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "os_update_run" (
	"osUpdateRunId" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"serverId" text NOT NULL,
	"osUpdateConfigurationId" text,
	"trigger" "osUpdateTrigger" NOT NULL,
	"status" "osUpdateRunStatus" DEFAULT 'pending' NOT NULL,
	"windowStart" text,
	"deadline" text NOT NULL,
	"settings" jsonb NOT NULL,
	"requestedBy" text,
	"createdAt" text NOT NULL,
	"startedAt" text,
	"finishedAt" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lockedBy" text,
	"lockedUntil" timestamp with time zone,
	"progress" jsonb,
	"packages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rebootRequired" boolean,
	"rebooted" boolean DEFAULT false NOT NULL,
	"message" text,
	"log" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "os_update_server" (
	"serverId" text PRIMARY KEY NOT NULL,
	"osUpdateConfigurationId" text,
	"assignedAt" text,
	"periodicAssessment" boolean DEFAULT true NOT NULL,
	"assessment" jsonb,
	"assessedAt" text,
	"assessmentError" text,
	"assessmentRequestedAt" text,
	"assessmentTriedAt" text
);
--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "osUpdates" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "os_update_configuration" ADD CONSTRAINT "os_update_configuration_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "os_update_run" ADD CONSTRAINT "os_update_run_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "os_update_run" ADD CONSTRAINT "os_update_run_serverId_server_serverId_fk" FOREIGN KEY ("serverId") REFERENCES "public"."server"("serverId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "os_update_run" ADD CONSTRAINT "os_update_run_osUpdateConfigurationId_os_update_configuration_osUpdateConfigurationId_fk" FOREIGN KEY ("osUpdateConfigurationId") REFERENCES "public"."os_update_configuration"("osUpdateConfigurationId") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "os_update_server" ADD CONSTRAINT "os_update_server_serverId_server_serverId_fk" FOREIGN KEY ("serverId") REFERENCES "public"."server"("serverId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "os_update_server" ADD CONSTRAINT "os_update_server_osUpdateConfigurationId_os_update_configuration_osUpdateConfigurationId_fk" FOREIGN KEY ("osUpdateConfigurationId") REFERENCES "public"."os_update_configuration"("osUpdateConfigurationId") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "os_update_configuration_org_name_unique" ON "os_update_configuration" USING btree ("organizationId","name");--> statement-breakpoint
CREATE INDEX "os_update_run_org_created_idx" ON "os_update_run" USING btree ("organizationId","createdAt");--> statement-breakpoint
CREATE INDEX "os_update_run_server_idx" ON "os_update_run" USING btree ("serverId");--> statement-breakpoint
CREATE UNIQUE INDEX "os_update_run_window_unique" ON "os_update_run" USING btree ("serverId","osUpdateConfigurationId","windowStart") WHERE "os_update_run"."trigger" = 'schedule';--> statement-breakpoint
CREATE UNIQUE INDEX "os_update_run_server_running_unique" ON "os_update_run" USING btree ("serverId") WHERE "os_update_run"."status" = 'running';--> statement-breakpoint
CREATE UNIQUE INDEX "os_update_run_configuration_running_unique" ON "os_update_run" USING btree ("osUpdateConfigurationId") WHERE "os_update_run"."status" = 'running' AND "os_update_run"."trigger" = 'schedule';