import { spawnSync } from "node:child_process";
import {
	collectComposeReleaseDiagnostics,
	collectContainerDiagnostics,
	getComposeProjectContainersInspectCommand,
	getContainerLogsCommand,
	parseContainersInspect,
} from "@dokploy/server/utils/docker/deployment-diagnostics";
import {
	attachDeploymentDiagnostics,
	formatDeploymentError,
	formatDeploymentErrorWithDiagnostics,
} from "@dokploy/server/utils/process/deployment-error";
import { ExecError } from "@dokploy/server/utils/process/ExecError";
import { describe, expect, it, vi } from "vitest";

const inspectLine = (
	name: string,
	service: string,
	state: Record<string, unknown>,
	restartCount = 0,
) => JSON.stringify([`/${name}`, service, restartCount, state]);

const unhealthyBackend = inspectLine("release-backend-1", "backend", {
	Status: "running",
	Running: true,
	ExitCode: 0,
	StartedAt: "2026-10-02T14:40:00Z",
	FinishedAt: "0001-01-01T00:00:00Z",
	Health: {
		Status: "unhealthy",
		FailingStreak: 5,
		Log: [
			{ Start: "t1", ExitCode: 1, Output: "probe 1" },
			{ Start: "t2", ExitCode: 1, Output: "probe 2" },
			{ Start: "t3", ExitCode: 1, Output: "probe 3" },
			{
				Start: "t4",
				ExitCode: 1,
				Output: "curl: (7) Failed to connect to localhost port 3333\n",
			},
		],
	},
});
const healthyFrontend = inspectLine("release-frontend-1", "frontend", {
	Status: "running",
	Running: true,
	Health: { Status: "healthy", FailingStreak: 0, Log: [] },
});
const crashedWorker = inspectLine(
	"release-worker-1",
	"worker",
	{
		Status: "exited",
		ExitCode: 137,
		OOMKilled: true,
		FinishedAt: "2026-10-02T14:41:00Z",
	},
	3,
);

describe("deployment diagnostics commands", () => {
	it("generates syntactically valid Bash", () => {
		for (const command of [
			getComposeProjectContainersInspectCommand("app-zdt-abc123"),
			getContainerLogsCommand("app-zdt-abc123-backend-1"),
		]) {
			const result = spawnSync("bash", ["-n", "-c", command], {
				encoding: "utf8",
			});
			expect(result.status, result.stderr).toBe(0);
		}
	});

	it("inspects only the release containers and never their environment", () => {
		const command = getComposeProjectContainersInspectCommand("app-zdt-abc123");
		expect(command).toContain(
			"label\\=com.docker.compose.project\\=app-zdt-abc123",
		);
		expect(command).toContain("docker ps -aq");
		expect(command).toContain("docker inspect --format");
		expect(command).toContain("{{json .State}}");
		expect(command).not.toContain(".Config.Env");
	});

	it("bounds the log volume per container", () => {
		const command = getContainerLogsCommand("app-backend-1");
		expect(command).toContain("--tail 200");
		expect(command).toContain("--timestamps");
		expect(command).toContain("2>&1 | cut -c1-2000");
		expect(command).toContain("timeout 30");
	});
});

describe("parseContainersInspect", () => {
	it("classifies container states", () => {
		const states = parseContainersInspect(
			[
				unhealthyBackend,
				healthyFrontend,
				crashedWorker,
				inspectLine("r-migrate-1", "migrate", {
					Status: "exited",
					ExitCode: 0,
				}),
				inspectLine("r-cron-1", "cron", { Status: "created" }),
				inspectLine("r-api-1", "api", {
					Status: "running",
					Health: { Status: "starting" },
				}),
				inspectLine("r-cache-1", "cache", { Status: "running" }),
				inspectLine("r-loop-1", "loop", { Status: "restarting", ExitCode: 1 }),
			].join("\n"),
		);
		expect(
			states.map(({ service, severity, status }) => [
				service,
				severity,
				status,
			]),
		).toEqual([
			["backend", "failing", "running, unhealthy"],
			["frontend", "ok", "running, healthy"],
			["worker", "failing", "exited, OOM killed"],
			["migrate", "stopped", "exited (code 0)"],
			["cron", "stopped", "created, never started"],
			["api", "failing", "running, healthcheck still starting"],
			["cache", "ok", "running"],
			["loop", "failing", "restarting"],
		]);
		expect(states[0]?.reference).toBe("release-backend-1");
		expect(states[0]?.healthProbes.map((probe) => probe.output)).toEqual([
			"probe 2",
			"probe 3",
			"curl: (7) Failed to connect to localhost port 3333",
		]);
		expect(states[2]?.details).toEqual(
			expect.arrayContaining([
				"Exit code: 137",
				"Killed by the kernel because it ran out of memory (OOM)",
				"Restarts: 3",
			]),
		);
	});
});

describe("collectComposeReleaseDiagnostics", () => {
	const backendLogs = Array.from(
		{ length: 30 },
		(_, index) => `backend line ${index + 1}`,
	).join("\n");

	const executor = () =>
		vi.fn(async (command: string) => {
			if (command.includes("docker inspect")) {
				return {
					stdout: [healthyFrontend, unhealthyBackend, crashedWorker].join("\n"),
					stderr: "",
				};
			}
			if (command.includes("release-backend-1")) {
				return { stdout: `${backendLogs}\n`, stderr: "" };
			}
			if (command.includes("release-worker-1")) {
				throw new ExecError("Remote command failed with exit code 255", {
					command,
					stderr: "ssh: connection reset",
					exitCode: 255,
				});
			}
			return { stdout: "frontend ready\n", stderr: "" };
		});

	it("captures every container, failing ones first", async () => {
		const execute = executor();
		const result = await collectComposeReleaseDiagnostics(
			execute,
			"app-zdt-abc123",
		);

		const logCommands = execute.mock.calls
			.map(([command]) => command)
			.filter((command) => command.includes("docker logs"));
		expect(logCommands).toHaveLength(3);
		expect(logCommands[0]).toContain("release-backend-1");
		expect(logCommands[1]).toContain("release-worker-1");
		expect(logCommands[2]).toContain("release-frontend-1");

		const report = result.report;
		expect(result.report).toContain(
			"===== Diagnostics: candidate containers =====",
		);
		expect(result.report).toMatch(/✗ backend\s+running, unhealthy/);
		expect(result.report).toMatch(/✓ frontend\s+running, healthy/);
		expect(report).toContain(
			"----- backend (release-backend-1): running, unhealthy -----",
		);
		expect(report).toContain(
			"[t4] exit 1: curl: (7) Failed to connect to localhost port 3333",
		);
		expect(report).toContain("backend line 1\n");
		expect(report).toContain("backend line 30");
		expect(report).toContain("frontend ready");
		expect(report).toContain(
			"Logs could not be read: Command failed (exit code 255). ssh: connection reset",
		);
	});

	it("summarizes only failing containers with their recent output", async () => {
		const { summary } = await collectComposeReleaseDiagnostics(
			executor(),
			"app-zdt-abc123",
		);
		expect(summary).toContain("- backend: running, unhealthy");
		expect(summary).toContain(
			"Last healthcheck: [t4] exit 1: curl: (7) Failed to connect to localhost port 3333",
		);
		expect(summary).toContain("Last 15 log lines:");
		expect(summary).toContain("backend line 30");
		expect(summary).toContain("backend line 16");
		expect(summary).not.toContain("backend line 15\n");
		expect(summary).toContain("- worker: exited, OOM killed");
		expect(summary).toContain(
			"- Running normally: frontend (running, healthy)",
		);
		expect(summary).not.toContain("frontend ready");
		expect(summary).toContain(
			'Full logs of every container are in the deployment log, section "Diagnostics: candidate containers".',
		);
	});

	it("reports a collection failure instead of throwing", async () => {
		const result = await collectComposeReleaseDiagnostics(async () => {
			throw new ExecError("Remote command failed with exit code 1", {
				command: "docker ps",
				stderr: "Cannot connect to the Docker daemon",
				exitCode: 1,
			});
		}, "app-zdt-abc123");
		expect(result.summary).toBe(
			"Container diagnostics could not be collected: Command failed (exit code 1). Cannot connect to the Docker daemon",
		);
		expect(result.report).toContain(result.summary);
	});

	it("selects containers by every label and maps their service name", async () => {
		const execute = vi.fn(async (command: string) => {
			if (command.includes("docker inspect"))
				return {
					stdout: `${inspectLine("pr-7_backend.1.task", "pr-7_backend", {
						Status: "exited",
						ExitCode: 1,
					})}\n`,
					stderr: "",
				};
			return { stdout: "boot failure\n", stderr: "" };
		});
		const result = await collectContainerDiagnostics(execute, {
			labels: [
				"com.dokploy.preview-id=preview-1",
				"com.dokploy.preview-generation=g1",
			],
			serviceLabel: "com.docker.swarm.service.name",
			title: "Diagnostics: preview containers",
			serviceName: (label) => label.replace(/^pr-7_/, ""),
		});
		const inspect = execute.mock.calls[0]?.[0] ?? "";
		expect(inspect).toContain("label\\=com.dokploy.preview-id\\=preview-1");
		expect(inspect).toContain("label\\=com.dokploy.preview-generation\\=g1");
		expect(inspect).toContain(
			'index .Config.Labels "com.docker.swarm.service.name"',
		);
		expect(
			spawnSync("bash", ["-n", "-c", inspect], { encoding: "utf8" }).status,
		).toBe(0);
		expect(result.report).toContain(
			"===== Diagnostics: preview containers =====",
		);
		expect(result.summary).toContain("- backend: exited (code 1)");
		expect(result.summary).toContain("boot failure");
	});

	it("reports unexpected inspect output instead of throwing", async () => {
		const result = await collectComposeReleaseDiagnostics(
			async () => ({ stdout: '{"Name":"/x"}\n', stderr: "" }),
			"app-zdt-abc123",
		);
		expect(result.summary).toBe(
			"Container diagnostics could not be collected: Unexpected docker inspect output",
		);
	});

	it("reports a release without containers", async () => {
		const result = await collectComposeReleaseDiagnostics(
			async () => ({ stdout: "", stderr: "" }),
			"app-zdt-abc123",
		);
		expect(result.report).toContain(
			"No containers were found for this release.",
		);
		expect(result.summary).toContain(
			"- No containers were found for this release.",
		);
	});
});

describe("formatDeploymentErrorWithDiagnostics", () => {
	it("appends attached diagnostics to the persisted message only", () => {
		const error = new ExecError("Remote command failed with exit code 1", {
			command: "docker compose up",
			stderr: "container backend is unhealthy",
			exitCode: 1,
		});
		attachDeploymentDiagnostics(error, "Container diagnostics:\n- backend");
		expect(formatDeploymentError(error)).not.toContain("Container diagnostics");
		expect(formatDeploymentErrorWithDiagnostics(error)).toBe(
			"Command failed (exit code 1).\ncontainer backend is unhealthy\n\nContainer diagnostics:\n- backend",
		);
	});

	it("leaves errors without diagnostics unchanged", () => {
		expect(formatDeploymentErrorWithDiagnostics(new Error("boom"))).toBe(
			"boom",
		);
		expect(formatDeploymentErrorWithDiagnostics("plain failure")).toBe(
			"plain failure",
		);
	});
});
