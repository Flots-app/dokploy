import { execSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { removeDeploymentsByComposeId } from "@dokploy/server/services/deployment";
import { parse, quote } from "shell-quote";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	deleteDeployments: vi.fn(),
	findManyDeployments: vi.fn(),
	returnDeletedDeployments: vi.fn(),
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		delete: mocks.deleteDeployments,
		query: {
			deployments: {
				findMany: mocks.findManyDeployments,
			},
		},
	},
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
}));

describe("deployment log cleanup command injection", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.deleteDeployments.mockReturnValue({
			where: vi.fn().mockReturnValue({
				returning: mocks.returnDeletedDeployments.mockResolvedValue([]),
			}),
		});
	});

	it("treats a deployment log path as one literal shell argument", async () => {
		const substitutionMarker = `/tmp/dokploy_log_substitution_${process.pid}`;
		const backtickMarker = `/tmp/dokploy_log_backtick_${process.pid}`;
		const logPath = [
			"/tmp/dokploy deployment",
			`$(touch ${substitutionMarker})`,
			`\`touch ${backtickMarker}\``,
			"'quoted'.log",
		].join(" ");

		for (const marker of [substitutionMarker, backtickMarker]) {
			if (existsSync(marker)) rmSync(marker);
		}

		mocks.findManyDeployments.mockResolvedValue([
			{
				buildServerId: "build-server-id",
				logPath,
			},
		]);

		await removeDeploymentsByComposeId({
			buildServerId: null,
			composeId: "compose-id",
			serverId: "runtime-server-id",
		} as never);

		expect(mocks.execAsyncRemote).toHaveBeenCalledOnce();
		const [, command] = mocks.execAsyncRemote.mock.calls[0] as [string, string];
		expect(command).toBe(`rm -f ${quote([logPath])}`);
		expect(parse(command)).toHaveLength(3);
		expect(parse(command).slice(0, 2)).toEqual(["rm", "-f"]);

		execSync(command, { shell: "/bin/sh", stdio: "ignore" });
		expect(existsSync(substitutionMarker)).toBe(false);
		expect(existsSync(backtickMarker)).toBe(false);
	});
});
