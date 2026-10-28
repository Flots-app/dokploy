CREATE TYPE "public"."firewallPolicy" AS ENUM('allow', 'deny');--> statement-breakpoint
CREATE TYPE "public"."githubRunnerAuthType" AS ENUM('token', 'app', 'provider');--> statement-breakpoint
CREATE TYPE "public"."githubRunnerJobOutcome" AS ENUM('running', 'completed', 'interrupted');--> statement-breakpoint
CREATE TYPE "public"."githubRunnerNodePhase" AS ENUM('enrolling', 'new', 'provisioning', 'ready', 'draining', 'stopped', 'error');--> statement-breakpoint
CREATE TYPE "public"."githubRunnerOperationStatus" AS ENUM('running', 'done', 'error', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."githubRunnerOperationType" AS ENUM('provision', 'apply', 'disable', 'enable', 'remove', 'upgrade', 'patch');--> statement-breakpoint
CREATE TYPE "public"."githubRunnerPlacement" AS ENUM('fastest', 'spread');--> statement-breakpoint
CREATE TYPE "public"."githubRunnerPlatform" AS ENUM('linux', 'macos');--> statement-breakpoint
CREATE TYPE "public"."githubRunnerRerouteStatus" AS ENUM('cancelling', 'requested', 'rerouted', 'failed');--> statement-breakpoint
CREATE TYPE "public"."githubRunnerRerunStatus" AS ENUM('pending', 'cancelling', 'requested', 'skipped', 'failed');--> statement-breakpoint
CREATE TYPE "public"."githubRunnerScope" AS ENUM('organization', 'repository');--> statement-breakpoint
CREATE TABLE "firewall_attachment" (
	"firewallAttachmentId" text PRIMARY KEY NOT NULL,
	"firewallId" text NOT NULL,
	"organizationId" text NOT NULL,
	"githubRunnerPoolId" text,
	"githubRunnerNodeId" text,
	"createdAt" text NOT NULL,
	CONSTRAINT "firewall_attachment_one_target" CHECK (num_nonnulls("firewall_attachment"."githubRunnerPoolId", "firewall_attachment"."githubRunnerNodeId") = 1)
);
--> statement-breakpoint
CREATE TABLE "firewall" (
	"firewallId" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"inboundPolicy" "firewallPolicy" DEFAULT 'allow' NOT NULL,
	"outboundPolicy" "firewallPolicy" DEFAULT 'allow' NOT NULL,
	"rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_runner_alert" (
	"githubRunnerAlertId" text PRIMARY KEY NOT NULL,
	"githubRunnerPoolId" text NOT NULL,
	"githubRunnerNodeId" text,
	"subject" text NOT NULL,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"title" text NOT NULL,
	"message" text NOT NULL,
	"openedAt" text NOT NULL,
	"notifiedAt" text,
	"resolvedAt" text
);
--> statement-breakpoint
CREATE TABLE "github_runner_controller" (
	"owner" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"host" text NOT NULL,
	"version" text,
	"startedAt" text NOT NULL,
	"seenAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_runner_job" (
	"githubRunnerJobId" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"githubRunnerNodeId" text NOT NULL,
	"githubRunnerPoolId" text NOT NULL,
	"runnerName" text NOT NULL,
	"slot" integer NOT NULL,
	"repository" text NOT NULL,
	"workflow" text NOT NULL,
	"job" text NOT NULL,
	"runId" text NOT NULL,
	"runAttempt" text NOT NULL,
	"outcome" "githubRunnerJobOutcome" DEFAULT 'running' NOT NULL,
	"startedAt" text NOT NULL,
	"finishedAt" text,
	"durationSeconds" integer,
	"rerunStatus" "githubRunnerRerunStatus",
	"rerunNote" text,
	"rerunAt" text
);
--> statement-breakpoint
CREATE TABLE "github_runner_leader" (
	"id" integer PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"since" timestamp with time zone NOT NULL,
	"until" timestamp with time zone NOT NULL,
	CONSTRAINT "github_runner_leader_single" CHECK ("github_runner_leader"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "github_runner_metric" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"githubRunnerNodeId" text NOT NULL,
	"at" text NOT NULL,
	"cpuPercent" double precision,
	"memoryBytes" bigint,
	"memoryLimitBytes" bigint,
	"hostMemoryFreePercent" double precision,
	"diskFreeBytes" bigint,
	"busyRunners" integer NOT NULL,
	"runners" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_runner_node" (
	"githubRunnerNodeId" text PRIMARY KEY NOT NULL,
	"githubRunnerPoolId" text NOT NULL,
	"organizationId" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"host" text NOT NULL,
	"port" integer DEFAULT 22 NOT NULL,
	"username" text NOT NULL,
	"sshKeyId" text,
	"sshPrivateKey" text,
	"sshPublicKey" text,
	"sshKeyRotatedAt" text,
	"keepAwake" boolean DEFAULT true NOT NULL,
	"setup" jsonb,
	"updatePolicy" jsonb,
	"updateState" jsonb,
	"osReport" jsonb,
	"firewall" jsonb,
	"hostKeyFingerprint" text,
	"platform" "githubRunnerPlatform" NOT NULL,
	"vmName" text DEFAULT 'dokploy-runners' NOT NULL,
	"vmDiskGb" integer DEFAULT 60 NOT NULL,
	"cpuPercent" integer DEFAULT 70 NOT NULL,
	"memoryPercent" integer DEFAULT 70 NOT NULL,
	"diskReserveGb" integer DEFAULT 15 NOT NULL,
	"diskCleanupPercent" integer DEFAULT 90 NOT NULL,
	"maxRunners" integer DEFAULT 0 NOT NULL,
	"extraLabels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"phase" "githubRunnerNodePhase" DEFAULT 'new' NOT NULL,
	"drain" jsonb,
	"applied" jsonb,
	"observed" jsonb,
	"lastSeenAt" text,
	"lastError" text,
	"lastPrunedAt" text,
	"benchmark" jsonb,
	"cleanups" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"lockedBy" text,
	"lockedUntil" text,
	"createdAt" text NOT NULL,
	CONSTRAINT "github_runner_node_budget" CHECK ("github_runner_node"."cpuPercent" BETWEEN 10 AND 100 AND "github_runner_node"."memoryPercent" BETWEEN 10 AND 100 AND "github_runner_node"."maxRunners" BETWEEN 0 AND 32 AND "github_runner_node"."diskReserveGb" >= 0 AND "github_runner_node"."diskCleanupPercent" BETWEEN 50 AND 99)
);
--> statement-breakpoint
CREATE TABLE "github_runner_operation" (
	"githubRunnerOperationId" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"githubRunnerNodeId" text NOT NULL,
	"githubRunnerPoolId" text NOT NULL,
	"nodeName" text NOT NULL,
	"type" "githubRunnerOperationType" NOT NULL,
	"status" "githubRunnerOperationStatus" DEFAULT 'running' NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"logs" text DEFAULT '' NOT NULL,
	"errorMessage" text,
	"createdBy" text,
	"createdAt" text NOT NULL,
	"finishedAt" text
);
--> statement-breakpoint
CREATE TABLE "github_runner_pool" (
	"githubRunnerPoolId" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"scope" "githubRunnerScope" NOT NULL,
	"owner" text NOT NULL,
	"repository" text,
	"runnerGroup" text DEFAULT 'Default' NOT NULL,
	"labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"apiUrl" text DEFAULT 'https://api.github.com' NOT NULL,
	"authType" "githubRunnerAuthType" NOT NULL,
	"token" text,
	"appId" integer,
	"appInstallationId" text,
	"appPrivateKey" text,
	"githubId" text,
	"runnerVersion" text,
	"runnerEnv" text DEFAULT '' NOT NULL,
	"jobStartedHook" text,
	"jobCompletedHook" text,
	"rerunInterruptedJobs" boolean DEFAULT true NOT NULL,
	"routingVariable" text,
	"fallbackLabels" jsonb DEFAULT '["ubuntu-24.04"]'::jsonb NOT NULL,
	"routing" jsonb,
	"placement" "githubRunnerPlacement" DEFAULT 'fastest' NOT NULL,
	"updatePolicy" jsonb DEFAULT '{"auto":true,"window":null}'::jsonb NOT NULL,
	"rolloutPolicy" jsonb DEFAULT '{"maxUnavailable":1,"canary":true}'::jsonb NOT NULL,
	"rollouts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"autonomyReserve" integer DEFAULT 2 NOT NULL,
	"createdAt" text NOT NULL,
	CONSTRAINT "github_runner_pool_repository_scope" CHECK (("github_runner_pool"."scope" = 'repository') = ("github_runner_pool"."repository" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "github_runner_reroute" (
	"githubRunnerRerouteId" text PRIMARY KEY NOT NULL,
	"githubRunnerPoolId" text NOT NULL,
	"repository" text NOT NULL,
	"runId" text NOT NULL,
	"runAttempt" integer NOT NULL,
	"workflow" text NOT NULL,
	"status" "githubRunnerRerouteStatus" DEFAULT 'cancelling' NOT NULL,
	"note" text,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "githubRunners" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "firewall_attachment" ADD CONSTRAINT "firewall_attachment_firewallId_firewall_firewallId_fk" FOREIGN KEY ("firewallId") REFERENCES "public"."firewall"("firewallId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firewall_attachment" ADD CONSTRAINT "firewall_attachment_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firewall_attachment" ADD CONSTRAINT "firewall_attachment_githubRunnerPoolId_github_runner_pool_githubRunnerPoolId_fk" FOREIGN KEY ("githubRunnerPoolId") REFERENCES "public"."github_runner_pool"("githubRunnerPoolId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firewall_attachment" ADD CONSTRAINT "firewall_attachment_githubRunnerNodeId_github_runner_node_githubRunnerNodeId_fk" FOREIGN KEY ("githubRunnerNodeId") REFERENCES "public"."github_runner_node"("githubRunnerNodeId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firewall" ADD CONSTRAINT "firewall_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_runner_alert" ADD CONSTRAINT "github_runner_alert_githubRunnerPoolId_github_runner_pool_githubRunnerPoolId_fk" FOREIGN KEY ("githubRunnerPoolId") REFERENCES "public"."github_runner_pool"("githubRunnerPoolId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_runner_alert" ADD CONSTRAINT "github_runner_alert_githubRunnerNodeId_github_runner_node_githubRunnerNodeId_fk" FOREIGN KEY ("githubRunnerNodeId") REFERENCES "public"."github_runner_node"("githubRunnerNodeId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_runner_job" ADD CONSTRAINT "github_runner_job_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_runner_job" ADD CONSTRAINT "github_runner_job_githubRunnerNodeId_github_runner_node_githubRunnerNodeId_fk" FOREIGN KEY ("githubRunnerNodeId") REFERENCES "public"."github_runner_node"("githubRunnerNodeId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_runner_metric" ADD CONSTRAINT "github_runner_metric_githubRunnerNodeId_github_runner_node_githubRunnerNodeId_fk" FOREIGN KEY ("githubRunnerNodeId") REFERENCES "public"."github_runner_node"("githubRunnerNodeId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_runner_node" ADD CONSTRAINT "github_runner_node_githubRunnerPoolId_github_runner_pool_githubRunnerPoolId_fk" FOREIGN KEY ("githubRunnerPoolId") REFERENCES "public"."github_runner_pool"("githubRunnerPoolId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_runner_node" ADD CONSTRAINT "github_runner_node_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_runner_node" ADD CONSTRAINT "github_runner_node_sshKeyId_ssh-key_sshKeyId_fk" FOREIGN KEY ("sshKeyId") REFERENCES "public"."ssh-key"("sshKeyId") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_runner_operation" ADD CONSTRAINT "github_runner_operation_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_runner_operation" ADD CONSTRAINT "github_runner_operation_createdBy_user_id_fk" FOREIGN KEY ("createdBy") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_runner_pool" ADD CONSTRAINT "github_runner_pool_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_runner_pool" ADD CONSTRAINT "github_runner_pool_githubId_github_githubId_fk" FOREIGN KEY ("githubId") REFERENCES "public"."github"("githubId") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_runner_reroute" ADD CONSTRAINT "github_runner_reroute_githubRunnerPoolId_github_runner_pool_githubRunnerPoolId_fk" FOREIGN KEY ("githubRunnerPoolId") REFERENCES "public"."github_runner_pool"("githubRunnerPoolId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "firewall_attachment_pool_unique" ON "firewall_attachment" USING btree ("githubRunnerPoolId");--> statement-breakpoint
CREATE UNIQUE INDEX "firewall_attachment_node_unique" ON "firewall_attachment" USING btree ("githubRunnerNodeId");--> statement-breakpoint
CREATE UNIQUE INDEX "firewall_org_name_unique" ON "firewall" USING btree ("organizationId","name");--> statement-breakpoint
CREATE UNIQUE INDEX "github_runner_alert_open_unique" ON "github_runner_alert" USING btree ("subject") WHERE "github_runner_alert"."resolvedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "github_runner_alert_pool_idx" ON "github_runner_alert" USING btree ("githubRunnerPoolId");--> statement-breakpoint
CREATE UNIQUE INDEX "github_runner_job_runner_unique" ON "github_runner_job" USING btree ("runnerName");--> statement-breakpoint
CREATE INDEX "github_runner_job_node_started_idx" ON "github_runner_job" USING btree ("githubRunnerNodeId","startedAt");--> statement-breakpoint
CREATE INDEX "github_runner_job_pool_started_idx" ON "github_runner_job" USING btree ("githubRunnerPoolId","startedAt");--> statement-breakpoint
CREATE INDEX "github_runner_metric_node_at_idx" ON "github_runner_metric" USING btree ("githubRunnerNodeId","at");--> statement-breakpoint
CREATE UNIQUE INDEX "github_runner_node_org_name_unique" ON "github_runner_node" USING btree ("organizationId","name");--> statement-breakpoint
CREATE INDEX "github_runner_operation_node_idx" ON "github_runner_operation" USING btree ("githubRunnerNodeId");--> statement-breakpoint
CREATE UNIQUE INDEX "github_runner_operation_running_unique" ON "github_runner_operation" USING btree ("githubRunnerNodeId") WHERE "github_runner_operation"."status" = 'running';--> statement-breakpoint
CREATE UNIQUE INDEX "github_runner_pool_org_name_unique" ON "github_runner_pool" USING btree ("organizationId","name");--> statement-breakpoint
CREATE UNIQUE INDEX "github_runner_reroute_run_unique" ON "github_runner_reroute" USING btree ("githubRunnerPoolId","repository","runId");