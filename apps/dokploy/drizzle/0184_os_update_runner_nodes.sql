CREATE TABLE "os_update_runner_node" (
	"githubRunnerNodeId" text PRIMARY KEY NOT NULL,
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
ALTER TABLE "os_update_run" ALTER COLUMN "serverId" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "os_update_run" ADD COLUMN "githubRunnerNodeId" text;--> statement-breakpoint
ALTER TABLE "os_update_runner_node" ADD CONSTRAINT "os_update_runner_node_githubRunnerNodeId_github_runner_node_githubRunnerNodeId_fk" FOREIGN KEY ("githubRunnerNodeId") REFERENCES "public"."github_runner_node"("githubRunnerNodeId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "os_update_runner_node" ADD CONSTRAINT "os_update_runner_node_osUpdateConfigurationId_os_update_configuration_osUpdateConfigurationId_fk" FOREIGN KEY ("osUpdateConfigurationId") REFERENCES "public"."os_update_configuration"("osUpdateConfigurationId") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "os_update_run" ADD CONSTRAINT "os_update_run_githubRunnerNodeId_github_runner_node_githubRunnerNodeId_fk" FOREIGN KEY ("githubRunnerNodeId") REFERENCES "public"."github_runner_node"("githubRunnerNodeId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "os_update_run_runner_node_idx" ON "os_update_run" USING btree ("githubRunnerNodeId");--> statement-breakpoint
CREATE UNIQUE INDEX "os_update_run_runner_window_unique" ON "os_update_run" USING btree ("githubRunnerNodeId","osUpdateConfigurationId","windowStart") WHERE "os_update_run"."trigger" = 'schedule';--> statement-breakpoint
CREATE UNIQUE INDEX "os_update_run_runner_running_unique" ON "os_update_run" USING btree ("githubRunnerNodeId") WHERE "os_update_run"."status" = 'running';--> statement-breakpoint
CREATE UNIQUE INDEX "os_update_run_runner_manual_active_unique" ON "os_update_run" USING btree ("githubRunnerNodeId") WHERE "os_update_run"."trigger" = 'manual' AND "os_update_run"."status" IN ('pending', 'running');--> statement-breakpoint
ALTER TABLE "os_update_run" ADD CONSTRAINT "os_update_run_one_machine" CHECK (num_nonnulls("os_update_run"."serverId", "os_update_run"."githubRunnerNodeId") = 1);