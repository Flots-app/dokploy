import { prepareRemoteCommand } from "@dokploy/server/utils/process/execAsync";
import { describe, expect, it } from "vitest";

describe("remote command environment", () => {
	it("transfers sensitive values over stdin without putting them in the command", () => {
		const prepared = prepareRemoteCommand(
			"rclone lsf :crypt:",
			{
				RCLONE_CRYPT_PASSWORD: "obscured-primary",
				RCLONE_CRYPT_PASSWORD2: "obscured-secondary",
			},
			"remaining-input",
		);

		expect(prepared.command).toContain("read -r RCLONE_CRYPT_PASSWORD");
		expect(prepared.command).toContain("rclone lsf :crypt:");
		expect(prepared.command).not.toContain("obscured-primary");
		expect(prepared.command).not.toContain("obscured-secondary");
		expect(prepared.input).toBe(
			"obscured-primary\nobscured-secondary\nremaining-input",
		);
	});

	it("rejects unsafe variable names and multiline values", () => {
		expect(() => prepareRemoteCommand("true", { "BAD-NAME": "value" })).toThrow(
			"Invalid remote environment variable name",
		);
		expect(() =>
			prepareRemoteCommand("true", { SAFE_NAME: "first\nsecond" }),
		).toThrow("contains a newline");
	});
});
