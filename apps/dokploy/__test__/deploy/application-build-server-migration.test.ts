import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
	resolve(process.cwd(), "drizzle/0177_clear_fallen_one.sql"),
	"utf8",
);

describe("Application Build Server migration", () => {
	it("creates one organization default constrained to Build Servers", () => {
		expect(migration).toContain('ADD COLUMN "isDefaultBuildServer"');
		expect(migration).toContain("row_number() OVER");
		expect(migration).toContain(
			'CREATE UNIQUE INDEX "server_default_build_server_org_unique"',
		);
		expect(migration).toContain('"server"."serverType" = \'build\'');
	});

	it("repairs foreign or Deploy Server assignments and backfills Applications", () => {
		expect(migration).toContain(
			'UPDATE "application" AS "applicationToRepair"',
		);
		expect(migration).toContain(
			'"selectedBuildServer"."serverType" = \'build\'',
		);
		expect(migration).toContain(
			'"selectedBuildServer"."serverStatus" = \'active\'',
		);
		expect(migration).toContain('"selectedBuildServer"."sshKeyId" IS NOT NULL');
		expect(migration).toContain(
			'UPDATE "application" AS "applicationWithoutBuildServer"',
		);
		expect(migration).toContain(
			'"defaultBuildServer"."isDefaultBuildServer" = true',
		);
		expect(migration).toContain(
			'"defaultBuildServer"."serverId" IS DISTINCT FROM "applicationWithoutBuildServer"."serverId"',
		);
	});
});
