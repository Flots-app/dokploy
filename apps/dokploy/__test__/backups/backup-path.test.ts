import { describe, expect, it } from "vitest";
import { getBackupSearchPath } from "@/lib/backup-path";

describe("getBackupSearchPath", () => {
	it.each([
		["backup-app", "/daily", "backup-app/daily"],
		["/backup-app/", "/intraday/", "backup-app/intraday"],
		["backup-app", "", "backup-app"],
	])(
		"joins %s and %s without duplicate separators",
		(appName, prefix, path) => {
			expect(getBackupSearchPath(appName, prefix)).toBe(path);
		},
	);
});
