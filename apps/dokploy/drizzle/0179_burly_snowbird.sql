CREATE TABLE "composePreview" (
	"previewId" text PRIMARY KEY NOT NULL,
	"sourceComposeId" text NOT NULL,
	"composeId" text,
	"environmentId" text,
	"serverId" text,
	"pullRequestNumber" integer NOT NULL,
	"branch" text DEFAULT '' NOT NULL,
	"url" text DEFAULT '' NOT NULL,
	"deployedSha" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"manualCleanup" boolean DEFAULT false NOT NULL,
	"error" text,
	"expiresAt" text,
	"requestedAt" text NOT NULL,
	"reconciledAt" text,
	"createdAt" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN "previewSettings" jsonb;--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN "previewEnv" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN "previewComposeFile" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN "previewParentId" text;--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN "previewCommitSha" text;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "previewOnly" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "previewCapacity" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "swarmNodeId" text;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "swarmManagerId" text;--> statement-breakpoint
ALTER TABLE "composePreview" ADD CONSTRAINT "composePreview_sourceComposeId_compose_composeId_fk" FOREIGN KEY ("sourceComposeId") REFERENCES "public"."compose"("composeId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "composePreview" ADD CONSTRAINT "composePreview_composeId_compose_composeId_fk" FOREIGN KEY ("composeId") REFERENCES "public"."compose"("composeId") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "composePreview" ADD CONSTRAINT "composePreview_environmentId_environment_environmentId_fk" FOREIGN KEY ("environmentId") REFERENCES "public"."environment"("environmentId") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "composePreview" ADD CONSTRAINT "composePreview_serverId_server_serverId_fk" FOREIGN KEY ("serverId") REFERENCES "public"."server"("serverId") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "compose_preview_source_pr_unique" ON "composePreview" USING btree ("sourceComposeId","pullRequestNumber");--> statement-breakpoint
ALTER TABLE "compose" ADD CONSTRAINT "compose_previewParentId_compose_composeId_fk" FOREIGN KEY ("previewParentId") REFERENCES "public"."compose"("composeId") ON DELETE restrict ON UPDATE no action;