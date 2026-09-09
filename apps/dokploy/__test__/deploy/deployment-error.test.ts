import { formatDeploymentError } from "@dokploy/server/utils/process/deployment-error";
import { ExecError } from "@dokploy/server/utils/process/ExecError";
import { describe, expect, it } from "vitest";

describe("deployment error diagnostics", () => {
	it("preserves captured stderr and stdout with the exit code", () => {
		const message = formatDeploymentError(
			new ExecError("Remote command failed", {
				command: "docker compose config",
				stderr: "service web depends on undefined service db\n",
				stdout: "Validating compose\n",
				exitCode: 1,
			}),
		);
		expect(message).toContain("exit code 1");
		expect(message).toContain("service web depends on undefined service db");
		expect(message).toContain("Validating compose");
	});

	it("surfaces the unhealthy container reported by Compose --wait", () => {
		const message = formatDeploymentError(
			new ExecError("Remote command failed with exit code 1", {
				command: "docker compose up --wait",
				stderr:
					"Container frontend Healthy\ncontainer backend-staging-1 is unhealthy\n",
				exitCode: 1,
			}),
		);
		expect(message).toContain("container backend-staging-1 is unhealthy");
	});

	it("preserves SSH connection failures without a process exit code", () => {
		expect(
			formatDeploymentError(
				new ExecError("SSH connection error: connect ECONNREFUSED", {
					command: "docker info",
				}),
			),
		).toContain("connect ECONNREFUSED");
	});

	it("does not dump shell scripts or encoded environment files from local exec messages", () => {
		const command = "echo c2VjcmV0 | base64 -d > .env; docker compose up";
		const message = formatDeploymentError(
			new ExecError(`Command execution failed: Command failed: ${command}\n`, {
				command,
				exitCode: 1,
			}),
		);
		expect(message).not.toContain(command);
		expect(message).not.toContain("c2VjcmV0");
		expect(message).toContain("exit code 1");
		expect(message).toContain("preceding deployment log lines");
	});

	it("retains ordinary exceptions and thrown strings", () => {
		expect(formatDeploymentError(new Error("Invalid Compose YAML"))).toBe(
			"Invalid Compose YAML",
		);
		expect(formatDeploymentError("Missing registry")).toBe("Missing registry");
	});
});
