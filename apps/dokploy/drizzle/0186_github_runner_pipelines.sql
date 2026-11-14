CREATE TABLE "github_runner_pipeline" (
	"githubRunnerPipelineId" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"githubRunnerPoolId" text NOT NULL,
	"repository" text NOT NULL,
	"runId" text NOT NULL,
	"runAttempt" text NOT NULL,
	"workflow" text NOT NULL,
	"event" text,
	"conclusion" text,
	"startedAt" text NOT NULL,
	"completedAt" text NOT NULL,
	"durationSeconds" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "github_runner_pipeline" ADD CONSTRAINT "github_runner_pipeline_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "github_runner_pipeline_run_unique" ON "github_runner_pipeline" USING btree ("githubRunnerPoolId","repository","runId","runAttempt");--> statement-breakpoint
CREATE INDEX "github_runner_pipeline_pool_completed_idx" ON "github_runner_pipeline" USING btree ("githubRunnerPoolId","completedAt");