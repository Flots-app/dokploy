CREATE TYPE "public"."databaseAlertDeliveryStatus" AS ENUM('pending', 'sent', 'failed');--> statement-breakpoint
CREATE TYPE "public"."databaseAlertEventStatus" AS ENUM('pending', 'firing', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."databaseAlertOperator" AS ENUM('gt', 'gte', 'lt', 'lte', 'eq', 'neq');--> statement-breakpoint
CREATE TYPE "public"."databaseAlertSeverity" AS ENUM('info', 'warning', 'critical');--> statement-breakpoint
CREATE TYPE "public"."databaseAlertSyncStatus" AS ENUM('pending', 'synced', 'error');--> statement-breakpoint
CREATE TYPE "public"."observabilityAgentStatus" AS ENUM('pending', 'healthy', 'degraded', 'disabled', 'error');--> statement-breakpoint
CREATE TYPE "public"."observabilityDatabaseType" AS ENUM('postgres', 'redis');--> statement-breakpoint
CREATE TYPE "public"."observabilityStackStatus" AS ENUM('not_installed', 'installing', 'ready', 'degraded', 'disabled', 'error');--> statement-breakpoint
CREATE TABLE "databaseAlertDelivery" (
	"databaseAlertDeliveryId" text PRIMARY KEY NOT NULL,
	"databaseAlertEventId" text NOT NULL,
	"notificationId" text,
	"status" "databaseAlertDeliveryStatus" DEFAULT 'pending' NOT NULL,
	"attemptedAt" timestamp with time zone,
	"error" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "databaseAlertDestination" (
	"databaseAlertRuleId" text NOT NULL,
	"notificationId" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "databaseAlertDestination_databaseAlertRuleId_notificationId_pk" PRIMARY KEY("databaseAlertRuleId","notificationId")
);
--> statement-breakpoint
CREATE TABLE "databaseAlertEvent" (
	"databaseAlertEventId" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"databaseAlertRuleId" text,
	"serviceId" text NOT NULL,
	"fingerprint" text NOT NULL,
	"status" "databaseAlertEventStatus" NOT NULL,
	"startsAt" timestamp with time zone NOT NULL,
	"endsAt" timestamp with time zone,
	"value" double precision,
	"payload" jsonb,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "databaseAlertRule" (
	"databaseAlertRuleId" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"serviceId" text NOT NULL,
	"databaseType" "observabilityDatabaseType" NOT NULL,
	"metricKey" text NOT NULL,
	"operator" "databaseAlertOperator" NOT NULL,
	"threshold" double precision NOT NULL,
	"lookbackWindow" text NOT NULL,
	"forDuration" text NOT NULL,
	"severity" "databaseAlertSeverity" NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"syncStatus" "databaseAlertSyncStatus" DEFAULT 'pending' NOT NULL,
	"syncError" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "observabilityAgent" (
	"observabilityAgentId" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"serverId" text,
	"serverKey" text NOT NULL,
	"authToken" text NOT NULL,
	"tokenHash" text NOT NULL,
	"status" "observabilityAgentStatus" DEFAULT 'pending' NOT NULL,
	"lastSeenAt" timestamp with time zone,
	"lastReconciledAt" timestamp with time zone,
	"walBacklogBytes" double precision,
	"lastError" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "observabilitySettings" (
	"observabilitySettingsId" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"status" "observabilityStackStatus" DEFAULT 'not_installed' NOT NULL,
	"publicUrl" text,
	"grafanaPath" text DEFAULT '/api/observability/grafana' NOT NULL,
	"gatewayToken" text,
	"alertmanagerToken" text,
	"lastReconciledAt" timestamp with time zone,
	"lastError" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "postgres" ADD COLUMN "monitoringEnabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "redis" ADD COLUMN "monitoringEnabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "databaseAlertDelivery" ADD CONSTRAINT "databaseAlertDelivery_databaseAlertEventId_databaseAlertEvent_databaseAlertEventId_fk" FOREIGN KEY ("databaseAlertEventId") REFERENCES "public"."databaseAlertEvent"("databaseAlertEventId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "databaseAlertDelivery" ADD CONSTRAINT "databaseAlertDelivery_notificationId_notification_notificationId_fk" FOREIGN KEY ("notificationId") REFERENCES "public"."notification"("notificationId") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "databaseAlertDestination" ADD CONSTRAINT "databaseAlertDestination_databaseAlertRuleId_databaseAlertRule_databaseAlertRuleId_fk" FOREIGN KEY ("databaseAlertRuleId") REFERENCES "public"."databaseAlertRule"("databaseAlertRuleId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "databaseAlertDestination" ADD CONSTRAINT "databaseAlertDestination_notificationId_notification_notificationId_fk" FOREIGN KEY ("notificationId") REFERENCES "public"."notification"("notificationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "databaseAlertEvent" ADD CONSTRAINT "databaseAlertEvent_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "databaseAlertEvent" ADD CONSTRAINT "databaseAlertEvent_databaseAlertRuleId_databaseAlertRule_databaseAlertRuleId_fk" FOREIGN KEY ("databaseAlertRuleId") REFERENCES "public"."databaseAlertRule"("databaseAlertRuleId") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "databaseAlertRule" ADD CONSTRAINT "databaseAlertRule_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observabilityAgent" ADD CONSTRAINT "observabilityAgent_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observabilityAgent" ADD CONSTRAINT "observabilityAgent_serverId_server_serverId_fk" FOREIGN KEY ("serverId") REFERENCES "public"."server"("serverId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observabilitySettings" ADD CONSTRAINT "observabilitySettings_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "databaseAlertDelivery_event_idx" ON "databaseAlertDelivery" USING btree ("databaseAlertEventId");--> statement-breakpoint
CREATE INDEX "databaseAlertDestination_notificationId_idx" ON "databaseAlertDestination" USING btree ("notificationId");--> statement-breakpoint
CREATE UNIQUE INDEX "databaseAlertEvent_fingerprint_status_unique" ON "databaseAlertEvent" USING btree ("organizationId","fingerprint","status","startsAt");--> statement-breakpoint
CREATE INDEX "databaseAlertEvent_service_created_idx" ON "databaseAlertEvent" USING btree ("serviceId","createdAt");--> statement-breakpoint
CREATE INDEX "databaseAlertRule_organizationId_idx" ON "databaseAlertRule" USING btree ("organizationId");--> statement-breakpoint
CREATE INDEX "databaseAlertRule_serviceId_idx" ON "databaseAlertRule" USING btree ("serviceId");--> statement-breakpoint
CREATE UNIQUE INDEX "observabilityAgent_organization_server_unique" ON "observabilityAgent" USING btree ("organizationId","serverKey");--> statement-breakpoint
CREATE INDEX "observabilityAgent_serverId_idx" ON "observabilityAgent" USING btree ("serverId");--> statement-breakpoint
CREATE UNIQUE INDEX "observabilitySettings_organizationId_unique" ON "observabilitySettings" USING btree ("organizationId");
