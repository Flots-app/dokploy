import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findFirst: vi.fn(),
	set: vi.fn(() => ({ where: () => ({ returning: async () => [{}] }) })),
	exec: vi.fn(),
	updateDeployment: vi.fn(),
	notify: vi.fn(),
}));

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
		logPath: "/logs/deployment.log",
	}),
	updateDeployment: mocks.updateDeployment,
	updateDeploymentStatus: vi.fn(),
}));
vi.mock("@dokploy/server/services/registry", () => ({
	findRegistryByIdWithCredentials: async () => ({
		registryId: "registry-1",
		registryUrl: "ghcr.io",
		username: "bot",
		password: "registry-password",
		imagePrefix: "ghcr.io/acme",
	}),
}));
vi.mock("@dokploy/server/services/patch", () => ({
	generateApplyPatchesCommand: async () => "",
}));
vi.mock("@dokploy/server/utils/builders/compose", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@dokploy/server/utils/builders/compose")
	>()),
	getCreateEnvFileCommand: () => "true",
}));
vi.mock(
	"@dokploy/server/utils/builders/compose-build-server",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("@dokploy/server/utils/builders/compose-build-server")
		>()),
		assertComposeBuildServerDeploymentReady: vi.fn(),
		assertComposeBuildServerRuntimeSelection: vi.fn(),
		validateComposeBuildServerSpecification: () => ({
			builtServices: ["backend"],
			routedServices: [],
			zeroDowntime: {
				healthchecks: {},
				readinessTimeoutSeconds: 120,
				stabilizationSeconds: 30,
				drainSeconds: 5,
			},
		}),
		createRuntimeComposeManifest: () => ({ services: {} }),
		createComposeReleaseTraefikServiceConfig: () => ({
			config: {},
			domainServices: {},
		}),
	}),
);
vi.mock("@dokploy/server/utils/process/execAsync", async () => ({
	ExecError: (await import("@dokploy/server/utils/process/ExecError"))
		.ExecError,
	execAsync: mocks.exec,
	execAsyncRemote: mocks.exec,
	execFileAsync: vi.fn(),
}));
vi.mock("@dokploy/server/utils/notifications/build-error", () => ({
	sendBuildErrorNotifications: mocks.notify,
}));
vi.mock("@dokploy/server/utils/notifications/build-success", () => ({
	sendBuildSuccessNotifications: vi.fn(),
}));

import { deployCompose } from "@dokploy/server/services/compose";
import { ExecError } from "@dokploy/server/utils/process/ExecError";

const unhealthy = new ExecError("Remote command failed with exit code 1", {
	command: "docker compose up",
	stderr: "container app-zdt-backend-1 is unhealthy",
	exitCode: 1,
});

const containerInspect = JSON.stringify([
	"/app-zdt-backend-1",
	"backend",
	0,
	{
		Status: "running",
		Health: {
			Status: "unhealthy",
			FailingStreak: 3,
			Log: [{ Start: "t1", ExitCode: 1, Output: "connection refused" }],
		},
	},
]);

const commands = () =>
	mocks.exec.mock.calls.map(([, command]) => String(command));

// Build stages run inside a cancellable wrapper that embeds them in base64.
const unwrap = (command: string) => {
	const embedded = command.match(
		/echo '?([A-Za-z0-9+/=]+)'? \| base64 -d > "\$command_file"/,
	)?.[1];
	return embedded ? Buffer.from(embedded, "base64").toString("utf8") : command;
};

const isCancellationCheck = (command: string) =>
	command.startsWith("if [ -f ") &&
	command.includes("Compose deployment cancellation requested");

const decodedLog = () =>
	commands()
		.filter((command) => command.includes("/logs/deployment.log"))
		.map((command) => {
			const encoded = command.match(/^echo '?([A-Za-z0-9+/=]+)'?/)?.[1];
			return encoded ? Buffer.from(encoded, "base64").toString("utf8") : "";
		})
		.join("");

describe("Build Server Compose candidate diagnostics", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.findFirst.mockResolvedValue({
			composeId: "compose-1",
			appName: "app",
			name: "App",
			sourceType: "raw",
			composePath: "docker-compose.yml",
			composeType: "docker-compose",
			serverId: "runtime-1",
			buildServerId: "build-1",
			buildRegistryId: "registry-1",
			buildServer: { serverId: "build-1" },
			environmentId: "environment-1",
			environment: {
				projectId: "project-1",
				name: "staging",
				project: { name: "Project", organizationId: "org-1" },
			},
			domains: [],
			mounts: [],
			env: "",
		});
		mocks.exec.mockImplementation(async (_serverId, wrapped: string) => {
			const command = unwrap(wrapped);
			if (command.includes("docker info --format"))
				return { stdout: "linux/amd64\n", stderr: "" };
			if (command.includes("config --format json"))
				return { stdout: "{}", stderr: "" };
			if (command.includes("up -d --no-build")) throw unhealthy;
			if (command.includes("docker inspect --format"))
				return { stdout: `${containerInspect}\n`, stderr: "" };
			if (command.includes("docker logs"))
				return {
					stdout: "Error: DATABASE_URL is not defined\n",
					stderr: "",
				};
			return { stdout: "", stderr: "" };
		});
	});

	it("captures container logs before tearing down the failed candidate", async () => {
		await expect(
			deployCompose({
				composeId: "compose-1",
				titleLog: "Deploy",
				descriptionLog: "",
			}),
		).rejects.toBe(unhealthy);

		const executed = commands();
		const inspect = executed.findIndex((command) =>
			command.includes("docker inspect --format"),
		);
		const logs = executed.findIndex((command) =>
			command.includes("docker logs"),
		);
		const teardown = executed.findIndex((command) =>
			command.includes("down --remove-orphans"),
		);
		expect(inspect).toBeGreaterThan(-1);
		expect(logs).toBeGreaterThan(inspect);
		expect(teardown).toBeGreaterThan(logs);

		const log = decodedLog();
		expect(log).toContain("===== Diagnostics: candidate containers =====");
		expect(log).toContain("Error: DATABASE_URL is not defined");
		expect(log.indexOf("Diagnostics: candidate containers")).toBeLessThan(
			log.indexOf("❌ Deployment failed"),
		);

		const persisted = mocks.updateDeployment.mock.calls.at(-1)?.[1];
		expect(persisted.errorMessage).toContain(
			"container app-zdt-backend-1 is unhealthy",
		);
		expect(persisted.errorMessage).toContain("- backend: running, unhealthy");
		expect(persisted.errorMessage).toContain(
			"Last healthcheck: [t1] exit 1: connection refused",
		);
		expect(persisted.errorMessage).toContain(
			"Error: DATABASE_URL is not defined",
		);

		const notification = mocks.notify.mock.calls[0]?.[0];
		expect(notification.errorMessage).toContain(
			"container app-zdt-backend-1 is unhealthy",
		);
		expect(notification.errorMessage).not.toContain("DATABASE_URL");
	});

	it("still tears down the candidate when diagnostics fail", async () => {
		const defaultExec = mocks.exec.getMockImplementation();
		mocks.exec.mockImplementation(async (serverId, command: string) => {
			if (command.includes("docker inspect --format"))
				throw new Error("docker daemon unreachable");
			return defaultExec?.(serverId, command);
		});

		await expect(
			deployCompose({
				composeId: "compose-1",
				titleLog: "Deploy",
				descriptionLog: "",
			}),
		).rejects.toBe(unhealthy);
		expect(
			commands().some((command) => command.includes("down --remove-orphans")),
		).toBe(true);
		expect(decodedLog()).toContain(
			"Container diagnostics could not be collected: docker daemon unreachable",
		);
	});

	it("skips diagnostics when the deployment was cancelled", async () => {
		const defaultExec = mocks.exec.getMockImplementation();
		let candidateStarted = false;
		mocks.exec.mockImplementation(async (serverId, command: string) => {
			if (command.includes("up -d --no-build")) {
				candidateStarted = true;
				return { stdout: "", stderr: "" };
			}
			if (candidateStarted && isCancellationCheck(command))
				throw new ExecError("Remote command failed with exit code 130", {
					command,
					stderr: "Compose deployment cancellation requested",
					exitCode: 130,
				});
			return defaultExec?.(serverId, command);
		});

		await expect(
			deployCompose({
				composeId: "compose-1",
				titleLog: "Deploy",
				descriptionLog: "",
			}),
		).rejects.toThrow("Compose deployment cancellation requested");
		expect(
			commands().some((command) => command.includes("docker inspect --format")),
		).toBe(false);
		expect(
			commands().some((command) => command.includes("down --remove-orphans")),
		).toBe(true);
	});
});
