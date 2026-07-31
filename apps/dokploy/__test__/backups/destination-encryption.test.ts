import {
	apiCreateDestination,
	apiUpdateDestination,
} from "@dokploy/server/db/schema/destination";
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
});
