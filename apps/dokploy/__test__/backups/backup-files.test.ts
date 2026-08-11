import { describe, expect, it } from "vitest";
import {
	getBackupDirectoryEntries,
	type RcloneFile,
} from "@/server/api/utils/backup-files";

const entry = (Path: string, Size: number, IsDir = false): RcloneFile => ({
	Path,
	Name: Path.split("/").at(-1) ?? Path,
	Size,
	IsDir,
});

describe("getBackupDirectoryEntries", () => {
	it("replaces directory placeholder sizes with all descendant object bytes", () => {
		const files = [
			entry("dokploy", 0, true),
			entry("dokploy/database.sql", 250),
			entry("dokploy/filesystem", 0, true),
			entry("dokploy/filesystem/config.json", 750),
			entry("dokploy/filesystem/nested/data.bin", 1_000),
		];

		expect(getBackupDirectoryEntries(files)).toEqual([
			entry("dokploy", 2_000, true),
		]);
	});

	it("keeps immediate files and does not mix similarly prefixed directories", () => {
		const files = [
			entry("daily", 0, true),
			entry("daily-old", 0, true),
			entry("latest.sql.gz", 50),
			entry("daily/backup.sql.gz", 100),
			entry("daily-old/backup.sql.gz", 900),
		];

		expect(getBackupDirectoryEntries(files)).toEqual([
			entry("daily", 100, true),
			entry("daily-old", 900, true),
			entry("latest.sql.gz", 50),
		]);
	});

	it("reports empty directories as zero and ignores invalid object sizes", () => {
		const files = [
			entry("empty", -1, true),
			entry("invalid", 0, true),
			entry("invalid/negative.bin", -1),
			entry("invalid/fractional.bin", 1.5),
		];

		expect(getBackupDirectoryEntries(files)).toEqual([
			entry("empty", 0, true),
			entry("invalid", 0, true),
		]);
	});

	it("does not mutate the recursive rclone response", () => {
		const files = [entry("backup", 0, true), entry("backup/file.zip", 42)];

		getBackupDirectoryEntries(files);

		expect(files[0]?.Size).toBe(0);
	});
});
