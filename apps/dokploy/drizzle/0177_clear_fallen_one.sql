ALTER TABLE "server" ADD COLUMN "isDefaultBuildServer" boolean DEFAULT false NOT NULL;--> statement-breakpoint
WITH "rankedBuildServers" AS (
	SELECT
		"serverId",
		row_number() OVER (
			PARTITION BY "organizationId"
			ORDER BY "createdAt" ASC, "serverId" ASC
		) AS "position"
	FROM "server"
	WHERE "serverType" = 'build'
		AND "serverStatus" = 'active'
		AND "sshKeyId" IS NOT NULL
)
UPDATE "server"
SET "isDefaultBuildServer" = true
FROM "rankedBuildServers"
WHERE "server"."serverId" = "rankedBuildServers"."serverId"
	AND "rankedBuildServers"."position" = 1;--> statement-breakpoint
UPDATE "application" AS "applicationToRepair"
SET
	"buildServerId" = NULL,
	"buildRegistryId" = NULL
WHERE "applicationToRepair"."buildServerId" IS NOT NULL
	AND NOT EXISTS (
		SELECT 1
		FROM "server" AS "selectedBuildServer"
		INNER JOIN "environment" ON "environment"."environmentId" = "applicationToRepair"."environmentId"
		INNER JOIN "project" ON "project"."projectId" = "environment"."projectId"
		WHERE "selectedBuildServer"."serverId" = "applicationToRepair"."buildServerId"
			AND "selectedBuildServer"."serverType" = 'build'
			AND "selectedBuildServer"."serverStatus" = 'active'
			AND "selectedBuildServer"."sshKeyId" IS NOT NULL
			AND "selectedBuildServer"."organizationId" = "project"."organizationId"
	);--> statement-breakpoint
UPDATE "application" AS "applicationWithForeignRegistry"
SET "buildRegistryId" = NULL
WHERE "applicationWithForeignRegistry"."buildRegistryId" IS NOT NULL
	AND NOT EXISTS (
		SELECT 1
		FROM "registry" AS "selectedBuildRegistry"
		INNER JOIN "environment" ON "environment"."environmentId" = "applicationWithForeignRegistry"."environmentId"
		INNER JOIN "project" ON "project"."projectId" = "environment"."projectId"
		WHERE "selectedBuildRegistry"."registryId" = "applicationWithForeignRegistry"."buildRegistryId"
			AND "selectedBuildRegistry"."organizationId" = "project"."organizationId"
	);--> statement-breakpoint
UPDATE "application" AS "applicationWithoutBuildServer"
SET "buildServerId" = "defaultBuildServer"."serverId"
FROM "environment"
INNER JOIN "project" ON "project"."projectId" = "environment"."projectId"
INNER JOIN "server" AS "defaultBuildServer"
	ON "defaultBuildServer"."organizationId" = "project"."organizationId"
	AND "defaultBuildServer"."isDefaultBuildServer" = true
WHERE "applicationWithoutBuildServer"."environmentId" = "environment"."environmentId"
	AND "applicationWithoutBuildServer"."buildServerId" IS NULL
	AND "defaultBuildServer"."serverId" IS DISTINCT FROM "applicationWithoutBuildServer"."serverId";--> statement-breakpoint
CREATE UNIQUE INDEX "server_default_build_server_org_unique" ON "server" USING btree ("organizationId") WHERE "server"."isDefaultBuildServer" = true;--> statement-breakpoint
ALTER TABLE "server" ADD CONSTRAINT "server_default_build_server_requires_build_type" CHECK (NOT "server"."isDefaultBuildServer" OR "server"."serverType" = 'build');
