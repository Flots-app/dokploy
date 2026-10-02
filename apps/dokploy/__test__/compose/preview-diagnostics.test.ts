import { spawnSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	exec: vi.fn(),
	updateDeployment: vi.fn(),
	updateCompose: vi.fn(),
}));

vi.mock("@dokploy/server/services/compose", () => ({
	findComposeById: async () => ({
		composeId: "compose-pr-7",
		appName: "pr-7",
		composePath: "docker-compose.yml",
		previewParentId: "compose-1",
		serverId: "worker-1",
		previewCommitSha: "abc123",
		previewSettings: { registryId: "registry-1" },
		environment: { project: { organizationId: "org-1" } },
		domains: [],
	}),
	updateCompose: m.updateCompose,
}));
vi.mock("@dokploy/server/services/server", () => ({
	findServerById: async (serverId: string) => ({
		serverId,
		organizationId: "org-1",
		sshKeyId: "key-1",
		serverType: "deploy",
		swarmNodeId: serverId === "worker-1" ? "node-1" : null,
		swarmManagerId: serverId === "worker-1" ? "manager-1" : null,
		ipAddress: "10.0.0.2",
	}),
}));
vi.mock("@dokploy/server/utils/servers/remote-docker", () => ({
	getRemoteDocker: async () => ({
		info: async () => ({
			Swarm: { NodeID: "node-1", ControlAvailable: false },
		}),
		getNode: () => ({
			inspect: async () => ({
				Spec: { Role: "worker", Availability: "active" },
				Status: { State: "ready" },
			}),
		}),
	}),
}));
vi.mock("@dokploy/server/services/preview-firewall", () => ({
	readPreviewFirewall: async () => ({ healthy: true }),
}));
vi.mock("@dokploy/server/services/registry", () => ({
	findRegistryByIdWithCredentials: async () => ({
		registryId: "registry-1",
		organizationId: "org-1",
		registryUrl: "ghcr.io",
		username: "bot",
		password: "registry-password",
		imagePrefix: "ghcr.io/acme",
	}),
}));
vi.mock("@dokploy/server/services/deployment", () => ({
	createDeploymentCompose: async () => ({
		deploymentId: "generation-1",
		logPath: "/logs/pr-7.log",
	}),
	updateDeployment: m.updateDeployment,
}));
vi.mock("@dokploy/server/utils/providers/github", () => ({
	cloneGithubRepository: async () => "true",
}));
vi.mock("@dokploy/server/utils/docker/domain", () => ({
	loadDockerComposeRemote: async () => ({
		services: { backend: { image: "ghcr.io/acme/backend:1" } },
	}),
}));
vi.mock("@dokploy/server/utils/docker/compose-preview", () => ({
	isolatePreviewCompose: (spec: unknown) => spec,
}));
vi.mock("@dokploy/server/utils/builders/compose", () => ({
	getCreateEnvFileCommand: () => "true",
}));
vi.mock("@dokploy/server/utils/process/execAsync", async () => ({
	ExecError: (await import("@dokploy/server/utils/process/ExecError"))
		.ExecError,
	execAsync: (command: string) => m.exec(null, command),
	execAsyncRemote: m.exec,
}));

import { deployComposePreviewStack } from "@dokploy/server/services/compose-preview-stack";
import {
	formatPreviewStackTasks,
	getPreviewStackTasksCommand,
} from "@dokploy/server/utils/docker/compose-preview-stack";

const task = (fields: Record<string, string>) => JSON.stringify(fields);

describe("formatPreviewStackTasks", () => {
	it("lists every task and summarizes task errors", () => {
		const { section, summary } = formatPreviewStackTasks(
			[
				task({
					Name: "pr-7_backend.1",
					Node: "worker-1",
					CurrentState: "Starting 5 seconds ago",
					DesiredState: "Running",
					Error: "",
				}),
				task({
					Name: " \\_ pr-7_backend.1",
					Node: "worker-1",
					CurrentState: "Failed 20 seconds ago",
					DesiredState: "Shutdown",
					Error: "task: non-zero exit (1)",
				}),
				task({
					Name: "pr-7_frontend.1",
					Node: "worker-1",
					CurrentState: "Running 2 minutes ago",
					DesiredState: "Running",
					Error: "",
				}),
				task({
					Name: "pr-7_worker.1",
					Node: "",
					CurrentState: "Rejected 1 minute ago",
					DesiredState: "Shutdown",
					Error: "No such image: ghcr.io/acme/worker@sha256:dead",
				}),
			].join("\n"),
			"pr-7",
		);
		expect(section).toContain("===== Diagnostics: Swarm tasks =====");
		expect(section).toMatch(/! backend\.1\s+Starting 5 seconds ago/);
		expect(section).toMatch(/✗ backend\.1\s+Failed 20 seconds ago/);
		expect(section).toContain("    task: non-zero exit (1)");
		expect(section).toMatch(/✓ frontend\.1\s+Running 2 minutes ago/);
		expect(summary).toBe(
			[
				"Swarm tasks with errors:",
				"- backend.1: Failed 20 seconds ago — task: non-zero exit (1)",
				"- worker.1: Rejected 1 minute ago — No such image: ghcr.io/acme/worker@sha256:dead",
			].join("\n"),
		);
	});

	it("reports a preview without tasks", () => {
		expect(formatPreviewStackTasks("", "pr-7")).toEqual({
			section:
				"\n===== Diagnostics: Swarm tasks =====\nNo Swarm tasks were found for this preview.\n",
			summary: "",
		});
	});

	it("generates syntactically valid Bash", () => {
		const result = spawnSync(
			"bash",
			["-n", "-c", getPreviewStackTasksCommand("pr-7")],
			{ encoding: "utf8" },
		);
		expect(result.status, result.stderr).toBe(0);
	});
});

describe("preview stack failure diagnostics", () => {
	const commands = () =>
		m.exec.mock.calls.map(([, command]) => String(command));
	const appendedLog = () =>
		commands()
			.filter((command) => command.includes("/logs/pr-7.log"))
			.map((command) => {
				const encoded = command.match(/^printf %s '?([A-Za-z0-9+/=]+)'?/)?.[1];
				return encoded ? Buffer.from(encoded, "base64").toString("utf8") : "";
			})
			.join("");

	beforeEach(() => {
		vi.clearAllMocks();
		m.exec.mockImplementation(async (_serverId: string, command: string) => {
			if (command.includes("config --format json"))
				return {
					stdout: JSON.stringify({
						services: { backend: { image: "ghcr.io/acme/backend:1" } },
					}),
					stderr: "",
				};
			if (command.includes("docker stack deploy"))
				throw new Error("services update paused");
			if (command.includes("docker stack ps"))
				return {
					stdout: `${task({
						Name: "pr-7_backend.1",
						CurrentState: "Failed 3 seconds ago",
						DesiredState: "Shutdown",
						Error: "task: non-zero exit (1)",
					})}\n`,
					stderr: "",
				};
			if (command.includes("docker inspect --format"))
				return {
					stdout: `${JSON.stringify([
						"/pr-7_backend.1.abc",
						"pr-7_backend",
						0,
						{ Status: "exited", ExitCode: 1 },
					])}\n`,
					stderr: "",
				};
			if (command.includes("docker logs"))
				return {
					stdout: "Error: Cannot find module 'dist/server.js'\n",
					stderr: "",
				};
			return { stdout: "", stderr: "" };
		});
	});

	it("records task errors and container logs of the failed generation", async () => {
		await expect(
			deployComposePreviewStack("compose-pr-7", "preview-1"),
		).rejects.toThrow(
			"Preview stack deployment failed during Swarm stack deployment; see deployment logs",
		);

		const tasksCall = m.exec.mock.calls.find(([, command]) =>
			String(command).includes("docker stack ps"),
		);
		expect(tasksCall?.[0]).toBe("manager-1");
		const inspectCall = m.exec.mock.calls.find(([, command]) =>
			String(command).includes("docker inspect --format"),
		);
		expect(inspectCall?.[0]).toBe("worker-1");
		expect(inspectCall?.[1]).toContain(
			"label\\=com.dokploy.preview-generation\\=generation-1",
		);

		const log = appendedLog();
		expect(log).toContain("===== Diagnostics: Swarm tasks =====");
		expect(log).toContain("===== Diagnostics: preview containers =====");
		expect(log).toContain("Error: Cannot find module 'dist/server.js'");

		const persisted = m.updateDeployment.mock.calls.at(-1)?.[1];
		expect(persisted.errorMessage).toContain(
			"Preview stack deployment failed during Swarm stack deployment; see deployment logs",
		);
		expect(persisted.errorMessage).toContain(
			"- backend.1: Failed 3 seconds ago — task: non-zero exit (1)",
		);
		expect(persisted.errorMessage).toContain("- backend: exited (code 1)");
		expect(persisted.errorMessage).toContain(
			"Error: Cannot find module 'dist/server.js'",
		);
	});

	it("skips runtime diagnostics when the stack was never deployed", async () => {
		const defaultExec = m.exec.getMockImplementation();
		m.exec.mockImplementation(async (serverId: string, command: string) => {
			if (command.includes("config --format json"))
				throw new Error("invalid compose file");
			return defaultExec?.(serverId, command);
		});
		await expect(
			deployComposePreviewStack("compose-pr-7", "preview-1"),
		).rejects.toThrow("Compose validation");
		expect(
			commands().some((command) => command.includes("docker stack ps")),
		).toBe(false);
		expect(m.updateDeployment.mock.calls.at(-1)?.[1].errorMessage).toBe(
			"Preview stack deployment failed during Compose validation; see deployment logs",
		);
	});
});
