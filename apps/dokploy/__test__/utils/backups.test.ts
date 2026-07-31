import type { Destination } from "@dokploy/server/services/destination";
import {
	buildRcloneCommand,
	getRcloneEnvironment,
	getRcloneRemotePath,
	normalizeS3Path,
	RCLONE_ENCRYPTED_BACKUP_PREFIX,
} from "@dokploy/server/utils/backups/utils";
import { describe, expect, test } from "vitest";

const destination = (overrides: Partial<Destination> = {}): Destination => ({
	destinationId: "destination-1",
	name: "S3",
	provider: "AWS",
	accessKey: "access-key",
	secretAccessKey: "secret-key",
	bucket: "backups",
	region: "us-east-1",
	endpoint: "https://s3.example.com",
	additionalFlags: ["--s3-sign-accept-encoding=false"],
	encryptionEnabled: false,
	encryptionPassword: null,
	encryptionPassword2: null,
	encryptionFilenameMode: "standard",
	encryptionDirectoryNames: true,
	organizationId: "organization-1",
	createdAt: new Date("2026-01-01T00:00:00Z"),
	...overrides,
});

describe("normalizeS3Path", () => {
	test("should handle empty and whitespace-only prefix", () => {
		expect(normalizeS3Path("")).toBe("");
		expect(normalizeS3Path("/")).toBe("");
		expect(normalizeS3Path("  ")).toBe("");
		expect(normalizeS3Path("\t")).toBe("");
		expect(normalizeS3Path("\n")).toBe("");
		expect(normalizeS3Path(" \n \t ")).toBe("");
	});

	test("should trim whitespace from prefix", () => {
		expect(normalizeS3Path(" prefix")).toBe("prefix/");
		expect(normalizeS3Path("prefix ")).toBe("prefix/");
		expect(normalizeS3Path(" prefix ")).toBe("prefix/");
		expect(normalizeS3Path("\tprefix\t")).toBe("prefix/");
		expect(normalizeS3Path(" prefix/nested ")).toBe("prefix/nested/");
	});

	test("should remove leading slashes", () => {
		expect(normalizeS3Path("/prefix")).toBe("prefix/");
		expect(normalizeS3Path("///prefix")).toBe("prefix/");
	});

	test("should remove trailing slashes", () => {
		expect(normalizeS3Path("prefix/")).toBe("prefix/");
		expect(normalizeS3Path("prefix///")).toBe("prefix/");
	});

	test("should remove both leading and trailing slashes", () => {
		expect(normalizeS3Path("/prefix/")).toBe("prefix/");
		expect(normalizeS3Path("///prefix///")).toBe("prefix/");
	});

	test("should handle nested paths", () => {
		expect(normalizeS3Path("prefix/nested")).toBe("prefix/nested/");
		expect(normalizeS3Path("/prefix/nested/")).toBe("prefix/nested/");
		expect(normalizeS3Path("///prefix/nested///")).toBe("prefix/nested/");
	});

	test("should preserve middle slashes", () => {
		expect(normalizeS3Path("prefix/nested/deep")).toBe("prefix/nested/deep/");
		expect(normalizeS3Path("/prefix/nested/deep/")).toBe("prefix/nested/deep/");
	});

	test("should handle special characters", () => {
		expect(normalizeS3Path("prefix-with-dashes")).toBe("prefix-with-dashes/");
		expect(normalizeS3Path("prefix_with_underscores")).toBe(
			"prefix_with_underscores/",
		);
		expect(normalizeS3Path("prefix.with.dots")).toBe("prefix.with.dots/");
	});

	test("should handle the cases from the bug report", () => {
		expect(normalizeS3Path("instance-backups/")).toBe("instance-backups/");
		expect(normalizeS3Path("/instance-backups/")).toBe("instance-backups/");
		expect(normalizeS3Path("instance-backups")).toBe("instance-backups/");
	});
});

describe("rclone backup destinations", () => {
	test("keeps legacy destinations on the plaintext bucket root", () => {
		const plain = destination();
		const remote = getRcloneRemotePath(plain, "/app/daily/backup.sql.gz");
		const command = buildRcloneCommand(plain, ["cat", remote]);

		expect(remote).toBe(":s3:backups/app/daily/backup.sql.gz");
		expect(command).not.toContain("RCLONE_CRYPT_");
		expect(command).toContain("--s3-sign-accept-encoding=false");
	});

	test("isolates encrypted backups behind a versioned crypt remote", () => {
		const encrypted = destination({
			encryptionEnabled: true,
			encryptionPassword: "obscured-primary",
			encryptionPassword2: "obscured-secondary",
		});
		const remote = getRcloneRemotePath(encrypted, "app/backup.sql.gz");
		const command = buildRcloneCommand(encrypted, ["cat", remote]);
		const environment = getRcloneEnvironment(encrypted);

		expect(remote).toBe(":crypt:app/backup.sql.gz");
		expect(command).not.toContain("obscured-primary");
		expect(command).not.toContain("obscured-secondary");
		expect(environment.RCLONE_CRYPT_REMOTE).toContain(
			RCLONE_ENCRYPTED_BACKUP_PREFIX,
		);
		expect(environment.RCLONE_CRYPT_PASSWORD).toBe("obscured-primary");
		expect(environment.RCLONE_CRYPT_PASSWORD2).toBe("obscured-secondary");
		expect(environment.RCLONE_CRYPT_FILENAME_ENCRYPTION).toBe("standard");
		expect(environment.RCLONE_CRYPT_DIRECTORY_NAME_ENCRYPTION).toBe("true");
	});

	test("forces directory-name encryption off when filenames are plaintext", () => {
		const encrypted = destination({
			encryptionEnabled: true,
			encryptionPassword: "obscured-primary",
			encryptionFilenameMode: "off",
			encryptionDirectoryNames: true,
		});
		const command = buildRcloneCommand(encrypted, [
			"lsf",
			getRcloneRemotePath(encrypted),
		]);
		const environment = getRcloneEnvironment(encrypted);

		expect(command).not.toContain("RCLONE_CRYPT_");
		expect(environment.RCLONE_CRYPT_FILENAME_ENCRYPTION).toBe("off");
		expect(environment.RCLONE_CRYPT_DIRECTORY_NAME_ENCRYPTION).toBe("false");
	});

	test("fails closed when an encrypted destination has no password", () => {
		const invalid = destination({
			encryptionEnabled: true,
			encryptionPassword: null,
		});

		expect(() => getRcloneRemotePath(invalid)).toThrow(
			"Encrypted destination is missing its encryption password",
		);
	});

	test("rejects path traversal and control characters", () => {
		expect(() => getRcloneRemotePath(destination(), "../secret")).toThrow(
			"Invalid backup path",
		);
		expect(() =>
			getRcloneRemotePath(destination(), "backup.sql.gz\n--config=/tmp/x"),
		).toThrow("Invalid backup path");
	});
});
