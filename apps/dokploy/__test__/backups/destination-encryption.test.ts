import {
	apiCreateDestination,
	apiUpdateDestination,
} from "@dokploy/server/db/schema/destination";
import {
	assertEncryptedDestinationStorageUnchanged,
	type Destination,
	redactDestinationEncryptionSecrets,
} from "@dokploy/server/services/destination";
import { describe, expect, it } from "vitest";

const destination = {
	name: "Encrypted backups",
	provider: "AWS",
	accessKey: "access-key",
	secretAccessKey: "secret-key",
	bucket: "backups",
	region: "us-east-1",
	endpoint: "https://s3.example.com",
	additionalFlags: [],
};

describe("destination encryption validation", () => {
	it("requires a password whenever encryption is enabled", () => {
		const result = apiCreateDestination.safeParse({
			...destination,
			encryptionEnabled: true,
			encryptionFilenameMode: "standard",
			encryptionDirectoryNames: true,
		});

		expect(result.success).toBe(false);
	});

	it("rejects reusing the primary password as password2", () => {
		const result = apiCreateDestination.safeParse({
			...destination,
			encryptionEnabled: true,
			encryptionPassword: "same-password",
			encryptionPassword2: "same-password",
			encryptionFilenameMode: "standard",
			encryptionDirectoryNames: true,
		});

		expect(result.success).toBe(false);
	});

	it("accepts a complete encrypted destination", () => {
		const result = apiCreateDestination.safeParse({
			...destination,
			encryptionEnabled: true,
			encryptionPassword: "primary-password",
			encryptionPassword2: "second-password",
			encryptionFilenameMode: "standard",
			encryptionDirectoryNames: true,
		});

		expect(result.success).toBe(true);
	});

	it("rejects line-protocol characters in either password", () => {
		for (const passwordOverrides of [
			{ encryptionPassword: "primary\npassword" },
			{
				encryptionPassword: "primary-password",
				encryptionPassword2: "second\rpassword",
			},
		]) {
			const result = apiCreateDestination.safeParse({
				...destination,
				encryptionEnabled: true,
				encryptionFilenameMode: "standard",
				encryptionDirectoryNames: true,
				...passwordOverrides,
			});

			expect(result.success).toBe(false);
		}
	});

	it("requires directory encryption off when filename encryption is off", () => {
		const invalid = apiCreateDestination.safeParse({
			...destination,
			encryptionEnabled: true,
			encryptionPassword: "primary-password",
			encryptionFilenameMode: "off",
			encryptionDirectoryNames: true,
		});
		const valid = apiCreateDestination.safeParse({
			...destination,
			encryptionEnabled: true,
			encryptionPassword: "pässword with spaces !",
			encryptionFilenameMode: "off",
			encryptionDirectoryNames: false,
		});

		expect(invalid.success).toBe(false);
		expect(valid.success).toBe(true);
	});

	it("rejects additional flags that override crypt invariants", () => {
		const result = apiCreateDestination.safeParse({
			...destination,
			additionalFlags: ["--CRYPT-NO-DATA-ENCRYPTION=true"],
			encryptionEnabled: true,
			encryptionPassword: "primary-password",
			encryptionFilenameMode: "standard",
			encryptionDirectoryNames: true,
		});

		expect(result.success).toBe(false);
	});

	it("does not expose encryption fields through destination updates", () => {
		const result = apiUpdateDestination.parse({
			...destination,
			destinationId: "destination-1",
			encryptionEnabled: false,
			encryptionPassword: "replacement-password",
		});

		expect(result).not.toHaveProperty("encryptionEnabled");
		expect(result).not.toHaveProperty("encryptionPassword");
	});

	it("redacts reversible encryption secrets from service results", () => {
		const storedDestination: Destination = {
			...destination,
			destinationId: "destination-1",
			provider: "AWS",
			encryptionEnabled: true,
			encryptionPassword: "obscured-primary",
			encryptionPassword2: "obscured-secondary",
			encryptionFilenameMode: "standard",
			encryptionDirectoryNames: true,
			organizationId: "organization-1",
			createdAt: new Date(),
		};
		const result = redactDestinationEncryptionSecrets(storedDestination);

		expect(result.encryptionPassword).toBeNull();
		expect(result.encryptionPassword2).toBeNull();
	});

	it("allows credential rotation but freezes encrypted storage identity", () => {
		const current = {
			...destination,
			provider: "AWS",
			encryptionEnabled: true,
		};
		const rotatedCredentials = {
			...destination,
			accessKey: "rotated-access-key",
			secretAccessKey: "rotated-secret-key",
		};

		expect(() =>
			assertEncryptedDestinationStorageUnchanged(current, rotatedCredentials),
		).not.toThrow();
		expect(() =>
			assertEncryptedDestinationStorageUnchanged(current, {
				...destination,
				bucket: "different-bucket",
			}),
		).toThrow("storage settings are immutable: bucket");
	});
});
