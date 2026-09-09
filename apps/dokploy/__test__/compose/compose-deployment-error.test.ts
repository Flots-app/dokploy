import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findFirst: vi.fn(),
	set: vi.fn(() => ({ where: () => ({ returning: async () => [{}] }) })),
	exec: vi.fn(),
	updateDeployment: vi.fn(),
	notify: vi.fn(),
	appendFile: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		promises: { ...actual.promises, appendFile: mocks.appendFile },
	};
});
vi.mock("@dokploy/server/db", () => ({
	db: {
		query: { compose: { findFirst: mocks.findFirst } },
		update: () => ({ set: mocks.set }),
	},
}));
vi.mock("@dokploy/server/services/admin", () => ({
	getDokployUrl: async () => "https://dokploy.example.com",
}));
vi.mock("@dokploy/server/services/deployment", () => ({
	createDeploymentCompose: async () => ({
		deploymentId: "deployment-1",
		logPath: "/tmp/deployment.log",
	}),
	updateDeployment: mocks.updateDeployment,
	updateDeploymentStatus: vi.fn(),
}));
vi.mock("@dokploy/server/utils/process/execAsync", async () => ({
	ExecError: (await import("@dokploy/server/utils/process/ExecError"))
		.ExecError,
	execAsync: mocks.exec,
	execAsyncRemote: mocks.exec,
	execFileAsync: vi.fn(),
}));
vi.mock("@dokploy/server/utils/providers/raw", () => ({
	getCreateComposeFileCommand: () => "true;",
}));
vi.mock("@dokploy/server/utils/notifications/build-error", () => ({
	sendBuildErrorNotifications: mocks.notify,
}));
vi.mock("@dokploy/server/utils/notifications/build-success", () => ({
	sendBuildSuccessNotifications: vi.fn(),
}));

import {
	deployCompose,
	rebuildCompose,
} from "@dokploy/server/services/compose";
import { ExecError } from "@dokploy/server/utils/process/ExecError";

describe.each([deployCompose, rebuildCompose])(
	"%s failure reporting",
	(deploy) => {
		beforeEach(() => {
			vi.clearAllMocks();
			mocks.findFirst.mockResolvedValue({
				composeId: "compose-1",
				name: "Test",
				sourceType: "raw",
				serverId: null,
				buildServerId: null,
				buildRegistryId: null,
				environment: { project: { name: "Project", organizationId: "org-1" } },
			});
		});

		it.each([null, "runtime-1"])(
			"persists the cause and error status even if logs cannot be written on %s",
			async (serverId) => {
				const compose = await mocks.findFirst();
				mocks.findFirst.mockResolvedValue({ ...compose, serverId });
				const original = new ExecError("Command failed", {
					command: "docker compose config",
					stderr: "invalid compose configuration",
					exitCode: 1,
				});
				mocks.exec.mockRejectedValue(original);
				mocks.appendFile.mockRejectedValue(new Error("disk full"));
				await expect(
					deploy({
						composeId: "compose-1",
						titleLog: "Test",
						descriptionLog: "",
					}),
				).rejects.toBe(original);
				expect(mocks.updateDeployment).toHaveBeenCalledWith("deployment-1", {
					status: "error",
					finishedAt: expect.any(String),
					errorMessage: expect.stringContaining(
						"invalid compose configuration",
					),
				});
				expect(mocks.set).toHaveBeenCalledWith({ composeStatus: "error" });
			},
		);
	},
);
