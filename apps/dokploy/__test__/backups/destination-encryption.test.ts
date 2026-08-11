import {
	apiCreateDestination,
	apiUpdateDestination,
	destinations,
} from "@dokploy/server/db/schema/destination";
import {
	assertEncryptedDestinationStorageUnchanged,
	type Destination,
	generateManagedDestinationEncryptionKeyMaterial,
	redactDestinationEncryptionSecrets,
	resolveDestinationEncryptionKeyMaterial,
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
	it("requires a password for customer-managed encryption", () => {
		const result = apiCreateDestination.safeParse({
			...destination,
			encryptionEnabled: true,
			encryptionKeyManagement: "customer",
			encryptionFilenameMode: "standard",
			encryptionDirectoryNames: true,
		});

		expect(result.success).toBe(false);
	});

	it("rejects reusing the primary password as password2", () => {
		const result = apiCreateDestination.safeParse({
			...destination,
			encryptionEnabled: true,
			encryptionKeyManagement: "customer",
			encryptionPassword: "same-password",
			encryptionPassword2: "same-password",
			encryptionFilenameMode: "standard",
			encryptionDirectoryNames: true,
		});

		expect(result.success).toBe(false);
	});

	it("accepts a complete customer-managed encrypted destination", () => {
		const result = apiCreateDestination.safeParse({
			...destination,
			encryptionEnabled: true,
			encryptionKeyManagement: "customer",
			encryptionPassword: "primary-password",
			encryptionPassword2: "second-password",
			encryptionFilenameMode: "standard",
			encryptionDirectoryNames: true,
		});

		expect(result.success).toBe(true);
	});

	it("defaults to Dokploy-managed keys without accepting client secrets", () => {
		const managed = apiCreateDestination.safeParse({
			...destination,
			encryptionEnabled: true,
			encryptionFilenameMode: "standard",
			encryptionDirectoryNames: true,
		});
		const injectedSecret = apiCreateDestination.safeParse({
			...destination,
			encryptionEnabled: true,
			encryptionKeyManagement: "dokploy",
			encryptionPassword: "client-controlled-password",
			encryptionFilenameMode: "standard",
			encryptionDirectoryNames: true,
		});

		expect(managed.success).toBe(true);
		if (managed.success) {
			expect(managed.data.encryptionKeyManagement).toBe("dokploy");
		}
		expect(injectedSecret.success).toBe(false);
	});

	it("rejects unused secrets when encryption is disabled", () => {
		const result = apiCreateDestination.safeParse({
			...destination,
			encryptionEnabled: false,
			encryptionKeyManagement: "customer",
			encryptionPassword: "must-not-cross-the-api",
			encryptionFilenameMode: "standard",
			encryptionDirectoryNames: true,
		});

		expect(result.success).toBe(false);
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
				encryptionKeyManagement: "customer",
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
			encryptionKeyManagement: "customer",
			encryptionPassword: "primary-password",
			encryptionFilenameMode: "off",
			encryptionDirectoryNames: true,
		});
		const valid = apiCreateDestination.safeParse({
			...destination,
			encryptionEnabled: true,
			encryptionKeyManagement: "customer",
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
			encryptionKeyManagement: "customer",
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
			encryptionKeyManagement: "customer",
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

	it("generates independent server-managed key material", () => {
		const first = generateManagedDestinationEncryptionKeyMaterial();
		const second = generateManagedDestinationEncryptionKeyMaterial();

		for (const value of [
			first.password,
			first.password2,
			second.password,
			second.password2,
		]) {
			expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
		}
		expect(new Set(Object.values(first)).size).toBe(2);
		expect(first).not.toEqual(second);
	});

	it("encrypts persisted rclone secrets with the Dokploy database key", () => {
		const rcloneSecret = "rclone-obscured-secret";
		const driverValue =
			destinations.encryptionPassword.mapToDriverValue(rcloneSecret);

		expect(driverValue).not.toBe(rcloneSecret);
		expect(driverValue).toMatch(/^enc:v1:/);
		expect(
			destinations.encryptionPassword.mapFromDriverValue(driverValue),
		).toBe(rcloneSecret);
	});

	it("resolves managed and customer key ownership without mixing inputs", () => {
		const managed = resolveDestinationEncryptionKeyMaterial({
			encryptionEnabled: true,
			encryptionKeyManagement: "dokploy",
		});
		const customer = resolveDestinationEncryptionKeyMaterial({
			encryptionEnabled: true,
			encryptionKeyManagement: "customer",
			encryptionPassword: "owned-by-customer",
			encryptionPassword2: "customer-salt",
		});
		const disabled = resolveDestinationEncryptionKeyMaterial({
			encryptionEnabled: false,
			encryptionKeyManagement: "dokploy",
		});

		expect(managed?.password).toBeTruthy();
		expect(managed?.password2).toBeTruthy();
		expect(customer).toEqual({
			password: "owned-by-customer",
			password2: "customer-salt",
		});
		expect(disabled).toBeUndefined();
		expect(() =>
			resolveDestinationEncryptionKeyMaterial({
				encryptionEnabled: true,
				encryptionKeyManagement: "customer",
			}),
		).toThrow("required for customer-managed keys");
		expect(() =>
			resolveDestinationEncryptionKeyMaterial({
				encryptionEnabled: true,
				encryptionKeyManagement: "dokploy",
				encryptionPassword: "injected",
			}),
		).toThrow("must not be supplied for Dokploy-managed keys");
		expect(() =>
			resolveDestinationEncryptionKeyMaterial({
				encryptionEnabled: false,
				encryptionKeyManagement: "customer",
				encryptionPassword: "unused",
			}),
		).toThrow("require encryption to be enabled");
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
