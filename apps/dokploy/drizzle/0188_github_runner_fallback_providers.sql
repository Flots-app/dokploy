ALTER TABLE "github_runner_pool" ADD COLUMN "fallbackChain" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "github_runner_pool" ADD COLUMN "fallbackUsage" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "github_runner_pool" ADD COLUMN "blacksmithOrganization" text;--> statement-breakpoint
ALTER TABLE "github_runner_pool" ADD COLUMN "blacksmithToken" text;--> statement-breakpoint
ALTER TABLE "github_runner_pool" ADD COLUMN "billingToken" text;