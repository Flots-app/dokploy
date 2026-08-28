import { describe, expect, it } from "vitest";
import { isDeploymentConfirmationValid } from "../../utils/deployment-confirmation";

describe("deployment confirmation", () => {
	it("accepts the exact environment name", () => {
		expect(isDeploymentConfirmationValid("production", "production")).toBe(
			true,
		);
	});

	it("rejects casing and whitespace differences", () => {
		expect(isDeploymentConfirmationValid("Production", "production")).toBe(
			false,
		);
		expect(isDeploymentConfirmationValid("production ", "production")).toBe(
			false,
		);
	});
});
