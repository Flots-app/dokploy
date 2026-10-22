import { execFileSync, spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "@dokploy/server/db";
import {
	apiCreateGithubRunnerPool,
	apiStartGithubRunnerEnrollment,
	type GithubRunnerDrain,
	type GithubRunnerPool,
} from "@dokploy/server/db/schema";
import { assertSecretsDestination } from "@dokploy/server/services/github-runner";
import {
	autoMaxRunners,
	budgetWarnings,
	effectiveBudget,
	resolveMaxRunners,
	sliceLimits,
	vmSize,
} from "@dokploy/server/utils/github-runners/budget";
import {
	linuxChecks,
	macChecks,
} from "@dokploy/server/utils/github-runners/checks";
import {
	clearPoolRouting,
	completeDrain,
	describeCleanup,
	generateMachineKey,
	limaLogLine,
	provisionRunnerNode,
	reconnectDelay,
	rerouteQueuedRuns,
	routePool,
} from "@dokploy/server/utils/github-runners/controller";
import {
	cleanupDue,
	type DiskSample,
	diskPressure,
	diskThresholds,
	fillRate,
	vmCleanupGoal,
	vmDiskThresholds,
} from "@dokploy/server/utils/github-runners/disk";
import {
	envKeys,
	parseEnvLines,
} from "@dokploy/server/utils/github-runners/env";
import { toClientError } from "@dokploy/server/utils/github-runners/errors";
import {
	createGithubRunnerClient,
	decodeJitConfig,
	findAppInstallation,
	type GithubRunner,
	GithubRunnerApiError,
	isPermanentGithubError,
	listRunnerReleases,
	resolveLimaRelease,
	resolveRunnerRelease,
	tokenExpiration,
} from "@dokploy/server/utils/github-runners/github-api";
import {
	LIMA_VERSION,
	macCreateVmScript,
	macDeleteVmScript,
	macInstallLimaScript,
	macProbeScript,
	macResizeVmScript,
	macStartVmScript,
	macStopVmScript,
	macWriteBootScript,
} from "@dokploy/server/utils/github-runners/macos";
import {
	nextMachine,
	type PlacementMachine,
	placeWaitingRunners,
	slotSpeed,
} from "@dokploy/server/utils/github-runners/placement";
import {
	type LocalSlot,
	parseBenchmark,
	parseCaches,
	parseCleanup,
	parseDockerSize,
	parseLinuxFacts,
	parseMacStatus,
	parseRecords,
	parseRuntimeStatus,
} from "@dokploy/server/utils/github-runners/probe";
import {
	isKillDrain,
	isRunnerOf,
	isStale,
	type PlannerNode,
	planNode,
	runnerNamePrefix,
	STARTUP_GRACE_MS,
	slotOfRunner,
} from "@dokploy/server/utils/github-runners/reconcile";
import {
	decideRerun,
	initialRerunStatus,
	MAX_RUN_ATTEMPTS,
} from "@dokploy/server/utils/github-runners/rerun";
import {
	decideRouting,
	ROUTING_GRACE_MS,
	routingSyncDue,
	runsOnExpression,
	waitsForPool,
} from "@dokploy/server/utils/github-runners/routing";
import {
	installRuntimeScript,
	linuxFactsScript,
	runnerEnvironment,
	sh,
	shellQuote,
} from "@dokploy/server/utils/github-runners/runtime";
import {
	machineSetupScript,
	parseSetupCode,
	publicKeyFingerprint,
	SETUP_CODE_PREFIX,
} from "@dokploy/server/utils/github-runners/setup";
import { MACHINE_NAME } from "@dokploy/server/utils/github-runners/setup-constants";
import {
	closeSharedSessions,
	fingerprintOf,
	HostKeyMismatchError,
	NodeCommandError,
	NodeNotStartedError,
	type NodeSession,
	openNodeSession,
	sharedNodeSession,
	UnknownHostKeyError,
} from "@dokploy/server/utils/github-runners/ssh";
import {
	compareVersions,
	RUNNER_UPDATE_DEADLINE_MS,
	runnerVersionStatus,
} from "@dokploy/server/utils/github-runners/versions";
import { DrizzleQueryError, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Server, utils } from "ssh2";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readSetupCode } from "@/components/dashboard/github-runners/enrollment-code";
import {
	boundedNumber,
	errorText,
	settleNumber,
} from "@/components/dashboard/github-runners/format";
import {
	appRegistrationUrl,
	githubWebUrl,
	labelFromName,
	parseGithubTarget,
	tokenTemplateUrl,
} from "@/components/dashboard/github-runners/github-links";
import { Slider } from "@/components/ui/slider";

const GiB = 1024 ** 3;

describe("budget", () => {
	it("caps the slice at the budget and pins the jobs to the last CPUs", () => {
		const limits = sliceLimits(
			{ cpus: 8, memoryBytes: 16 * GiB },
			{ cpuPercent: 70, memoryPercent: 50 },
		);
		expect(limits.cpuQuotaPercent).toBe(560);
		// 5.6 CPUs of quota spread over 6 CPUs, so nproc reports 6, not 8.
		expect(limits.allowedCpus).toBe("2-7");
		expect(limits.memoryMaxBytes).toBe(8 * GiB);
		expect(limits.cpus).toBe(5.6);
	});

	it("removes every limit at 100%", () => {
		const limits = sliceLimits(
			{ cpus: 8, memoryBytes: 16 * GiB },
			{ cpuPercent: 100, memoryPercent: 100 },
		);
		expect(limits).toMatchObject({
			cpuQuotaPercent: null,
			allowedCpus: null,
			memoryMaxBytes: null,
			cpus: 8,
			memoryBytes: 16 * GiB,
		});
	});

	it("pins a single CPU budget to the last CPU", () => {
		expect(
			sliceLimits(
				{ cpus: 4, memoryBytes: 8 * GiB },
				{ cpuPercent: 10, memoryPercent: 50 },
			).allowedCpus,
		).toBe("3");
	});

	it("sizes the macOS VM in whole CPUs and quarter GiB", () => {
		expect(
			vmSize(
				{ cpus: 10, memoryBytes: 16 * GiB },
				{ cpuPercent: 70, memoryPercent: 70 },
			),
		).toEqual({ cpus: 7, memoryBytes: 11 * GiB, memoryGiB: "11" });
		expect(
			vmSize(
				{ cpus: 10, memoryBytes: 24 * GiB },
				{ cpuPercent: 75, memoryPercent: 60 },
			).memoryGiB,
		).toBe("14.25");
		// Never below one CPU and 2 GiB.
		expect(
			vmSize(
				{ cpus: 4, memoryBytes: 8 * GiB },
				{ cpuPercent: 10, memoryPercent: 10 },
			),
		).toMatchObject({ cpus: 1, memoryBytes: 2 * GiB });
	});

	it("derives the concurrency from the budget in auto mode", () => {
		expect(autoMaxRunners({ cpus: 7, memoryBytes: 11 * GiB })).toBe(3);
		expect(autoMaxRunners({ cpus: 1, memoryBytes: 2 * GiB })).toBe(1);
		expect(autoMaxRunners({ cpus: 128, memoryBytes: 512 * GiB })).toBe(32);
		const budget = { cpuPercent: 70, memoryPercent: 70 };
		const host = { cpus: 10, memoryBytes: 16 * GiB };
		expect(resolveMaxRunners(0, "macos", host, budget)).toBe(3);
		expect(resolveMaxRunners(5, "macos", host, budget)).toBe(5);
		expect(resolveMaxRunners(0, "macos", null, budget)).toBe(1);
		expect(effectiveBudget("linux", host, budget).cpus).toBe(7);
	});

	it("warns when macOS keeps too little memory or jobs get too little", () => {
		const warnings = budgetWarnings(
			"macos",
			{ cpus: 10, memoryBytes: 16 * GiB },
			{ cpuPercent: 100, memoryPercent: 90, maxRunners: 8 },
		);
		expect(warnings.join(" ")).toMatch(/stay for macOS/);
		expect(warnings.join(" ")).toMatch(/less than 2 GiB each/);
		expect(
			budgetWarnings(
				"linux",
				{ cpus: 16, memoryBytes: 64 * GiB },
				{ cpuPercent: 70, memoryPercent: 70, maxRunners: 0 },
			),
		).toEqual([]);
	});
});

// GitHub answers JSON with its content type, which Octokit reads the body by.
const json = (status: number, body: unknown, headers: HeadersInit = {}) =>
	new Response(status === 204 ? null : JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", ...headers },
	});

const runner = (overrides: Partial<GithubRunner> = {}): GithubRunner => ({
	id: 1,
	name: "dkp-m4-1-abc123",
	os: "Linux",
	status: "online",
	busy: false,
	labels: ["self-hosted", "Linux", "ARM64", "ci"],
	customLabels: ["ci"],
	version: "2.329.0",
	...overrides,
});

describe("GitHub runner API", () => {
	const target = {
		scope: "organization" as const,
		owner: "Flots-app",
		repository: null,
		runnerGroup: "flots-linux-ci",
		apiUrl: "https://api.github.com",
	};

	it("resolves the runner group and registers a JIT runner", async () => {
		const calls: { url: string; method: string; body: unknown }[] = [];
		const client = createGithubRunnerClient(
			target,
			{ type: "token", token: "t" },
			{
				fetch: async (url, init) => {
					calls.push({
						url: String(url),
						method: init?.method ?? "GET",
						body: init?.body ? JSON.parse(String(init.body)) : null,
					});
					expect(new Headers(init?.headers).get("authorization")).toBe(
						"Bearer t",
					);
					if (String(url).includes("runner-groups")) {
						return json(200, {
							runner_groups: [
								{ id: 1, name: "Default" },
								{ id: 7, name: "flots-linux-ci" },
							],
						});
					}
					return json(201, { runner: { id: 42 }, encoded_jit_config: "abc" });
				},
			},
		);
		await expect(
			client.generateJitConfig({ name: "dkp-m4-1-a1b2c3", labels: ["ci"] }),
		).resolves.toEqual({ runnerId: 42, encodedJitConfig: "abc" });
		expect(calls[1]).toEqual({
			url: "https://api.github.com/orgs/Flots-app/actions/runners/generate-jitconfig",
			method: "POST",
			body: {
				name: "dkp-m4-1-a1b2c3",
				runner_group_id: 7,
				labels: ["ci"],
				work_folder: "_work",
			},
		});
	});

	it("uses the default group for repository runners without a lookup", async () => {
		const client = createGithubRunnerClient(
			{ ...target, scope: "repository", owner: "s1nyx", repository: "e2e" },
			{ type: "token", token: "t" },
			{ fetch: async () => json(500, {}) },
		);
		await expect(client.runnerGroupId()).resolves.toBe(1);
	});

	it("pages through the runners and keeps the custom labels apart", async () => {
		const page = (count: number, start: number) =>
			Array.from({ length: count }, (_, index) => ({
				id: start + index,
				name: `r-${start + index}`,
				os: "Linux",
				status: "online",
				busy: index === 0,
				labels: [
					{ name: "self-hosted", type: "read-only" },
					{ name: "ci", type: "custom" },
				],
				version: "2.329.0",
			}));
		const urls: string[] = [];
		const client = createGithubRunnerClient(
			target,
			{ type: "token", token: "t" },
			{
				fetch: async (url) => {
					urls.push(String(url));
					if (String(url).endsWith("/runner-groups?per_page=100")) {
						return json(200, {
							runner_groups: [{ id: 7, name: "flots-linux-ci" }],
						});
					}
					return String(url).endsWith("&page=1")
						? json(200, { total_count: 130, runners: page(100, 0) })
						: json(200, { total_count: 130, runners: page(30, 100) });
				},
			},
		);
		const runners = await client.listRunners();
		expect(runners).toHaveLength(130);
		expect(runners[0]).toMatchObject({
			busy: true,
			labels: ["self-hosted", "ci"],
			customLabels: ["ci"],
		});
		// Only the runner group of the pool, not every runner of the organization.
		expect(urls[1]).toBe(
			"https://api.github.com/orgs/Flots-app/actions/runner-groups/7/runners?per_page=100&page=1",
		);
	});

	it("revalidates the runner list with its ETag", async () => {
		const sent: (string | null)[] = [];
		const client = createGithubRunnerClient(
			{ ...target, scope: "repository", owner: "s1nyx", repository: "e2e" },
			{ type: "token", token: "t" },
			{
				fetch: async (_url, init) => {
					const etag = new Headers(init?.headers).get("if-none-match");
					sent.push(etag);
					if (etag === '"v1"') return new Response(null, { status: 304 });
					return new Response(
						JSON.stringify({
							total_count: 1,
							runners: [
								{
									id: 1,
									name: "r",
									os: "Linux",
									status: "online",
									busy: false,
									labels: [],
								},
							],
						}),
						{ status: 200, headers: { ETag: '"v1"' } },
					);
				},
			},
		);
		expect(await client.listRunners()).toHaveLength(1);
		expect(await client.listRunners()).toHaveLength(1);
		expect(sent).toEqual([null, '"v1"']);
	});

	it("maps the delete answers, a busy runner included", async () => {
		const statuses = [204, 404, 422];
		const client = createGithubRunnerClient(
			target,
			{ type: "token", token: "t" },
			{
				fetch: async () => json(statuses.shift() ?? 500, { message: "x" }),
			},
		);
		await expect(client.deleteRunner(1)).resolves.toBe("deleted");
		await expect(client.deleteRunner(1)).resolves.toBe("missing");
		await expect(client.deleteRunner(1)).resolves.toBe("busy");
		await expect(client.deleteRunner(1)).rejects.toThrow(/failed \(500\)/);
	});

	it("explains a missing permission", async () => {
		const client = createGithubRunnerClient(
			target,
			{ type: "token", token: "t" },
			{
				fetch: async () =>
					json(403, { message: "Resource not accessible by integration" }),
			},
		);
		await expect(client.listRunners()).rejects.toThrow(
			/Self-hosted runners: read and write/,
		);
	});

	it("names the runner groups when the configured one is missing", async () => {
		const client = createGithubRunnerClient(
			target,
			{ type: "token", token: "t" },
			{
				fetch: async () =>
					json(200, { runner_groups: [{ id: 1, name: "Default" }] }),
			},
		);
		await expect(client.runnerGroupId()).rejects.toThrow(/Available: Default/);
	});

	it("decodes a JIT configuration and refuses anything else", () => {
		const files = {
			".runner": Buffer.from('{"agentName":"x"}').toString("base64"),
			".credentials": Buffer.from("{}").toString("base64"),
			".credentials_rsaparams": Buffer.from("{}").toString("base64"),
		};
		const encoded = Buffer.from(JSON.stringify(files)).toString("base64");
		expect(decodeJitConfig(encoded).map((file) => file.name)).toEqual([
			".runner",
			".credentials",
			".credentials_rsaparams",
		]);
		const evil = Buffer.from(
			JSON.stringify({ ...files, "../../etc/passwd": "eA==" }),
		).toString("base64");
		expect(() => decodeJitConfig(evil)).toThrow(/unexpected/);
		const injected = Buffer.from(
			JSON.stringify({ ...files, ".runner": "a b\nname x" }),
		).toString("base64");
		expect(() => decodeJitConfig(injected)).toThrow(/unexpected/);
		expect(() => decodeJitConfig("not json")).toThrow();
	});

	it("resolves the runner archive and its published SHA-256", async () => {
		const sha = "a".repeat(64);
		const fetcher = async () =>
			json(200, {
				tag_name: "v2.329.0",
				body: `<!-- BEGIN SHA linux-x64 -->${"b".repeat(64)}<!-- END SHA linux-x64 -->`,
				assets: [
					{
						name: "actions-runner-linux-arm64-2.329.0.tar.gz",
						browser_download_url:
							"https://github.com/actions/runner/releases/download/v2.329.0/actions-runner-linux-arm64-2.329.0.tar.gz",
						digest: `sha256:${sha}`,
					},
					{
						name: "actions-runner-linux-x64-2.329.0.tar.gz",
						browser_download_url: "https://github.com/x64.tar.gz",
					},
				],
			});
		await expect(
			resolveRunnerRelease(null, "aarch64", { fetch: fetcher }),
		).resolves.toMatchObject({ version: "2.329.0", sha256: sha });
		await expect(
			resolveRunnerRelease(null, "x86_64", { fetch: fetcher }),
		).resolves.toMatchObject({ sha256: "b".repeat(64) });
		await expect(
			resolveRunnerRelease(null, "riscv64", { fetch: fetcher }),
		).rejects.toThrow(/Unsupported/);
	});
});

const job = (fields: Record<string, string>) =>
	Buffer.from(
		Object.entries(fields)
			.map(([key, value]) => `${key}=${value}`)
			.join("\n"),
	).toString("base64");

describe("probe parsing", () => {
	const status = [
		"runtime version=1",
		"host cpus=8 memory_kib=16384000 available_kib=8192000 arch=aarch64 load=1.25",
		"disk total_kib=104857600 free_kib=52428800",
		"release current=2.329.0",
		"cpu busy=1000 total=4000",
		"slice usage_usec=123456 memory_current=1048576 memory_max=max",
		"docker state=active",
		"slot id=1 active=active since=1700000000 name=dkp-m4-1-abc123",
		"slot id=2 active=inactive since= name=",
		`jobfile id=1 name=dkp-m4-1-abc123 job=${job({ repository: "Flots-app/monorepo", run_id: "99", run_attempt: "1", workflow: "CI Pipeline", job: "backend-tests", started: "1700000010" })}`,
		`jobfile id=3 name=dkp-m4-3-def456 job=${job({ repository: "Flots-app/monorepo", run_id: "98", run_attempt: "2", workflow: "CI", job: "lint", started: "1700000000", completed: "1700000060" })}`,
	].join("\n");

	it("reads the runtime status", () => {
		const parsed = parseRuntimeStatus(parseRecords(status));
		expect(parsed.runtimeVersion).toBe(1);
		expect(parsed.host).toMatchObject({ cpus: 8, arch: "aarch64", load: 1.25 });
		expect(parsed.disk?.freeBytes).toBe(52428800 * 1024);
		expect(parsed.release).toBe("2.329.0");
		expect(parsed.slice).toEqual({
			usageUsec: 123456,
			memoryCurrentBytes: 1048576,
			memoryMaxBytes: null,
		});
		expect(parsed.slots).toHaveLength(2);
		expect(parsed.slots[0]).toMatchObject({
			slot: 1,
			active: "active",
			since: 1700000000,
			runnerName: "dkp-m4-1-abc123",
			job: {
				repository: "Flots-app/monorepo",
				workflow: "CI Pipeline",
				job: "backend-tests",
				completedAt: null,
			},
		});
		expect(parsed.slots[1]?.job).toBeNull();
		expect(
			parsed.jobFiles.find((file) => file.slot === 3)?.job.completedAt,
		).toBe(new Date(1700000060 * 1000).toISOString());
	});

	it("does not attach the job of a previous runner of the slot", () => {
		const parsed = parseRuntimeStatus(
			parseRecords(
				[
					"slot id=1 active=active since=1700000000 name=dkp-m4-1-new000",
					`jobfile id=1 name=dkp-m4-1-old000 job=${job({ repository: "a/b", run_id: "1" })}`,
				].join("\n"),
			),
		);
		expect(parsed.slots[0]?.job).toBeNull();
	});

	it("reads a Mac with its VM and the runtime inside", () => {
		const mac = parseMacStatus(
			[
				"mac cpus=10 memory_bytes=17179869184 arch=arm64 version=26.1 load=2.10",
				"macmem free_percent=61",
				"macdisk total_kib=482797652 free_kib=34603008",
				"network github=200",
				"lima version=2.2.0",
				"vm status=Running cpus=7 memory_bytes=11811160064 disk_bytes=64424509440 type=vz",
				...status.split("\n").map((line) => `guest: ${line}`),
			].join("\n"),
		);
		expect(mac.host).toMatchObject({ cpus: 10, version: "26.1" });
		expect(mac.memoryFreePercent).toBe(61);
		expect(mac.githubReachable).toBe(true);
		expect(mac.limaVersion).toBe("2.2.0");
		expect(mac.vm).toMatchObject({ status: "Running", cpus: 7, type: "vz" });
		expect(mac.guest?.slots).toHaveLength(2);
		expect(mac.guestError).toBeNull();
	});

	it("reports what the guest said when the runtime does not answer", () => {
		const mac = parseMacStatus(
			[
				"vm status=Running cpus=2 memory_bytes=2147483648 disk_bytes=1 type=vz",
				"guest: sudo: a password is required",
			].join("\n"),
		);
		expect(mac.guest).toBeNull();
		expect(mac.guestError).toBe("sudo: a password is required");
		expect(parseMacStatus("lima version=\n").limaVersion).toBeNull();
		expect(parseMacStatus("vm status=missing").vm.status).toBe("missing");
	});

	it("reads the Linux facts", () => {
		const facts = parseLinuxFacts(
			[
				"os kernel=Linux arch=x86_64",
				"distro id=ubuntu version=24.04",
				"host cpus=4 memory_kib=8000000",
				"user root=no sudo=yes",
				"systemd present=yes",
				"cgroup fs=cgroup2fs",
				"apt present=yes",
				"disk total_kib=100 free_kib=50",
				"docker present=yes swarm=active containers=3",
				"network github=200",
				"runtime version=0",
			].join("\n"),
		);
		expect(facts).toMatchObject({
			kernel: "Linux",
			cpus: 4,
			sudo: true,
			root: false,
			cgroupV2: true,
			docker: { present: true, swarm: "active", containers: 3 },
			githubReachable: true,
		});
	});

	it("reads the cache sizes", () => {
		expect(parseDockerSize("1.234GB")).toBe(1_234_000_000);
		expect(parseDockerSize("512kB")).toBe(512_000);
		expect(parseDockerSize("0B")).toBe(0);
		expect(parseDockerSize("n/a")).toBeNull();
		const caches = parseCaches(
			[
				"docker type=Images size=5.5GB reclaimable=1.5GB",
				"docker type=Build_Cache size=2GB reclaimable=2GB",
				"docker type=Local_Volumes size=100MB reclaimable=100MB",
				"docker type=Containers size=0B reclaimable=0B",
				"dir name=tool_cache kib=1024",
				"dir name=home kib=",
				"dir name=workspaces kib=0",
			].join("\n"),
			new Date(0),
		);
		expect(caches).toMatchObject({
			dockerImagesBytes: 5_500_000_000,
			dockerBuildCacheBytes: 2_000_000_000,
			dockerReclaimableBytes: 3_600_000_000,
			toolCacheBytes: 1024 * 1024,
			homeCacheBytes: null,
			workspacesBytes: 0,
		});
	});
});

const NOW = Date.parse("2026-10-18T12:00:00Z");
const nowSeconds = NOW / 1000;
const prefix = runnerNamePrefix("m4");

const plannerNode = (overrides: Partial<PlannerNode> = {}): PlannerNode => ({
	enabled: true,
	phase: "ready",
	drain: null,
	maxRunners: 2,
	namePrefix: prefix,
	labels: ["self-hosted", "Linux", "ARM64", "ci"],
	runnerVersion: "2.329.0",
	admission: { ok: true },
	maxArmsPerTick: 4,
	...overrides,
});

const slot = (
	number: number,
	overrides: Partial<LocalSlot> = {},
): LocalSlot => ({
	slot: number,
	active: "active",
	since: nowSeconds - 60,
	runnerName: `${prefix}${number}-aaaaaa`,
	job: null,
	...overrides,
});

const ghRunner = (number: number, overrides: Partial<GithubRunner> = {}) =>
	runner({ id: 100 + number, name: `${prefix}${number}-aaaaaa`, ...overrides });

const drain = (
	overrides: Partial<GithubRunnerDrain> = {},
): GithubRunnerDrain => ({
	mode: "wait",
	reason: "disable",
	requestedAt: new Date(NOW - 1000).toISOString(),
	deadline: null,
	operationId: "op",
	...overrides,
});

const runningJob = {
	repository: "Flots-app/monorepo",
	runId: "1",
	runAttempt: "1",
	workflow: "CI",
	job: "test",
	startedAt: new Date(NOW - 30_000).toISOString(),
	completedAt: null,
};

describe("reconcile planner", () => {
	it("keeps every slot armed up to the concurrency", () => {
		const plan = planNode({
			now: NOW,
			node: plannerNode({ maxRunners: 3 }),
			slots: [slot(2)],
			runners: [ghRunner(2)],
		});
		expect(plan.actions).toEqual([
			{ type: "arm", slot: 1 },
			{ type: "arm", slot: 3 },
		]);
		expect(plan.slots[0]?.state).toBe("idle");
	});

	it("arms at most a few slots per tick", () => {
		const plan = planNode({
			now: NOW,
			node: plannerNode({ maxRunners: 10, maxArmsPerTick: 4 }),
			slots: [],
			runners: [],
		});
		expect(plan.actions.filter((action) => action.type === "arm")).toHaveLength(
			4,
		);
	});

	it("takes no job below the disk reserve", () => {
		const plan = planNode({
			now: NOW,
			node: plannerNode({ admission: { ok: false, reason: "disk" } }),
			slots: [],
			runners: [],
		});
		expect(plan.actions).toEqual([]);
	});

	it("waits for running jobs, releases idle runners, then reports drained", () => {
		const draining = plannerNode({
			enabled: false,
			phase: "draining",
			drain: drain(),
		});
		const plan = planNode({
			now: NOW,
			node: draining,
			slots: [slot(1), slot(2)],
			runners: [ghRunner(1, { busy: true }), ghRunner(2)],
		});
		expect(plan.actions).toEqual([
			{ type: "release", slot: 2, runnerId: 102, reason: "draining" },
		]);
		expect(plan.busy).toBe(1);
		expect(
			planNode({ now: NOW, node: draining, slots: [], runners: [] }).actions,
		).toEqual([{ type: "drained" }]);
	});

	it("treats a slot running a job as busy before GitHub reports it", () => {
		const plan = planNode({
			now: NOW,
			node: plannerNode({ enabled: false, phase: "draining", drain: drain() }),
			slots: [slot(1, { job: runningJob })],
			runners: [ghRunner(1, { busy: false })],
		});
		expect(plan.actions).toEqual([]);
		expect(plan.slots[0]?.state).toBe("busy");
	});

	it("never releases a runner whose job just completed", () => {
		const plan = planNode({
			now: NOW,
			node: plannerNode({ enabled: false, phase: "draining", drain: drain() }),
			slots: [
				slot(1, {
					job: { ...runningJob, completedAt: new Date(NOW).toISOString() },
				}),
			],
			runners: [ghRunner(1)],
		});
		expect(plan.actions).toEqual([]);
		expect(plan.slots[0]?.state).toBe("exited");
	});

	it("stops every slot, busy ones included, when killing", () => {
		const plan = planNode({
			now: NOW,
			node: plannerNode({
				enabled: false,
				phase: "draining",
				drain: drain({ mode: "kill" }),
			}),
			slots: [slot(1, { job: runningJob }), slot(2)],
			runners: [ghRunner(1, { busy: true }), ghRunner(2)],
		});
		expect(plan.actions).toEqual([
			{
				type: "stop",
				slot: 1,
				runnerId: 101,
				reason: "interrupting the running job",
			},
			{
				type: "stop",
				slot: 2,
				runnerId: 102,
				reason: "stopping the idle runner",
			},
		]);
	});

	it("switches to killing once the drain deadline passed", () => {
		const late = drain({ deadline: new Date(NOW - 1).toISOString() });
		expect(isKillDrain(late, NOW)).toBe(true);
		expect(
			isKillDrain(drain({ deadline: new Date(NOW + 1).toISOString() }), NOW),
		).toBe(false);
		const plan = planNode({
			now: NOW,
			node: plannerNode({ enabled: false, phase: "draining", drain: late }),
			slots: [slot(1, { job: runningJob })],
			runners: [ghRunner(1, { busy: true })],
		});
		expect(plan.actions[0]).toMatchObject({ type: "stop", slot: 1 });
	});

	it("scales down without interrupting jobs", () => {
		const plan = planNode({
			now: NOW,
			node: plannerNode({ maxRunners: 1 }),
			slots: [slot(1), slot(2), slot(3, { job: runningJob })],
			runners: [ghRunner(1), ghRunner(2), ghRunner(3, { busy: true })],
		});
		expect(plan.actions).toEqual([
			{
				type: "release",
				slot: 2,
				runnerId: 102,
				reason: "above the concurrency limit",
			},
		]);
	});

	it("recycles idle runners whose labels or release changed", () => {
		const node = plannerNode({
			labels: ["self-hosted", "Linux", "ARM64", "ci", "fast"],
		});
		expect(isStale(ghRunner(1), node)).toBe(true);
		expect(
			isStale(
				ghRunner(1, {
					labels: [...ghRunner(1).labels, "fast"],
					customLabels: ["ci", "fast"],
				}),
				node,
			),
		).toBe(false);
		// Read-only labels added by GitHub do not make a runner stale.
		expect(
			isStale(
				ghRunner(1, {
					labels: [...ghRunner(1).labels, "X64"],
					customLabels: ["ci"],
				}),
				plannerNode(),
			),
		).toBe(false);
		expect(isStale(ghRunner(1, { version: "2.328.0" }), plannerNode())).toBe(
			true,
		);
		const plan = planNode({
			now: NOW,
			node,
			slots: [slot(1), slot(2, { job: runningJob })],
			runners: [ghRunner(1), ghRunner(2, { busy: true })],
		});
		expect(plan.actions).toEqual([
			{
				type: "release",
				slot: 1,
				runnerId: 101,
				reason: "runner settings changed",
			},
		]);
	});

	it("unregisters runners no slot uses, but never a busy one", () => {
		const plan = planNode({
			now: NOW,
			node: plannerNode({ maxRunners: 1 }),
			slots: [slot(1)],
			runners: [
				ghRunner(1),
				runner({ id: 7, name: `${prefix}4-bbbbbb`, status: "offline" }),
				runner({ id: 8, name: `${prefix}5-cccccc`, busy: true }),
				runner({ id: 9, name: "dkp-m6-1-dddddd", status: "offline" }),
				runner({ id: 10, name: "macmini-m4-pool-1", status: "offline" }),
			],
		});
		expect(plan.actions).toEqual([
			{
				type: "forget",
				runnerId: 7,
				runnerName: `${prefix}4-bbbbbb`,
				reason: "registration left by a finished or stopped runner",
			},
		]);
	});

	it("restarts a runner that never came online", () => {
		const stuck = planNode({
			now: NOW,
			node: plannerNode({ maxRunners: 1 }),
			slots: [slot(1, { since: nowSeconds - STARTUP_GRACE_MS / 1000 - 1 })],
			runners: [ghRunner(1, { status: "offline" })],
		});
		expect(stuck.actions).toEqual([
			{
				type: "stop",
				slot: 1,
				runnerId: 101,
				reason: "runner did not come online",
			},
		]);
		const starting = planNode({
			now: NOW,
			node: plannerNode({ maxRunners: 1 }),
			slots: [slot(1, { since: nowSeconds - 10 })],
			runners: [ghRunner(1, { status: "offline" })],
		});
		expect(starting.actions).toEqual([]);
		expect(starting.slots[0]?.state).toBe("starting");
	});

	it("leaves stopping slots alone and counts them as running", () => {
		const plan = planNode({
			now: NOW,
			node: plannerNode({ enabled: false, phase: "draining", drain: drain() }),
			slots: [slot(1, { active: "deactivating" })],
			runners: [],
		});
		expect(plan.actions).toEqual([]);
		expect(plan.running).toBe(1);
		expect(plan.slots[0]?.state).toBe("stopping");
	});

	it("parses the slot from a runner name", () => {
		expect(slotOfRunner(prefix, `${prefix}12-a1b2c3`)).toBe(12);
		expect(slotOfRunner(prefix, "dkp-m4x-1-a1b2c3")).toBeNull();
		expect(slotOfRunner(prefix, `${prefix}1-A1`)).toBeNull();
	});

	it("leaves alone the runners of a machine whose name extends this one", () => {
		// "dkp-m4-" also starts the runners of a machine named "m4-2".
		const sibling = runnerNamePrefix("m4-2");
		expect(isRunnerOf(prefix, `${sibling}1-a1b2c3`)).toBe(false);
		expect(isRunnerOf(sibling, `${prefix}2-a1b2c3`)).toBe(false);
		expect(isRunnerOf(prefix, `${prefix}2-a1b2c3`)).toBe(true);
		const plan = planNode({
			now: NOW,
			node: plannerNode({ maxRunners: 1 }),
			slots: [slot(1)],
			runners: [
				ghRunner(1),
				runner({ id: 201, name: `${sibling}1-bbbbbb` }),
				runner({ id: 202, name: `${sibling}2-cccccc`, status: "offline" }),
			],
		});
		expect(plan.actions).toEqual([]);
	});
});

const machineKey = generateMachineKey("m6");

const scripts = () => ({
	setupMac: machineSetupScript({
		platform: "macos",
		machine: "m6",
		publicKey: machineKey.publicKey,
		keepAwake: true,
	}),
	setupLinux: machineSetupScript({
		platform: "linux",
		machine: "vm-1",
		publicKey: machineKey.publicKey,
		keepAwake: false,
	}),
	installLima: macInstallLimaScript({
		version: LIMA_VERSION,
		url: `https://github.com/lima-vm/lima/releases/download/v${LIMA_VERSION}/lima-${LIMA_VERSION}-Darwin-arm64.tar.gz`,
		sha256: "a".repeat(64),
	}),
	writeBoot: macWriteBootScript("dokploy-runners"),
	install: installRuntimeScript(),
	facts: linuxFactsScript(),
	probe: macProbeScript("dokploy-runners", true),
	create: macCreateVmScript("dokploy-runners", {
		cpus: 7,
		memoryGiB: "11.25",
		diskGb: 60,
	}),
	start: macStartVmScript("dokploy-runners"),
	stop: macStopVmScript("dokploy-runners"),
	resize: macResizeVmScript("dokploy-runners", {
		cpus: 7,
		memoryGiB: "11",
		diskGb: 80,
	}),
	remove: macDeleteVmScript("dokploy-runners"),
});

const extractRuntimeFile = (install: string, path: string) => {
	const start = install.indexOf(`write_file ${path} `);
	const body = install.slice(install.indexOf("\n", start) + 1);
	return body.slice(0, body.indexOf("\nDOKPLOY_EOF\n"));
};

describe("runtime scripts", () => {
	let dir: string;
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "dokploy-runner-scripts-"));
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	const files = () => {
		const all = scripts();
		return {
			...all,
			runnerctl: extractRuntimeFile(
				all.install,
				"/opt/dokploy-runners/bin/runnerctl",
			),
			started: extractRuntimeFile(
				all.install,
				"/opt/dokploy-runners/bin/job-started.sh",
			),
			completed: extractRuntimeFile(
				all.install,
				"/opt/dokploy-runners/bin/job-completed.sh",
			),
			bench: extractRuntimeFile(
				all.install,
				"/opt/dokploy-runners/bin/bench.sh",
			),
		};
	};

	it("keeps bash expansions literal", () => {
		expect(sh`a \${B:-c} ${"d"}`).toBe("a ${B:-c} d");
		const { runnerctl } = files();
		expect(runnerctl).toContain('[[ "${1:-}" =~ ^[0-9]{1,2}$ ]]');
		expect(runnerctl).toContain("^[0-9]+\\.[0-9]+\\.[0-9]+$");
		expect(runnerctl).not.toContain("\\${");
	});

	it("are valid bash", () => {
		for (const [name, content] of Object.entries(files())) {
			const file = join(dir, `${name}.sh`);
			writeFileSync(file, `#!/bin/bash\n${content}`);
			expect(() => execFileSync("bash", ["-n", file]), name).not.toThrow();
		}
	});

	const shellcheck = (() => {
		try {
			execFileSync("shellcheck", ["--version"]);
			return true;
		} catch {
			return false;
		}
	})();

	it.skipIf(!shellcheck)("pass shellcheck", () => {
		const paths = Object.entries(files()).map(([name, content]) => {
			const file = join(dir, `check-${name}.sh`);
			writeFileSync(file, `#!/bin/bash\n${content}`);
			return file;
		});
		expect(() =>
			execFileSync("shellcheck", ["-s", "bash", "-S", "warning", ...paths]),
		).not.toThrow();
	});

	it("records the job and chains the pool hook", () => {
		const { started } = files();
		const hook = join(dir, "job-started.sh");
		writeFileSync(hook, started.replace("/var/lib/dokploy-runners/jobs", dir));
		const poolHook = join(dir, "pool-hook.sh");
		writeFileSync(poolHook, 'echo "pool hook $GITHUB_JOB"\n');
		const output = execFileSync("bash", [hook], {
			env: {
				...process.env,
				DOKPLOY_RUNNER_SLOT: "3",
				GITHUB_REPOSITORY: "Flots-app/monorepo",
				GITHUB_RUN_ID: "99",
				GITHUB_RUN_ATTEMPT: "1",
				GITHUB_WORKFLOW: "CI Pipeline",
				GITHUB_JOB: "backend-tests",
				DOKPLOY_JOB_STARTED_HOOK: poolHook,
			},
		}).toString();
		expect(output.trim()).toBe("pool hook backend-tests");
		const recorded = execFileSync("cat", [join(dir, "3")]).toString();
		expect(recorded).toMatch(/^repository=Flots-app\/monorepo\nrun_id=99\n/);
		expect(recorded).toMatch(/workflow=CI Pipeline\n/);
	});

	it("makes a starting job wait for a cleanup that needs every cache", () => {
		const { started } = files();
		const lock = join(dir, "gc.lock");
		writeFileSync(lock, "1 1\n");
		const hook = join(dir, "job-started-wait.sh");
		writeFileSync(
			hook,
			started
				.replace("/var/lib/dokploy-runners/jobs", dir)
				.replaceAll("/var/lib/dokploy-runners/gc.lock", lock),
		);
		setTimeout(() => rmSync(lock, { force: true }), 1000);
		const startedAt = Date.now();
		return new Promise<void>((resolve, reject) => {
			const child = spawn("bash", [hook], {
				env: { ...process.env, DOKPLOY_RUNNER_SLOT: "4", GITHUB_JOB: "build" },
			});
			let output = "";
			child.stdout.on("data", (chunk) => {
				output += chunk;
			});
			child.on("error", reject);
			child.on("close", (code) => {
				try {
					expect(code).toBe(0);
					expect(output).toContain("waiting for the disk cleanup");
					expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1000);
					// The job is recorded before the wait, so the cleanup sees it.
					expect(execFileSync("cat", [join(dir, "4")]).toString()).toContain(
						"started=",
					);
					resolve();
				} catch (error) {
					reject(error);
				}
			});
		});
	}, 15_000);

	it("quotes the runner environment for systemd", () => {
		expect(
			runnerEnvironment({
				runnerEnv: 'A=1\n# comment\nB=has "quotes" and $HOME\n\n bad line',
				jobStartedHook: "/opt/flots-ci-hooks/job-started.sh",
				jobCompletedHook: null,
			}),
		).toBe(
			[
				"RUNNER_TOOL_CACHE=/opt/dokploy-runners/tool-cache",
				"AGENT_TOOLSDIRECTORY=/opt/dokploy-runners/tool-cache",
				"ACTIONS_RUNNER_HOOK_JOB_STARTED=/opt/dokploy-runners/bin/job-started.sh",
				"ACTIONS_RUNNER_HOOK_JOB_COMPLETED=/opt/dokploy-runners/bin/job-completed.sh",
				'DOKPLOY_JOB_STARTED_HOOK="/opt/flots-ci-hooks/job-started.sh"',
				'A="1"',
				'B="has \\"quotes\\" and \\$HOME"',
				"",
			].join("\n"),
		);
	});

	it("never calls GitHub from the probe run on every tick", () => {
		// The anonymous API quota is 60 calls per hour per IP, shared with everything else.
		expect(macProbeScript("dokploy-runners", true)).not.toContain("github.com");
		expect(macProbeScript("dokploy-runners", false)).toContain(
			"https://github.com",
		);
		expect(macProbeScript("dokploy-runners", false)).not.toContain(
			"api.github.com",
		);
		expect(linuxFactsScript()).not.toContain("api.github.com");
	});

	it("keeps only the useful lines of limactl", () => {
		expect(
			limaLogLine(
				'time="2026-10-18T20:27:05+02:00" level=info msg="READY. Run `limactl shell x` to open the shell."',
			),
		).toBe("VM ready");
		expect(
			limaLogLine(
				'time="x" level=fatal msg="vz driver is running but host agent is not"',
			),
		).toBe("Lima: vz driver is running but host agent is not");
		expect(
			limaLogLine('time="x" level=info msg="[hostagent] Waiting for ssh"'),
		).toBeNull();
		expect(limaLogLine("Removing vz.pid left by a previous boot")).toBe(
			"Removing vz.pid left by a previous boot",
		);
	});

	it("refuses VM names that would reach the shell", () => {
		expect(() => macStopVmScript("x; rm -rf /")).toThrow(/Invalid VM name/);
	});
});

describe("machine checks", () => {
	const settings = {
		vmName: "dokploy-runners",
		vmDiskGb: 60,
		diskReserveGb: 15,
		diskCleanupGb: 30,
		cpuPercent: 70,
		memoryPercent: 70,
		maxRunners: 0,
	};
	const facts = parseLinuxFacts(
		[
			"os kernel=Linux arch=aarch64",
			"distro id=ubuntu version=24.04",
			"host cpus=8 memory_kib=16000000",
			"user root=yes sudo=yes",
			"systemd present=yes",
			"cgroup fs=cgroup2fs",
			"apt present=yes",
			"disk total_kib=209715200 free_kib=104857600",
			"docker present=no",
			"network github=200",
			"runtime version=0",
		].join("\n"),
	);

	it("accepts a dedicated Linux machine", () => {
		const checks = linuxChecks(facts, settings);
		expect(checks.filter((item) => item.status !== "pass")).toEqual([]);
	});

	it("refuses a Swarm node and a machine without cgroup v2", () => {
		const checks = linuxChecks(
			{
				...facts,
				cgroupV2: false,
				docker: { present: true, swarm: "active", containers: 4 },
			},
			settings,
		);
		const failed = checks
			.filter((item) => item.status === "fail")
			.map((item) => item.id);
		expect(failed).toEqual(["cgroup", "dedicated"]);
	});

	it("installs Lima on a Mac and adopts an existing VM", () => {
		const mac = parseMacStatus(
			[
				"mac cpus=10 memory_bytes=17179869184 arch=arm64 version=26.1 load=1",
				"macdisk total_kib=482797652 free_kib=104857600",
				"network github=200",
				"lima version=",
			].join("\n"),
		);
		const lima = macChecks(mac, settings).find((item) => item.id === "lima");
		expect(lima?.status).toBe("pass");
		expect(lima?.message).toMatch(/Dokploy installs Lima/);
		const adopted = macChecks(
			{
				...mac,
				limaVersion: "2.2.0",
				vm: {
					status: "Running",
					cpus: 10,
					memoryBytes: 10 * GiB,
					diskBytes: 1,
					type: "vz",
				},
			},
			settings,
		);
		expect(adopted.find((item) => item.id === "vm")?.message).toMatch(
			/adopted/,
		);
		expect(adopted.every((item) => item.status !== "fail")).toBe(true);
	});

	it("reports what the setup script of a Mac configures", () => {
		const status = (setup: string) =>
			parseMacStatus(
				[
					"mac cpus=10 memory_bytes=34359738368 arch=arm64 version=26.1 load=1",
					"macdisk total_kib=482797652 free_kib=104857600",
					"network github=200",
					setup,
					`lima version=${LIMA_VERSION} managed=yes`,
				].join("\n"),
			);
		const enrolled = status(
			"macsetup admin=no sleep=0 filevault=off daemon=yes",
		);
		expect(enrolled.limaManaged).toBe(true);
		expect(
			macChecks(enrolled, settings).filter((item) => item.status !== "pass"),
		).toEqual([]);
		const legacy = macChecks(
			status("macsetup admin=yes sleep=10 filevault=on daemon=no"),
			settings,
		);
		expect(
			legacy.filter((item) => item.status === "warn").map((item) => item.id),
		).toEqual(["account", "power", "filevault", "boot"]);
		expect(legacy.every((item) => item.status !== "fail")).toBe(true);
		// Older probes report nothing about the setup: no warning either.
		expect(status("").setup).toBeNull();
	});
});

describe("disk cleanup", () => {
	const MiB = 1024 ** 2;
	const minutes = (count: number) => count * 60_000;

	it("cleans between the threshold and a headroom of 5% of the disk", () => {
		expect(
			diskThresholds(200 * GiB, { diskReserveGb: 15, diskCleanupGb: 30 }),
		).toEqual({
			reserveBytes: 15 * GiB,
			cleanupBytes: 30 * GiB,
			targetBytes: 40 * GiB,
		});
		// 5% of 2 TiB is capped at 25 GiB, 5% of 50 GiB raised to 5 GiB.
		expect(
			diskThresholds(2048 * GiB, { diskReserveGb: 15, diskCleanupGb: 30 })
				.targetBytes,
		).toBe(55 * GiB);
		expect(
			diskThresholds(50 * GiB, { diskReserveGb: 5, diskCleanupGb: 10 })
				.targetBytes,
		).toBe(15 * GiB);
		// The VM disk keeps 15% free, never less than the job floor plus 5 GiB.
		expect(vmDiskThresholds(60 * GiB)).toEqual({
			reserveBytes: 3 * GiB,
			cleanupBytes: 9 * GiB,
			targetBytes: 14 * GiB,
		});
		expect(vmDiskThresholds(20 * GiB).cleanupBytes).toBe(8 * GiB);
	});

	it("measures the fill rate over the last minutes", () => {
		const now = minutes(30);
		// 512 MiB written per minute for 8 minutes.
		const filling: DiskSample[] = Array.from({ length: 17 }, (_, index) => ({
			at: now - minutes(8) + index * 30_000,
			freeBytes: 100 * GiB - index * 256 * MiB,
		}));
		expect(fillRate(filling, now)).toBeCloseTo((512 * MiB) / minutes(1), 3);
		// Too little history to project anything.
		expect(fillRate(filling.slice(-3), now)).toBeNull();
		expect(
			fillRate(
				filling.filter((sample) => sample.at > now - minutes(2)),
				now,
			),
		).toBeNull();
	});

	it("cleans below the threshold, or before the jobs get there", () => {
		const thresholds = diskThresholds(200 * GiB, {
			diskReserveGb: 15,
			diskCleanupGb: 30,
		});
		expect(diskPressure(50 * GiB, 200 * GiB, thresholds, null)).toBeNull();
		expect(diskPressure(29 * GiB, 200 * GiB, thresholds, null)).toEqual({
			trigger: "low-disk",
			targetBytes: 40 * GiB,
			thresholdBytes: 30 * GiB,
			expectedBytes: 0,
		});
		// 2 GiB a minute: 20 GiB within the horizon would cross the threshold.
		const rate = (2 * GiB) / minutes(1);
		expect(diskPressure(45 * GiB, 200 * GiB, thresholds, rate)).toEqual({
			trigger: "filling",
			targetBytes: 60 * GiB,
			thresholdBytes: 30 * GiB,
			expectedBytes: 20 * GiB,
		});
		// Emptying disks and slow growth do not trigger anything.
		expect(diskPressure(45 * GiB, 200 * GiB, thresholds, -rate)).toBeNull();
		expect(
			diskPressure(45 * GiB, 200 * GiB, thresholds, rate / 100),
		).toBeNull();
	});

	it("frees in the VM what the Mac is missing", () => {
		const mac = diskPressure(
			20 * GiB,
			460 * GiB,
			diskThresholds(460 * GiB, { diskReserveGb: 15, diskCleanupGb: 30 }),
			null,
		);
		// The Mac needs 33 GiB more (target 30 + 23 GiB of headroom).
		expect(
			vmCleanupGoal(
				{ freeBytes: 40 * GiB, totalBytes: 60 * GiB, pressure: null },
				{ freeBytes: 20 * GiB, pressure: mac },
			),
		).toEqual({
			trigger: "low-disk",
			targetBytes: 60 * GiB,
			thresholdBytes: 50 * GiB,
			expectedBytes: 0,
		});
		const vm = diskPressure(
			8 * GiB,
			60 * GiB,
			vmDiskThresholds(60 * GiB),
			null,
		);
		expect(
			vmCleanupGoal(
				{ freeBytes: 8 * GiB, totalBytes: 60 * GiB, pressure: vm },
				{ freeBytes: 200 * GiB, pressure: null },
			),
		).toEqual({
			trigger: "low-disk",
			targetBytes: 14 * GiB,
			thresholdBytes: 9 * GiB,
			expectedBytes: 0,
		});
		expect(
			vmCleanupGoal(
				{ freeBytes: 40 * GiB, totalBytes: 60 * GiB, pressure: null },
				{ freeBytes: 200 * GiB, pressure: null },
			),
		).toBeNull();
	});

	it("retries soon after a cleanup, and at once when jobs it waited for end", () => {
		const now = minutes(100);
		expect(cleanupDue(undefined, now, 3, "low-disk")).toBe(true);
		const reached = {
			at: now - minutes(1),
			trigger: "low-disk" as const,
			reached: true,
			freedBytes: 4 * GiB,
			skippedForJobs: false,
		};
		expect(cleanupDue(reached, now, 0, "low-disk")).toBe(false);
		expect(
			cleanupDue({ ...reached, at: now - minutes(3) }, now, 0, "low-disk"),
		).toBe(true);
		const missed = { ...reached, at: now - minutes(5), reached: false };
		expect(cleanupDue(missed, now, 0, "low-disk")).toBe(false);
		expect(
			cleanupDue({ ...missed, at: now - minutes(11) }, now, 2, "low-disk"),
		).toBe(true);
		// The disk got low after a cleanup that only anticipated.
		expect(
			cleanupDue({ ...missed, trigger: "filling" }, now, 2, "low-disk"),
		).toBe(true);
		// Nothing left to remove: the disk is full of something else.
		const empty = { ...missed, at: now - minutes(11), freedBytes: 0 };
		expect(cleanupDue(empty, now, 0, "low-disk")).toBe(false);
		expect(
			cleanupDue({ ...empty, at: now - minutes(31) }, now, 0, "low-disk"),
		).toBe(true);
		// The step removing warm caches waited for jobs: retried once idle.
		const waited = { ...missed, skippedForJobs: true };
		expect(cleanupDue(waited, now, 2, "low-disk")).toBe(false);
		expect(cleanupDue(waited, now, 0, "low-disk")).toBe(true);
	});

	it("reads the cleanup report", () => {
		const output = [
			"freed kind=images kib=3145728 count=4",
			"freed kind=tool_cache kib=1048576 count=2",
			"freed kind=volumes kib=0 count=0",
			"freed kind=bogus kib=9 count=1",
			"gc mode=auto before_kib=20971520 free_kib=25165824 threshold_kib=31457280 target_kib=41943040 reached=no idle=skipped-jobs",
		].join("\n");
		const report = parseCleanup(output);
		expect(report).toEqual({
			mode: "auto",
			freeBeforeBytes: 20 * GiB,
			freeAfterBytes: 24 * GiB,
			targetBytes: 40 * GiB,
			reached: false,
			idle: "skipped-jobs",
			freed: [
				{ kind: "images", bytes: 3 * GiB, count: 4 },
				{ kind: "tool_cache", bytes: GiB, count: 2 },
			],
		});
		expect(parseCleanup("runnerctl: invalid thresholds")).toBeNull();
		expect(
			describeCleanup({
				at: "2026-10-18T10:00:00.000Z",
				trigger: "low-disk",
				durationMs: 1000,
				...(report as NonNullable<typeof report>),
			}),
		).toBe(
			"Disk cleanup freed 4 GiB (images 3 GiB, tool cache 1 GiB), 24 GiB free; short of the 40 GiB target; the caches in use go once the running jobs end",
		);
	});
});

describe("SSH session", () => {
	const hostKey = utils.generateKeyPairSync("ed25519");
	const clientKey = utils.generateKeyPairSync("ed25519");
	let server: Server;
	let port = 0;
	let logins = 0;
	const connected: { end: () => void }[] = [];

	beforeAll(async () => {
		server = new Server({ hostKeys: [hostKey.private] }, (client) => {
			connected.push(client);
			client
				.on("authentication", (context) =>
					context.method === "publickey"
						? context.accept()
						: context.reject(["publickey"]),
				)
				.on("ready", () => {
					logins++;
					client.on("session", (accept) => {
						const session = accept();
						session.on("exec", (acceptExec, _reject, info) => {
							const channel = acceptExec();
							const child = spawn("sh", ["-c", info.command]);
							channel.pipe(child.stdin);
							child.stdout.pipe(channel, { end: false });
							child.stderr.pipe(channel.stderr, { end: false });
							child.on("close", (code) => {
								channel.exit(code ?? 1);
								channel.end();
							});
						});
					});
				})
				.on("error", () => {});
		});
		await new Promise<void>((resolve) => {
			server.listen(0, "127.0.0.1", () => {
				port = (server.address() as { port: number }).port;
				resolve();
			});
		});
	});

	afterAll(() => server.close());

	const connection = (hostKeyFingerprint: string | null) => ({
		name: "test",
		host: "127.0.0.1",
		port,
		username: "runner",
		privateKey: clientKey.private,
		hostKeyFingerprint,
	});

	const expected = () =>
		fingerprintOf(
			utils.parseKey(hostKey.public) instanceof Error
				? Buffer.alloc(0)
				: (
						utils.parseKey(hostKey.public) as { getPublicSSH: () => Buffer }
					).getPublicSSH(),
		);

	it("pins the host key and runs scripts through stdin or with input", async () => {
		const session = await openNodeSession(connection(null));
		expect(session.fingerprint).toBe(expected());
		await expect(session.run('echo "$((40 + 2))"')).resolves.toMatchObject({
			stdout: "42\n",
			exitCode: 0,
		});
		await expect(
			session.run("tr a-z A-Z", { input: "it's quoted\n" }),
		).resolves.toMatchObject({ stdout: "IT'S QUOTED\n" });
		await expect(session.run("echo boom >&2; exit 3")).rejects.toThrow(
			/exit 3\): boom/,
		);
		await expect(
			session.run("exit 3", { allowFailure: true }),
		).resolves.toMatchObject({ exitCode: 3 });
		await expect(
			session.run("sleep 5", { timeoutMs: 200, label: "Sleep" }),
		).rejects.toThrow(/Sleep timed out/);
		session.close();
	});

	it("refuses a host key that changed", async () => {
		await expect(
			openNodeSession(connection("SHA256:somethingelse")),
		).rejects.toBeInstanceOf(HostKeyMismatchError);
		const pinned = await openNodeSession(connection(expected()));
		pinned.close();
	});

	it("only trusts the host keys the setup code lists", async () => {
		const other = utils.generateKeyPairSync("ed25519");
		const otherFingerprint = publicKeyFingerprint(other.public);
		await expect(
			openNodeSession({
				...connection(null),
				knownHostKeys: [otherFingerprint],
			}),
		).rejects.toBeInstanceOf(UnknownHostKeyError);
		const known = await openNodeSession({
			...connection(null),
			knownHostKeys: [otherFingerprint, expected()],
		});
		expect(known.fingerprint).toBe(expected());
		known.close();
	});

	it("shares one connection per machine", async () => {
		const target = { ...connection(expected()), name: "shared" };
		const before = logins;
		const [first, second] = await Promise.all([
			sharedNodeSession(target),
			sharedNodeSession(target),
		]);
		const outputs = await Promise.all(
			[1, 2, 3].map((value) =>
				(value % 2 ? first : second).run(`echo ${value}`),
			),
		);
		expect(outputs.map((output) => output.stdout)).toEqual([
			"1\n",
			"2\n",
			"3\n",
		]);
		first.close();
		await second.run("true");
		expect(logins - before).toBe(1);
		closeSharedSessions(target);
		await (await sharedNodeSession(target)).run("true");
		expect(logins - before).toBe(2);
		closeSharedSessions(target);
	});

	it("replaces a connection the machine closed", async () => {
		const target = { ...connection(expected()), name: "rebooted" };
		const session = await sharedNodeSession(target);
		await session.run("true");
		const before = logins;
		// The machine reboots: its side of every connection goes away.
		for (const client of connected.splice(0)) client.end();
		await new Promise((resolve) => setTimeout(resolve, 200));
		await expect(session.run("echo back")).resolves.toMatchObject({
			stdout: "back\n",
		});
		expect(logins - before).toBe(1);
		closeSharedSessions(target);
	});

	it("reports a closed connection as a command that never started", async () => {
		const plain = await openNodeSession(connection(expected()));
		for (const client of connected.splice(0)) client.end();
		await new Promise((resolve) => setTimeout(resolve, 200));
		await expect(plain.run("true")).rejects.toBeInstanceOf(NodeNotStartedError);
		plain.close();
	});
});

describe("shared SSH connections", () => {
	const fakeSession = (run: NodeSession["run"]): NodeSession => ({
		fingerprint: "SHA256:fake",
		run,
		close: () => undefined,
	});
	const target = (name: string) => ({
		name,
		host: `${name}.test`,
		port: 22,
		username: "dokploy-manager",
		privateKey: "key",
		hostKeyFingerprint: null,
	});
	const notStarted = () =>
		new NodeNotStartedError("Probe could not start on m6: Not connected");

	it("runs a command again on a new connection when it could not start", async () => {
		const runs = [
			vi.fn().mockRejectedValue(notStarted()),
			vi.fn().mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0 }),
		];
		const open = vi.fn(async () =>
			fakeSession(runs[open.mock.calls.length - 1]!),
		);
		const session = await sharedNodeSession(target("retry"), open);
		await expect(session.run("true")).resolves.toMatchObject({ stdout: "ok" });
		expect(open).toHaveBeenCalledTimes(2);
		closeSharedSessions(target("retry"));
	});

	it("never runs a command twice once it may have started", async () => {
		// The channel request went out before the connection dropped.
		const run = vi
			.fn()
			.mockRejectedValueOnce(
				new Error("Deploy could not start on m6: No response from server"),
			)
			.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
		const open = vi.fn(async () => fakeSession(run));
		const session = await sharedNodeSession(target("started"), open);
		await expect(session.run("deploy")).rejects.toThrow(/No response/);
		expect(run).toHaveBeenCalledTimes(1);
		// The connection is replaced for the next command.
		await session.run("true");
		expect(open).toHaveBeenCalledTimes(2);
		closeSharedSessions(target("started"));
	});

	it("keeps the connection when the command itself fails", async () => {
		const run = vi
			.fn()
			.mockRejectedValueOnce(new NodeCommandError("m6", 1, "", "boom", "Probe"))
			.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
		const open = vi.fn(async () => fakeSession(run));
		const session = await sharedNodeSession(target("failing"), open);
		await expect(session.run("false")).rejects.toThrow(/boom/);
		await session.run("true");
		expect(open).toHaveBeenCalledTimes(1);
		closeSharedSessions(target("failing"));
	});

	it("gives up after one retry", async () => {
		const open = vi.fn(async () =>
			fakeSession(vi.fn().mockRejectedValue(notStarted())),
		);
		const session = await sharedNodeSession(target("down"), open);
		await expect(session.run("true")).rejects.toThrow(/could not start/);
		expect(open).toHaveBeenCalledTimes(2);
		closeSharedSessions(target("down"));
	});

	it("forgets a connection that failed to open", async () => {
		const open = vi
			.fn<typeof openNodeSession>()
			.mockRejectedValueOnce(new Error("ECONNREFUSED"))
			.mockResolvedValue(
				fakeSession(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
			);
		await expect(sharedNodeSession(target("flaky"), open)).rejects.toThrow(
			"ECONNREFUSED",
		);
		await expect(
			(await sharedNodeSession(target("flaky"), open)).run("true"),
		).resolves.toMatchObject({ exitCode: 0 });
		closeSharedSessions(target("flaky"));
	});
});

describe("recovery of interrupted jobs", () => {
	const job = {
		runnerName: "dkp-m6-1-abc123",
		runAttempt: "1",
		rerunStatus: "pending",
	};
	const run = (overrides = {}) => ({
		status: "in_progress",
		conclusion: null,
		runAttempt: 1,
		...overrides,
	});
	const runJob = (
		runnerName: string | null,
		status: string,
		conclusion: string | null = null,
	) => ({
		name: "job",
		status,
		conclusion,
		runnerName,
		labels: ["self-hosted", "flots-ci"],
		createdAt: null,
	});

	it("decides whether an interrupted job is re-run at all", () => {
		expect(initialRerunStatus(true, "1")).toBe("pending");
		expect(initialRerunStatus(true, String(MAX_RUN_ATTEMPTS))).toBe("skipped");
		expect(initialRerunStatus(false, "1")).toBeNull();
	});

	it("re-runs the failed jobs once the run completed", () => {
		expect(
			decideRerun(job, run({ status: "completed", conclusion: "failure" }), [
				runJob(job.runnerName, "completed", "failure"),
			]),
		).toMatchObject({ action: "rerun" });
		expect(
			decideRerun(job, run({ status: "completed", conclusion: "success" }), [
				runJob(job.runnerName, "completed", "success"),
			]),
		).toMatchObject({ action: "skip" });
	});

	it("cancels a run whose only active job is the one a crash left behind", () => {
		expect(
			decideRerun(job, run(), [
				runJob(job.runnerName, "in_progress"),
				runJob("dkp-m4-2-def456", "completed", "success"),
			]),
		).toMatchObject({ action: "cancel" });
	});

	it("waits while other jobs of the run still run or the run is cancelling", () => {
		expect(
			decideRerun(job, run(), [
				runJob(job.runnerName, "in_progress"),
				runJob("dkp-m4-2-def456", "in_progress"),
			]),
		).toEqual({ action: "wait" });
		expect(
			decideRerun(job, run(), [
				runJob(job.runnerName, "completed", "failure"),
				runJob(null, "queued"),
			]),
		).toEqual({ action: "wait" });
		expect(
			decideRerun({ ...job, rerunStatus: "cancelling" }, run(), [
				runJob(job.runnerName, "in_progress"),
			]),
		).toEqual({ action: "wait" });
	});

	it("never acts on a run this runner did not run or that was re-run already", () => {
		expect(
			decideRerun(job, run({ status: "completed", conclusion: "failure" }), [
				runJob("someone-else", "completed", "failure"),
			]),
		).toMatchObject({
			action: "skip",
			note: "this runner ran no job of that run",
		});
		expect(
			decideRerun(job, run({ status: "completed", runAttempt: 2 }), [
				runJob(job.runnerName, "completed", "failure"),
			]),
		).toMatchObject({ action: "skip" });
	});

	it("refuses runs outside the pool before calling GitHub", async () => {
		let calls = 0;
		const client = createGithubRunnerClient(
			{
				scope: "repository",
				owner: "s1nyx",
				repository: "dokploy-runner-e2e",
				runnerGroup: "Default",
				apiUrl: "https://api.github.com",
			},
			{ type: "token", token: "t" },
			{
				fetch: async () => {
					calls++;
					return json(200, {
						status: "completed",
						conclusion: "failure",
						run_attempt: 1,
					});
				},
			},
		);
		await expect(client.getRun("s1nyx/other-repo", "1")).rejects.toThrow(
			/outside this pool/,
		);
		await expect(client.getRun("evil/dokploy-runner-e2e", "1")).rejects.toThrow(
			/outside this pool/,
		);
		await expect(
			client.getRun("s1nyx/dokploy-runner-e2e", "1/../../x"),
		).rejects.toThrow(/outside this pool/);
		expect(calls).toBe(0);
		await expect(
			client.getRun("s1nyx/dokploy-runner-e2e", "42"),
		).resolves.toEqual({
			status: "completed",
			conclusion: "failure",
			runAttempt: 1,
		});
		const org = createGithubRunnerClient(
			{
				scope: "organization",
				owner: "Flots-app",
				repository: null,
				runnerGroup: "Default",
				apiUrl: "https://api.github.com",
			},
			{ type: "token", token: "t" },
			{ fetch: async () => json(202, {}) },
		);
		await expect(
			org.forceCancelRun("Flots-app/monorepo", "7"),
		).resolves.toBeUndefined();
		await expect(
			org.rerunFailedJobs("other-org/monorepo", "7"),
		).rejects.toThrow(/outside this pool/);
	});
});

describe("guided setup", () => {
	const params = (url: string) =>
		Object.fromEntries(new URL(url).searchParams.entries());

	it("pre-fills the token and the App with the permissions a pool needs", () => {
		const token = tokenTemplateUrl(
			"https://github.com",
			"organization",
			"Flots-app",
		);
		expect(token).toMatch(
			/^https:\/\/github\.com\/settings\/personal-access-tokens\/new\?/,
		);
		expect(params(token)).toMatchObject({
			target_name: "Flots-app",
			expires_in: "366",
			organization_self_hosted_runners: "write",
			organization_actions_variables: "write",
			actions: "write",
		});
		expect(
			params(tokenTemplateUrl("https://github.com", "repository", "s1nyx")),
		).toMatchObject({
			administration: "write",
			actions_variables: "write",
			actions: "write",
		});
		const app = appRegistrationUrl(
			"https://github.com",
			"organization",
			"Flots-app",
			"https://dokploy.example.com",
		);
		expect(app).toMatch(
			/^https:\/\/github\.com\/organizations\/Flots-app\/settings\/apps\/new\?/,
		);
		expect(params(app)).toMatchObject({
			public: "false",
			webhook_active: "false",
			url: "https://dokploy.example.com",
			organization_self_hosted_runners: "write",
		});
		expect(params(app).name?.length).toBeLessThanOrEqual(34);
		expect(githubWebUrl("https://ghe.example.com/api/v3")).toBe(
			"https://ghe.example.com",
		);
	});

	it("reads what people paste as the owner", () => {
		expect(parseGithubTarget("https://github.com/Flots-app")).toEqual({
			owner: "Flots-app",
			repository: null,
		});
		expect(parseGithubTarget("https://github.com/orgs/Flots-app/")).toEqual({
			owner: "Flots-app",
			repository: null,
		});
		expect(
			parseGithubTarget("https://github.com/Flots-app/monorepo.git"),
		).toEqual({ owner: "Flots-app", repository: "monorepo" });
		expect(parseGithubTarget("Flots-app/monorepo")).toEqual({
			owner: "Flots-app",
			repository: "monorepo",
		});
		expect(labelFromName("Flots CI (Mac minis)")).toBe("flots-ci-mac-minis");
	});

	const { privateKey } = generateKeyPairSync("rsa", {
		modulusLength: 2048,
		privateKeyEncoding: { type: "pkcs1", format: "pem" },
		publicKeyEncoding: { type: "spki", format: "pem" },
	});
	const target = {
		scope: "organization" as const,
		owner: "Flots-app",
		repository: null,
		apiUrl: "https://api.github.com",
	};

	it("finds the App installation from the App ID and its key", async () => {
		const urls: string[] = [];
		await expect(
			findAppInstallation({ appId: 1, privateKey }, target, {
				fetch: async (url, init) => {
					urls.push(String(url));
					expect(new Headers(init?.headers).get("authorization")).toMatch(
						/^Bearer ey/,
					);
					return json(200, { id: 987654 });
				},
			}),
		).resolves.toBe("987654");
		expect(urls).toEqual([
			"https://api.github.com/orgs/Flots-app/installation",
		]);
	});

	it("says where to install an App that is not installed", async () => {
		await expect(
			findAppInstallation({ appId: 1, privateKey }, target, {
				fetch: async (url) =>
					String(url).endsWith("/app")
						? json(200, { html_url: "https://github.com/apps/dokploy-runners" })
						: json(404, { message: "Not Found" }),
			}),
		).rejects.toThrow(
			"The GitHub App is not installed on Flots-app. Install it from https://github.com/apps/dokploy-runners/installations/new",
		);
		await expect(
			findAppInstallation({ appId: 1, privateKey: "nope" }, target, {
				fetch: async () => json(200, {}),
			}),
		).rejects.toThrow("not a GitHub App key");
	});

	it("lists the runner groups with who may use them, and the token expiry", async () => {
		const client = createGithubRunnerClient(
			{ ...target, runnerGroup: "Default" },
			{ type: "token", token: "t" },
			{
				fetch: async () =>
					json(200, {
						runner_groups: [
							{
								id: 1,
								name: "Default",
								default: true,
								visibility: "all",
								allows_public_repositories: false,
							},
							{ id: 4, name: "ci", visibility: "selected" },
						],
					}),
			},
		);
		await expect(client.runnerGroups()).resolves.toEqual([
			{
				id: 1,
				name: "Default",
				default: true,
				visibility: "all",
				allowsPublicRepositories: false,
			},
			{
				id: 4,
				name: "ci",
				default: false,
				visibility: "selected",
				allowsPublicRepositories: false,
			},
		]);
		await expect(
			tokenExpiration("t", "https://api.github.com", {
				fetch: async () =>
					new Response("{}", {
						headers: {
							"github-authentication-token-expiration":
								"2027-10-19 08:00:00 UTC",
						},
					}),
			}),
		).resolves.toBe("2027-10-19 08:00:00 UTC");
	});
});

describe("routing with a GitHub-hosted fallback", () => {
	const minutes = (count: number) => count * 60_000;
	const start = Date.parse("2026-10-19T08:00:00.000Z");
	const base = {
		labels: ["flots-app"],
		fallbackLabels: ["ubuntu-24.04"],
		anyEnabled: true,
	};

	it("sends jobs to the pool while a runner is ON, after a grace otherwise", () => {
		const on = decideRouting({
			...base,
			previous: null,
			available: true,
			now: start,
		});
		expect(on).toMatchObject({
			target: "pool",
			value: '["self-hosted","flots-app"]',
			unavailableSince: null,
		});
		// A runner being replaced: the pool stays the target for two minutes.
		const blip = decideRouting({
			...base,
			previous: on,
			available: false,
			now: start + minutes(1),
		});
		expect(blip).toMatchObject({
			target: "pool",
			unavailableSince: "2026-10-19T08:01:00.000Z",
		});
		const off = decideRouting({
			...base,
			previous: blip,
			available: false,
			now: start + minutes(1) + ROUTING_GRACE_MS,
		});
		expect(off).toMatchObject({
			target: "fallback",
			value: '"ubuntu-24.04"',
			since: "2026-10-19T08:03:00.000Z",
		});
		// Back as soon as one runner is ON.
		expect(
			decideRouting({
				...base,
				previous: off,
				available: true,
				now: start + minutes(10),
			}),
		).toMatchObject({ target: "pool", unavailableSince: null });
	});

	it("falls back at once when no machine is enabled or nothing ran yet", () => {
		const on = decideRouting({
			...base,
			previous: null,
			available: true,
			now: start,
		});
		expect(
			decideRouting({
				...base,
				anyEnabled: false,
				previous: on,
				available: false,
				now: start + 1000,
			}).target,
		).toBe("fallback");
		expect(
			decideRouting({ ...base, previous: null, available: false, now: start })
				.target,
		).toBe("fallback");
		expect(
			decideRouting({
				...base,
				fallbackLabels: ["ubuntu-24.04", "x64"],
				previous: null,
				available: false,
				now: start,
			}).value,
		).toBe('["ubuntu-24.04","x64"]');
	});

	it("writes the variable when it changes, retries errors, re-checks it", () => {
		const routing = {
			...decideRouting({
				...base,
				previous: null,
				available: true,
				now: start,
			}),
			variable: "DOKPLOY_RUNS_ON",
			syncedValue: '["self-hosted","flots-app"]',
			syncedAt: "2026-10-19T08:00:00.000Z",
			attemptedAt: "2026-10-19T08:00:00.000Z",
		};
		expect(routingSyncDue(routing, "DOKPLOY_RUNS_ON", start + 1000)).toBe(
			false,
		);
		expect(routingSyncDue(routing, "OTHER", start + 1000)).toBe(true);
		expect(
			routingSyncDue(
				{ ...routing, value: '"ubuntu-24.04"' },
				"DOKPLOY_RUNS_ON",
				start + 1000,
			),
		).toBe(true);
		const failing = {
			...routing,
			value: '"ubuntu-24.04"',
			error: "403",
		};
		expect(routingSyncDue(failing, "DOKPLOY_RUNS_ON", start + 10_000)).toBe(
			false,
		);
		expect(routingSyncDue(failing, "DOKPLOY_RUNS_ON", start + 31_000)).toBe(
			true,
		);
		expect(
			routingSyncDue(routing, "DOKPLOY_RUNS_ON", start + minutes(16)),
		).toBe(true);
	});

	it("only moves the jobs that ask for every label of the pool", () => {
		expect(waitsForPool(["self-hosted", "Flots-App"], ["flots-app"])).toBe(
			true,
		);
		expect(
			waitsForPool(["self-hosted", "flots-app", "dokploy-m6"], ["flots-app"]),
		).toBe(true);
		expect(waitsForPool(["ubuntu-24.04"], ["flots-app"])).toBe(false);
		expect(
			waitsForPool(
				["self-hosted", "macOS", "flots-mac-mini-m4"],
				["flots-app"],
			),
		).toBe(false);
		// A pool without label would match every self-hosted job.
		expect(waitsForPool(["self-hosted"], [])).toBe(false);
		expect(runsOnExpression("DOKPLOY_RUNS_ON", ["ubuntu-24.04"])).toBe(
			`\${{ fromJSON(vars.DOKPLOY_RUNS_ON || '"ubuntu-24.04"') }}`,
		);
	});

	it("creates or updates the variable, private repositories only", async () => {
		const calls: { method: string; url: string; body: unknown }[] = [];
		const client = createGithubRunnerClient(
			{
				scope: "organization",
				owner: "Flots-app",
				repository: null,
				runnerGroup: "Default",
				apiUrl: "https://api.github.com",
			},
			{ type: "token", token: "t" },
			{
				fetch: async (url, init) => {
					const method = init?.method ?? "GET";
					calls.push({
						method,
						url: String(url),
						body: init?.body ? JSON.parse(String(init.body)) : null,
					});
					if (method === "PATCH") return json(404, { message: "Not Found" });
					if (method === "POST") return json(201, {});
					if (method === "DELETE") return json(404, {});
					return json(200, [
						{ full_name: "Flots-app/monorepo", private: true },
						{ full_name: "Flots-app/old", private: true, archived: true },
						{ full_name: "Flots-app/dokploy", private: false },
					]);
				},
			},
		);
		await client.setVariable("DOKPLOY_RUNS_ON", '"ubuntu-24.04"');
		expect(calls.slice(0, 2)).toEqual([
			{
				method: "PATCH",
				url: "https://api.github.com/orgs/Flots-app/actions/variables/DOKPLOY_RUNS_ON",
				body: {
					name: "DOKPLOY_RUNS_ON",
					value: '"ubuntu-24.04"',
					visibility: "private",
				},
			},
			{
				method: "POST",
				url: "https://api.github.com/orgs/Flots-app/actions/variables",
				body: {
					name: "DOKPLOY_RUNS_ON",
					value: '"ubuntu-24.04"',
					visibility: "private",
				},
			},
		]);
		await expect(client.deleteVariable("DOKPLOY_RUNS_ON")).resolves.toBe(
			undefined,
		);
		await expect(client.listRepositories()).resolves.toEqual([
			"Flots-app/monorepo",
		]);
		await expect(client.listQueuedRuns("someone/else")).rejects.toThrow(
			"outside this pool",
		);
	});

	it("names the missing permission when GitHub refuses the variable", async () => {
		const client = createGithubRunnerClient(
			{
				scope: "repository",
				owner: "s1nyx",
				repository: "dokploy-runner-e2e",
				runnerGroup: "Default",
				apiUrl: "https://api.github.com",
			},
			{ type: "token", token: "t" },
			{ fetch: async () => json(403, { message: "Resource not accessible" }) },
		);
		await expect(client.setVariable("X", "1")).rejects.toThrow(
			'"Variables: read and write" on the repository',
		);
		await expect(client.canManageVariables()).resolves.toBe(false);
	});
});

describe("fastest-first placement", () => {
	// Measured budgets: the M6 is faster per core, the M4 has more cores free.
	const m6: PlacementMachine = {
		id: "m6",
		accepting: true,
		maxRunners: 3,
		busy: 0,
		speed: { single: 1300, multi: 9100 },
		cpus: 7,
	};
	const m4: PlacementMachine = {
		id: "m4",
		accepting: true,
		maxRunners: 4,
		busy: 0,
		speed: { single: 1000, multi: 10_000 },
		cpus: 10,
	};
	const targets = (machines: PlacementMachine[]) =>
		Object.fromEntries(placeWaitingRunners(machines, "fastest"));

	it("rates a slot by the job's share of the budget, capped by what a job uses", () => {
		expect(slotSpeed(m6, 1)).toBe(5200);
		expect(slotSpeed(m6, 2)).toBe(4550);
		expect(slotSpeed(m4, 3)).toBeCloseTo(3333.3, 0);
		// Unmeasured machines score from their CPUs.
		expect(slotSpeed({ ...m4, speed: null }, 1)).toBe(4000);
	});

	it("waits only on the M6 while it runs jobs faster than the M4", () => {
		expect(targets([m6, m4])).toEqual({
			m6: { arm: 2, keep: 3 },
			m4: { arm: 0, keep: 2 },
		});
		expect(nextMachine([m6, m4])).toBe("m6");
	});

	it("opens the M4 once a job on the M6 makes it about as fast", () => {
		expect(targets([{ ...m6, busy: 1 }, m4])).toEqual({
			m6: { arm: 1, keep: 2 },
			m4: { arm: 2, keep: 3 },
		});
		// The M6 full: everything waits on the M4.
		expect(targets([{ ...m6, busy: 3 }, m4]).m4).toEqual({ arm: 4, keep: 4 });
		expect(nextMachine([{ ...m6, busy: 3 }, m4])).toBe("m4");
	});

	it("arms every free slot of a lone machine, or in spread mode", () => {
		expect(targets([m4])).toEqual({ m4: { arm: 4, keep: 4 } });
		expect(targets([{ ...m6, accepting: false }, m4]).m4).toEqual({
			arm: 4,
			keep: 4,
		});
		expect(Object.fromEntries(placeWaitingRunners([m6, m4], "spread"))).toEqual(
			{ m6: { arm: 3, keep: 3 }, m4: { arm: 4, keep: 4 } },
		);
	});

	it("keeps two runners waiting for bursts", () => {
		const big = { ...m6, speed: { single: 3000, multi: 6000 }, maxRunners: 1 };
		// Only one slot is close to the best: one more waits on the next best.
		expect(targets([big, m4])).toEqual({
			m6: { arm: 1, keep: 1 },
			m4: { arm: 1, keep: 0 + 1 },
		});
	});

	it("arms up to the target and releases the slower waiting runners", () => {
		const waitingSlots = [slot(1), slot(2, { since: nowSeconds - 120 })];
		const plan = planNode({
			now: NOW,
			node: plannerNode({ maxRunners: 4, waiting: { arm: 1, keep: 1 } }),
			slots: waitingSlots,
			runners: [ghRunner(1), ghRunner(2)],
		});
		// Two wait, one is enough: the one waiting longest leaves, none is armed.
		expect(plan.actions).toEqual([
			{
				type: "release",
				slot: 2,
				runnerId: 102,
				reason: "a faster machine has room",
			},
		]);
		const busy = planNode({
			now: NOW,
			node: plannerNode({ maxRunners: 4, waiting: { arm: 2, keep: 2 } }),
			slots: [slot(1, { job: runningJob }), slot(2)],
			runners: [ghRunner(1, { busy: true }), ghRunner(2)],
		});
		// A busy slot never counts as waiting: one more runner is armed.
		expect(busy.actions).toEqual([{ type: "arm", slot: 3 }]);
		const fresh = planNode({
			now: NOW,
			node: plannerNode({ maxRunners: 4, waiting: { arm: 0, keep: 0 } }),
			slots: [slot(1, { since: nowSeconds - 10 })],
			runners: [ghRunner(1)],
		});
		// Released only after waiting a minute.
		expect(fresh.actions).toEqual([]);
	});

	it("reads the benchmark", () => {
		expect(parseBenchmark("bench cpus=7 single=1302 multi=8890\n")).toEqual({
			cpus: 7,
			single: 1302,
			multi: 8890,
		});
		expect(parseBenchmark("Failed to start transient service")).toBeNull();
	});
});

describe("machine enrollment", () => {
	const code = (data: Record<string, unknown>) =>
		`${SETUP_CODE_PREFIX}${Buffer.from(JSON.stringify(data)).toString("base64")}`;
	const valid = {
		v: 1,
		machine: "m6",
		platform: "macos",
		user: "dokploy-manager",
		port: 22,
		key: publicKeyFingerprint(machineKey.publicKey),
		hostKeys: [
			publicKeyFingerprint(utils.generateKeyPairSync("ed25519").public),
		],
		hosts: ["100.115.98.81", "m6.local"],
		os: "macOS 26.1",
		arch: "arm64",
		fileVault: "on",
		keepAwake: true,
	};

	it("gives every machine its own ed25519 key", () => {
		const other = generateMachineKey("m4");
		expect(machineKey.publicKey).toMatch(/^ssh-ed25519 \S+ dokploy-runner@m6$/);
		expect(machineKey.privateKey).toContain("OPENSSH PRIVATE KEY");
		expect(other.publicKey).not.toBe(machineKey.publicKey);
	});

	it("fingerprints a key like ssh-keygen", () => {
		const dir = mkdtempSync(join(tmpdir(), "dokploy-runner-key-"));
		try {
			const file = join(dir, "key.pub");
			writeFileSync(file, `${machineKey.publicKey}\n`);
			const printed = execFileSync("ssh-keygen", ["-lf", file]).toString();
			expect(printed.split(" ")[1]).toBe(
				publicKeyFingerprint(machineKey.publicKey),
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("only writes scripts for a valid machine and key", () => {
		const input = {
			platform: "macos" as const,
			machine: "m6",
			publicKey: machineKey.publicKey,
			keepAwake: true,
		};
		expect(() =>
			machineSetupScript({ ...input, machine: "m6; reboot" }),
		).toThrow(/Invalid machine name/);
		expect(() =>
			machineSetupScript({
				...input,
				publicKey: `${machineKey.publicKey}\ncommand="sh" ssh-ed25519 AAAA`,
			}),
		).toThrow(/ed25519/);
		const script = machineSetupScript(input);
		expect(script).toContain(`PUBLIC_KEY='${machineKey.publicKey}'`);
		expect(script).toContain("Match User dokploy-manager");
		expect(script).toContain("Match all");
		expect(script).toContain("pmset -a");
		expect(machineSetupScript({ ...input, keepAwake: false })).toContain(
			"KEEP_AWAKE=0",
		);
	});

	it("takes --uninstall and nothing else, as root only", () => {
		const dir = mkdtempSync(join(tmpdir(), "dokploy-runner-setup-"));
		try {
			for (const platform of ["macos", "linux"] as const) {
				const file = join(dir, `${platform}.sh`);
				writeFileSync(
					file,
					machineSetupScript({
						platform,
						machine: "m6",
						publicKey: machineKey.publicKey,
						keepAwake: true,
					}),
				);
				const run = (...args: string[]) => {
					try {
						execFileSync("bash", [file, ...args], { stdio: "pipe" });
						return { status: 0, stderr: "" };
					} catch (error) {
						const failed = error as { status: number; stderr: Buffer };
						return {
							status: failed.status,
							stderr: failed.stderr.toString(),
						};
					}
				};
				expect(run("--purge")).toMatchObject({ status: 2 });
				// Tests do not run as root: both modes stop before changing anything.
				expect(run("--uninstall").stderr).toMatch(/run it with sudo/);
				expect(run().stderr).toMatch(/run it with sudo/);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("never logs in as the account the jobs run as", () => {
		const script = machineSetupScript({
			platform: "linux",
			machine: "vm-1",
			publicKey: machineKey.publicKey,
			keepAwake: false,
		});
		// The runtime runs jobs as dokploy-runner: the login account has root.
		expect(installRuntimeScript()).toContain("RUNNER_USER=dokploy-runner");
		expect(script).toContain("MANAGER_USER=dokploy-manager");
		expect(script).not.toMatch(/dokploy-runner( |$)/m);
	});

	it("creates the Mac account without any password", () => {
		const script = machineSetupScript({
			platform: "macos",
			machine: "m6",
			publicKey: machineKey.publicKey,
			keepAwake: true,
		});
		// Nothing secret on a command line (ps), nothing for su or the login window.
		expect(script).not.toMatch(/-password|openssl rand/);
		expect(script).toContain(`dscl . -create "$record" Password '*'`);
		const line = script
			.split("\n")
			.map((text) => text.trim())
			.find((text) => text.startsWith("uid=$("));
		expect(line).toBeDefined();
		const uid = (users: string) =>
			execFileSync("bash", [
				"-c",
				`set -euo pipefail\ndscl() { printf '${users}'; }\n${line}\necho "$uid"`,
			])
				.toString()
				.trim();
		expect(uid("root 0\\nnobody -2\\n_www 70\\nkillian 501\\nci 503\\n")).toBe(
			"504",
		);
		expect(uid("root 0\\nnobody -2\\n")).toBe("501");
	});

	it("only sends stored secrets to the target they were saved for", () => {
		const stored = {
			apiUrl: "https://ghe.example.com/api/v3",
			scope: "repository",
			owner: "Flots-app",
			repository: "monorepo",
		} as GithubRunnerPool;
		const input = {
			authType: "token" as const,
			apiUrl: stored.apiUrl,
			scope: "repository" as const,
			owner: "Flots-app",
			repository: "monorepo",
			token: null,
			appPrivateKey: null,
		};
		// The pool's own target keeps its stored secret.
		expect(() => assertSecretsDestination(input, stored)).not.toThrow();
		for (const change of [
			{ apiUrl: "https://attacker.example" },
			{ owner: "another-org" },
			{ repository: "another-repo" },
			{ scope: "organization" as const, repository: null },
		]) {
			expect(() =>
				assertSecretsDestination({ ...input, ...change }, stored),
			).toThrow(/Paste the token again/);
		}
		expect(() =>
			assertSecretsDestination(
				{ ...input, authType: "app", owner: "another-org" },
				stored,
			),
		).toThrow(/App private key/);
		// A pasted secret may go anywhere.
		expect(() =>
			assertSecretsDestination(
				{ ...input, owner: "another-org", token: "ghp_new" },
				stored,
			),
		).not.toThrow();
		expect(() =>
			assertSecretsDestination(
				{ ...input, authType: "provider", apiUrl: stored.apiUrl },
				null,
			),
		).toThrow(/only works with https:\/\/api.github.com/);
		expect(() =>
			assertSecretsDestination(
				{ ...input, authType: "provider", apiUrl: "https://api.github.com" },
				null,
			),
		).not.toThrow();
	});

	it("never sends database errors to the browser", () => {
		const secret = "enc:v1:KytiasAODYHIJSC8Fv";
		const conflict = toClientError(
			new DrizzleQueryError(
				'update "github_runner_pool" set "name" = $1',
				["pool-1", secret],
				Object.assign(new Error("duplicate key"), { code: "23505" }),
			),
		);
		expect(conflict.code).toBe("CONFLICT");
		expect(conflict.message).not.toContain(secret);
		const other = toClientError(
			new DrizzleQueryError("insert", [secret], new Error("boom")),
		);
		expect(other.code).toBe("INTERNAL_SERVER_ERROR");
		expect(other.message).not.toMatch(/insert|enc:v1/);
		// Messages written for the operator go through.
		expect(toClientError(new Error("Pool Lab has no token")).message).toBe(
			"Pool Lab has no token",
		);
	});

	it("creates the account and prints the code even when a fact is missing", () => {
		const script = machineSetupScript({
			platform: "linux",
			machine: "vm-1",
			publicKey: machineKey.publicKey,
			keepAwake: false,
		});
		const facts = script
			.split("\n")
			.filter((line) => /^(os|candidates)=/.test(line))
			.join("\n");
		expect(facts).toContain("candidates=");
		// No route to 1.1.1.1 (or no iproute2) and no hostname: still a code.
		const output = execFileSync("bash", [
			"-c",
			`set -euo pipefail
ip() { return 2; }
hostname() { return 1; }
tailscale=""
${facts}
echo "os=$os"`,
		]).toString();
		expect(output.trim()).toMatch(/^os=\S/);
	});

	it("reads the code the script prints", () => {
		const parsed = parseSetupCode(
			`  ${code(valid).replace(/(.{40})/g, "$1\n")}  `,
		);
		expect(parsed).toMatchObject({ machine: "m6", user: "dokploy-manager" });
		expect(readSetupCode(code(valid))).toEqual({
			hosts: ["100.115.98.81", "m6.local"],
			port: 22,
		});
	});

	it("refuses a code that is cut, foreign or changed", () => {
		expect(() => parseSetupCode(valid.key)).toThrow(/starting with/);
		expect(() => parseSetupCode(`${SETUP_CODE_PREFIX}eyJ2Ijox`)).toThrow(
			/incomplete/,
		);
		for (const change of [
			{ user: "root" },
			{ hostKeys: [] },
			{ hosts: ["m6.local; rm -rf /"] },
			{ v: 2 },
		]) {
			expect(() => parseSetupCode(code({ ...valid, ...change }))).toThrow(
				/does not come from a Dokploy setup script/,
			);
		}
		expect(readSetupCode("garbage")).toBeNull();
		expect(
			readSetupCode(
				code({ ...valid, port: "22; id", hosts: ["ok.local", "<b>x</b>"] }),
			),
		).toEqual({ hosts: ["ok.local"], port: 22 });
	});
});

describe("managed Lima", () => {
	const release = (assets: { name: string; digest?: string }[]) =>
		json(200, {
			tag_name: `v${LIMA_VERSION}`,
			assets: assets.map((asset) => ({
				...asset,
				browser_download_url: `https://example.test/${asset.name}`,
			})),
		});
	const digest = `sha256:${"b".repeat(64)}`;

	it("pins the archive of the Mac's architecture by its digest", async () => {
		const fetch = vi.fn(async () =>
			release([
				{ name: `lima-${LIMA_VERSION}-Darwin-x86_64.tar.gz`, digest },
				{ name: `lima-${LIMA_VERSION}-Darwin-arm64.tar.gz`, digest },
				{ name: `lima-${LIMA_VERSION}-Linux-aarch64.tar.gz`, digest },
			]),
		);
		await expect(
			resolveLimaRelease(LIMA_VERSION, "arm64", { fetch }),
		).resolves.toEqual({
			version: LIMA_VERSION,
			url: `https://example.test/lima-${LIMA_VERSION}-Darwin-arm64.tar.gz`,
			sha256: "b".repeat(64),
		});
	});

	it("refuses an archive GitHub publishes no digest for", async () => {
		const fetch = vi.fn(async () =>
			release([{ name: `lima-${LIMA_VERSION}-Darwin-arm64.tar.gz` }]),
		);
		await expect(
			resolveLimaRelease(LIMA_VERSION, "arm64", { fetch }),
		).rejects.toThrow(/no verified Darwin-arm64 archive/);
	});

	it("only installs a checked release", () => {
		const valid = {
			version: LIMA_VERSION,
			url: "https://example.test/lima.tar.gz",
			sha256: "c".repeat(64),
		};
		expect(macInstallLimaScript(valid)).toContain(
			`echo '${"c".repeat(64)}  '"$tmp/lima.tar.gz" | shasum -a 256 -c --status -`,
		);
		for (const change of [
			{ version: "2.2.1; reboot" },
			{ url: "http://example.test/lima.tar.gz" },
			{ url: "https://example.test/$(id).tar.gz" },
			{ sha256: "c".repeat(63) },
		]) {
			expect(() => macInstallLimaScript({ ...valid, ...change })).toThrow(
				/Invalid Lima release/,
			);
		}
	});

	it("starts the VM at boot only while the machine is enabled", () => {
		const home = mkdtempSync(join(tmpdir(), "dokploy-runner-home-"));
		try {
			execFileSync("bash", ["-c", macWriteBootScript("dokploy-runners")], {
				env: { ...process.env, HOME: home },
			});
			const boot = join(home, ".dokploy/bin/boot.sh");
			expect(readFileSync(boot, "utf8")).toContain("limactl start");
			expect(() => execFileSync("bash", ["-n", boot])).not.toThrow();
			// Disabled: exits before touching Lima, which is not installed here.
			execFileSync("bash", [boot], { env: { ...process.env, HOME: home } });
			expect(existsSync(join(home, ".dokploy/enabled"))).toBe(false);
			expect(macStartVmScript("dokploy-runners")).toContain(
				'touch "$HOME/.dokploy/enabled"',
			);
			expect(macStopVmScript("dokploy-runners")).toContain(
				'rm -f "$HOME/.dokploy/enabled"',
			);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("review fixes", () => {
	it("lets a number field be typed digit by digit", () => {
		// Typing 100 in a field whose minimum is 20.
		expect(boundedNumber("1", 20)).toBeNull();
		expect(boundedNumber("10", 20)).toBeNull();
		expect(boundedNumber("100", 20)).toBe(100);
		expect(boundedNumber("", 1)).toBeNull();
		expect(boundedNumber("33", 1, 32)).toBeNull();
		expect(boundedNumber("1.5", 1)).toBeNull();
		// Leaving the field clamps it, or keeps the last value when empty.
		expect(settleNumber("10", 20, undefined, 60)).toBe(20);
		expect(settleNumber("99999", 1, 65535, 22)).toBe(65535);
		expect(settleNumber("", 1, undefined, 45)).toBe(45);
	});

	it("only gives up on GitHub errors that will not heal", () => {
		const error = (status: number | null, message = "failed") =>
			new GithubRunnerApiError(message, status);
		expect(isPermanentGithubError(error(null, "unreachable: timeout"))).toBe(
			false,
		);
		expect(isPermanentGithubError(error(502))).toBe(false);
		expect(isPermanentGithubError(error(429))).toBe(false);
		expect(
			isPermanentGithubError(
				error(403, "You have exceeded a secondary rate limit"),
			),
		).toBe(false);
		expect(isPermanentGithubError(error(403, "API rate limit exceeded"))).toBe(
			false,
		);
		expect(
			isPermanentGithubError(error(403, "Resource not accessible by token")),
		).toBe(true);
		expect(isPermanentGithubError(error(404))).toBe(true);
		expect(isPermanentGithubError(error(422))).toBe(true);
		expect(isPermanentGithubError(new Error("socket hang up"))).toBe(false);
	});

	it("installs a release older than the ones it keeps", () => {
		const runnerctl = extractRuntimeFile(
			installRuntimeScript(),
			"/opt/dokploy-runners/bin/runnerctl",
		);
		const lines = runnerctl.split("\n");
		const start = lines.findIndex((line) =>
			line.includes("| while read -r old; do"),
		);
		const end = lines.findIndex(
			(line, index) => index > start && line.trim() === "done",
		);
		const body = lines.slice(start + 1, end).join("\n");
		expect(body).toContain('rm -rf "$old"');
		const dir = mkdtempSync(join(tmpdir(), "dokploy-releases-"));
		try {
			// The target is the oldest of the listed releases: the loop's last item.
			const output = execFileSync("bash", [
				"-c",
				`set -euo pipefail
cd "${dir}" && mkdir r2 r1
target=r1
printf '%s\\n' r2 r1 | while read -r old; do
${body}
done
echo "release installed"
ls`,
			]).toString();
			expect(output).toBe("release installed\nr1\n");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

/** A shell function of a script, from its name to its closing brace. */
const shellFunction = (script: string, name: string) => {
	const start = script.indexOf(`\n${name}() {`);
	return script.slice(start + 1, script.indexOf("\n}\n", start) + 3);
};

const runnerctlScript = () =>
	extractRuntimeFile(
		installRuntimeScript(),
		"/opt/dokploy-runners/bin/runnerctl",
	);

/** Runs bash and returns its status and output, failing or not. */
const bash = (script: string) => {
	const result = spawnSync("bash", ["-c", script]);
	return {
		status: result.status,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
};

/** runnerctl needs bash 4.4 (mapfile -d) and GNU find and stat, as on the machines. */
const linuxShell = (() => {
	try {
		const version = execFileSync("bash", [
			"-c",
			"echo $BASH_VERSION",
		]).toString();
		return (
			/^(4\.[4-9]|[5-9])/.test(version) &&
			execFileSync("find", ["--version"]).toString().includes("GNU")
		);
	} catch {
		return false;
	}
})();

/** Records the updates the controller sends to the (mocked) database. */
const recordUpdates = (returning: unknown[]) => {
	const calls: { values: Record<string, unknown>; where: unknown }[] = [];
	const original = vi.mocked(db.update).getMockImplementation();
	vi.mocked(db.update).mockImplementation(() => {
		const call: { values: Record<string, unknown>; where: unknown } = {
			values: {},
			where: undefined,
		};
		const query = {
			set: (values: Record<string, unknown>) => {
				call.values = values;
				return query;
			},
			where: (where: unknown) => {
				call.where = where;
				calls.push(call);
				return query;
			},
			returning: async () => returning,
			// biome-ignore lint/suspicious/noThenProperty: drizzle queries are awaited as they are.
			then: (resolve: (value: unknown) => void) => resolve([]),
		};
		return query as never;
	});
	return {
		calls,
		restore: () => vi.mocked(db.update).mockImplementation(original as never),
	};
};

const renderSql = (where: unknown) => new PgDialect().sqlToQuery(where as SQL);

describe("second review fixes", () => {
	it("never takes a job's directory name for a cleanup record", () => {
		const runnerctl = runnerctlScript();
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "dokploy-gc-")));
		try {
			const cache = join(dir, "tool-cache");
			const home = join(dir, "home");
			const victim = join(dir, "victim");
			for (const path of [
				join(cache, "node/18"),
				join(home, ".cache/pip"),
				join(victim, "data"),
			]) {
				mkdirSync(path, { recursive: true });
			}
			symlinkSync(dir, join(cache, "link"));
			const forged = "x\n0\ttool_cache\t\t/etc";
			const result = bash(
				`set -euo pipefail
GC_TOOL_CACHE=${shellQuote(cache)}
GC_HOME=${shellQuote(home)}
${shellFunction(runnerctl, "gc_parse")}
${shellFunction(runnerctl, "gc_cache_entry")}
check() { if gc_cache_entry "$1"; then echo "yes $2"; else echo "no $2"; fi; }
check ${shellQuote(join(cache, "node/18"))} tool
check ${shellQuote(join(home, ".cache/pip"))} home
check ${shellQuote(join(cache, "node/18/../../../victim"))} dotdot
check ${shellQuote(join(cache, "link/victim"))} symlink
check ${shellQuote(victim)} outside
check ${shellQuote(join(cache, "node/18/deeper"))} deeper
last="" kind="" tags="" entry=""
gc_parse ${shellQuote(`1700000000\ttool_cache\t\t${cache}/node/${forged}`)}
printf 'last=%s kind=%s entry=%s\\n' "$last" "$kind" "\${entry#${cache}/node/}" | tr '\\n\\t' '|>'
echo
gc_parse 'entries[$(touch ${dir}/injected)]\thome\t\t${home}/.cache/pip'
(( last < 1 )) && echo "last=$last"`,
			);
			expect(result.stderr).toBe("");
			expect(result.stdout.split("\n")).toEqual([
				"yes tool",
				"yes home",
				"no dotdot",
				"no symlink",
				"no outside",
				"no deeper",
				// One record per NUL: the newline stays in the path it belongs to.
				"last=1700000000 kind=tool_cache entry=x|0>tool_cache>>/etc|",
				"last=0",
				"",
			]);
			expect(existsSync(join(dir, "injected"))).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it.skipIf(!linuxShell)(
		"cleans the caches without following what jobs named or linked",
		() => {
			const dir = realpathSync(mkdtempSync(join(tmpdir(), "dokploy-gc-")));
			try {
				const root = join(dir, "root");
				const state = join(dir, "state");
				const victim = join(dir, "victim");
				const forged = `x\n0\ttool_cache\t\t${victim}`;
				for (const path of [
					join(root, "tool-cache/node/18"),
					join(root, "tool-cache/node", forged),
					join(state, "home/.cache/pip"),
					join(victim, "data"),
				]) {
					mkdirSync(path, { recursive: true });
				}
				symlinkSync(dir, join(root, "tool-cache/link"));
				const runnerctl = runnerctlScript()
					.replace("ROOT=/opt/dokploy-runners", `ROOT=${shellQuote(root)}`)
					.replace(
						"STATE=/var/lib/dokploy-runners",
						`STATE=${shellQuote(state)}`,
					);
				const functions = runnerctl.slice(
					0,
					runnerctl.indexOf('\ncase "${1:-}" in'),
				);
				const result = bash(`${functions}
gc_docker() { return 1; }
GC_FREE=$(kib_free)
GC_TARGET=$((GC_FREE * 2))
mapfile -d '' -t entries < <(gc_candidates | sort -z -t $'\\t' -n -k1,1)
echo "entries=\${#entries[@]}"
for record in "\${entries[@]}"; do
	gc_parse "$record"
	gc_remove "$kind" "$entry" "$tags"
done`);
				expect(result.stderr).toBe("");
				expect(result.stdout).toContain("entries=3");
				expect(existsSync(join(victim, "data"))).toBe(true);
				expect(existsSync(join(root, "tool-cache/node/18"))).toBe(false);
				expect(existsSync(join(root, "tool-cache/node", forged))).toBe(false);
				expect(existsSync(join(state, "home/.cache/pip"))).toBe(false);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);

	it("never reports a runner stopped when systemctl failed", () => {
		const runnerctl = runnerctlScript();
		const prelude = [
			'die() { echo "runnerctl: $*" >&2; exit 1; }',
			shellFunction(runnerctl, "slot_arg"),
			shellFunction(runnerctl, "unit_of"),
			shellFunction(runnerctl, "slot_state"),
			shellFunction(runnerctl, "cmd_stop"),
			shellFunction(runnerctl, "cmd_stop_all"),
		].join("\n");
		const systemctl = (stop: number) =>
			`systemctl() { case "$1" in stop) return ${stop} ;; show) echo deactivating ;; esac; }`;
		const failed = bash(
			`set -euo pipefail\n${prelude}\n${systemctl(1)}\ncmd_stop 3`,
		);
		expect(failed.status).toBe(1);
		expect(failed.stdout).not.toContain("stopped");
		expect(failed.stderr).toContain(
			"slot 3 did not stop (state: deactivating)",
		);
		const all = bash(
			`set -euo pipefail\n${prelude}\n${systemctl(1)}\ncmd_stop_all || echo "status=$?"`,
		);
		expect(all.stdout).toBe("status=1\n");
		expect(all.stderr).toContain("did not stop");
		const stopped = bash(
			`set -euo pipefail\n${prelude}\n${systemctl(0)}\ncmd_stop 3`,
		);
		expect(stopped.stdout).toBe("stopped slot=3\n");
	});

	it("leaves nothing behind when the runtime or the VM goes", () => {
		const uninstall = shellFunction(runnerctlScript(), "cmd_uninstall");
		expect(uninstall).toContain(
			"/etc/systemd/system/fstrim.timer.d/dokploy-runners.conf",
		);
		expect(uninstall).toContain("cmd_stop_all >/dev/null ||");
		// The boot daemon starts the VM while the flag exists: deleting the VM removes it.
		const home = realpathSync(
			mkdtempSync(join(tmpdir(), "dokploy-runner-home-")),
		);
		try {
			mkdirSync(join(home, ".dokploy/lima/bin"), { recursive: true });
			writeFileSync(join(home, ".dokploy/enabled"), "");
			const limactl = join(home, ".dokploy/lima/bin/limactl");
			writeFileSync(limactl, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
			execFileSync("bash", ["-c", macDeleteVmScript("dokploy-runners")], {
				env: { ...process.env, HOME: home },
			});
			expect(existsSync(join(home, ".dokploy/enabled"))).toBe(false);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("only takes KEY=VALUE lines from the pool environment", () => {
		const env = "DEBUG\nA=1\n# note\n=x\nB=two=parts";
		expect(envKeys(env)).toEqual(["A", "B"]);
		expect(parseEnvLines(env)).toEqual([
			null,
			{ key: "A", value: "1" },
			null,
			{ key: "B", value: "two=parts" },
		]);
		const file = runnerEnvironment({
			runnerEnv: env,
			jobStartedHook: null,
			jobCompletedHook: null,
		});
		expect(file).not.toMatch(/DEBU/);
		expect(file).toContain('A="1"\nB="two=parts"\n');
	});

	it("bounds what a pool stores", () => {
		const pool = {
			name: "Lab",
			scope: "organization",
			owner: "Flots-app",
			authType: "token",
			token: "ghp_x",
		};
		expect(apiCreateGithubRunnerPool.safeParse(pool).success).toBe(true);
		for (const change of [
			{ token: "x".repeat(1_001) },
			{ authType: "app", appId: 1, appPrivateKey: "k".repeat(16_001) },
			{ runnerEnv: `A=${"x".repeat(32_768)}` },
			{ runnerEnv: "DEBUG" },
			{ jobStartedHook: `/${"a".repeat(1_024)}` },
		]) {
			expect(
				apiCreateGithubRunnerPool.safeParse({ ...pool, ...change }).success,
				Object.keys(change).join(),
			).toBe(false);
		}
	});

	it("names machines the same way in the form, the API and the script", () => {
		const enrollment = (name: string) =>
			apiStartGithubRunnerEnrollment.safeParse({
				githubRunnerPoolId: "pool",
				name,
				platform: "linux",
			}).success;
		const script = (machine: string) => () =>
			machineSetupScript({
				platform: "linux",
				machine,
				publicKey: machineKey.publicKey,
				keepAwake: false,
			});
		for (const name of ["m6", "a".repeat(24)]) {
			expect(MACHINE_NAME.test(name)).toBe(true);
			expect(enrollment(name)).toBe(true);
			expect(script(name)).not.toThrow();
		}
		for (const name of ["a".repeat(25), "-m6", "M6"]) {
			expect(MACHINE_NAME.test(name)).toBe(false);
			expect(enrollment(name)).toBe(false);
			expect(script(name)).toThrow(/Invalid machine name/);
		}
	});

	describe("drain completion", () => {
		const drain: GithubRunnerDrain = {
			mode: "wait",
			reason: "disable",
			requestedAt: "2026-10-22T08:00:00.000Z",
			deadline: null,
			operationId: "op-drain",
		};
		const node = (overrides: Record<string, unknown> = {}) =>
			({
				githubRunnerNodeId: "node-c6",
				name: "m6",
				platform: "macos",
				vmName: "dokploy-runners",
				enabled: false,
				phase: "draining",
				applied: null,
				drain,
				pool: { authType: "token", token: null, name: "Lab" },
				...overrides,
			}) as never;
		const driver = () => {
			const host = vi.fn(async (_script: string) => ({
				stdout: "",
				stderr: "",
				exitCode: 0,
			}));
			const guest = vi.fn(async (_command: string) => ({
				stdout: "",
				stderr: "",
				exitCode: 0,
			}));
			return { host, guest, driver: { host, guest } as never };
		};

		it("keeps an operator's re-enable made while the VM stopped", async () => {
			const { calls, restore } = recordUpdates([]);
			const { host, driver: fake } = driver();
			vi.mocked(db.query.githubRunnerNodes.findFirst).mockResolvedValueOnce(
				node({ enabled: true, phase: "ready", drain: null }),
			);
			try {
				await completeDrain({ node: node(), driver: fake } as never);
			} finally {
				restore();
			}
			const ended = calls.find((call) => call.values.phase === "stopped");
			expect(ended?.values).toEqual({ phase: "stopped", drain: null });
			const query = renderSql(ended?.where);
			expect(query.sql).toContain(`"phase" = $`);
			expect(query.sql).toContain(`->>'requestedAt' = $`);
			expect(query.sql).toContain(`->>'operationId' IS NOT DISTINCT FROM $`);
			expect(query.params).toEqual(
				expect.arrayContaining([
					"node-c6",
					"draining",
					drain.requestedAt,
					"op-drain",
				]),
			);
			// Nothing matched: no "done", and the VM it stopped runs again.
			expect(calls.some((call) => call.values.status === "done")).toBe(false);
			expect(
				host.mock.calls.map(
					([script]) => /limactl (stop|start)/.exec(script)?.[0],
				),
			).toEqual(["limactl stop", "limactl start"]);
		});

		it("disables the machine when the drain is still the current one", async () => {
			const { calls, restore } = recordUpdates([{ id: "node-c6" }]);
			const { host, driver: fake } = driver();
			try {
				await completeDrain({ node: node(), driver: fake } as never);
			} finally {
				restore();
			}
			expect(calls.some((call) => call.values.status === "done")).toBe(true);
			expect(host).toHaveBeenCalledTimes(1);
		});

		it("does not delete a machine whose removal was cancelled", async () => {
			const { calls, restore } = recordUpdates([]);
			const deletes = vi.mocked(db.delete).getMockImplementation();
			vi.mocked(db.delete).mockImplementation(
				() =>
					({
						where: () => ({ returning: async () => [] }),
					}) as never,
			);
			const { guest, driver: fake } = driver();
			try {
				await completeDrain({
					node: node({
						platform: "linux",
						drain: { ...drain, reason: "remove", uninstall: true },
					}),
					driver: fake,
				} as never);
			} finally {
				restore();
				vi.mocked(db.delete).mockImplementation(deletes as never);
			}
			expect(guest).toHaveBeenCalledWith(
				"/opt/dokploy-runners/bin/runnerctl uninstall",
				expect.anything(),
			);
			// Its runtime is gone: it is provisioned again before it takes jobs.
			const kept = calls.find((call) => "applied" in call.values);
			expect(kept?.values).toMatchObject({
				applied: null,
				lastError: expect.stringContaining("provision the machine again"),
			});
			expect(calls.some((call) => call.values.status === "done")).toBe(false);
		});
	});

	it("refuses to provision a busy machine before writing anything", async () => {
		const tasks = (
			globalThis as {
				__dokployGithubRunners?: { tasks: Map<string, Promise<void>> };
			}
		).__dokployGithubRunners?.tasks;
		expect(tasks).toBeDefined();
		tasks?.set("node-c7", new Promise(() => undefined));
		vi.mocked(db.query.githubRunnerNodes.findFirst).mockResolvedValueOnce({
			githubRunnerNodeId: "node-c7",
			name: "m4",
			phase: "ready",
		} as never);
		vi.mocked(db.update).mockClear();
		vi.mocked(db.insert).mockClear();
		try {
			await expect(provisionRunnerNode("node-c7", null)).rejects.toThrow(
				"Another task is running on this machine",
			);
		} finally {
			tasks?.delete("node-c7");
		}
		// The machine keeps its phase and the running operation is not cancelled.
		expect(db.update).not.toHaveBeenCalled();
		expect(db.insert).not.toHaveBeenCalled();
	});

	it("tries an unreachable machine less and less often, up to a minute", () => {
		expect([1, 2, 3, 4, 5, 10].map(reconnectDelay)).toEqual([
			10_000, 20_000, 40_000, 60_000, 60_000, 60_000,
		]);
	});

	it("stops a reroute scan GitHub cannot answer, a few repositories at a time", async () => {
		let inFlight = 0;
		let most = 0;
		const listed: string[] = [];
		const client = {
			listRepositories: async () =>
				Array.from({ length: 40 }, (_, index) => `Flots-app/repo-${index}`),
			listQueuedRuns: async (repository: string) => {
				listed.push(repository);
				inFlight++;
				most = Math.max(most, inFlight);
				await new Promise((resolve) => setTimeout(resolve, 10));
				inFlight--;
				throw new GithubRunnerApiError("unreachable: timeout", null);
			},
		};
		const errors = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		try {
			await rerouteQueuedRuns(
				{ githubRunnerPoolId: "pool-p4", name: "Lab", labels: ["ci"] } as never,
				client as never,
			);
			// Four at a time; once three failed, no new repository is started.
			expect(most).toBeLessThanOrEqual(4);
			expect(listed.length).toBeLessThanOrEqual(3 + 4 - 1);
			expect(errors).toHaveBeenCalledTimes(1);
			expect(String(errors.mock.calls[0]?.[0])).toMatch(
				/stopped early.*repo-0: unreachable/,
			);
		} finally {
			errors.mockRestore();
		}
	});

	it("keeps the ETags of what it polls, within a bound", async () => {
		const sent: { url: string; etag: string | null }[] = [];
		const client = createGithubRunnerClient(
			{
				scope: "organization",
				owner: "Flots-app",
				repository: null,
				runnerGroup: "Default",
				apiUrl: "https://api.github.com",
			},
			{ type: "token", token: "t" },
			{
				fetch: async (url, init) => {
					const etag = new Headers(init?.headers).get("if-none-match");
					sent.push({ url: String(url), etag });
					if (etag) return new Response(null, { status: 304 });
					return json(
						200,
						String(url).includes("status=queued")
							? { workflow_runs: [] }
							: { status: "completed", conclusion: "success", run_attempt: 1 },
						{ ETag: `"${sent.length}"` },
					);
				},
			},
		);
		const queued = (index: number) =>
			client.listQueuedRuns(`Flots-app/r${index}`);
		for (let index = 0; index <= 500; index++) await queued(index);
		sent.length = 0;
		await queued(500);
		await queued(0);
		await client.getRun("Flots-app/r1", "77");
		await client.getRun("Flots-app/r1", "77");
		// The newest entry is still known, the oldest went; runs are never kept.
		expect(sent.map((item) => item.etag !== null)).toEqual([
			true,
			false,
			false,
			false,
		]);
	});

	it("pages the jobs of a run through Octokit, with a timeout", async () => {
		const target = {
			scope: "repository" as const,
			owner: "Flots-app",
			repository: "monorepo",
			runnerGroup: "Default",
			apiUrl: "https://api.github.com",
		};
		const urls: string[] = [];
		const jobs = (count: number, start: number) =>
			Array.from({ length: count }, (_, index) => ({
				name: `job-${start + index}`,
				status: "queued",
				conclusion: null,
				runner_name: null,
				labels: ["self-hosted", "ci"],
				created_at: "2026-10-22T08:00:00Z",
			}));
		const client = createGithubRunnerClient(
			target,
			{ type: "token", token: "t" },
			{
				fetch: async (url, init) => {
					urls.push(String(url));
					expect(new Headers(init?.headers).get("authorization")).toBe(
						"Bearer t",
					);
					const base =
						"https://api.github.com/repos/Flots-app/monorepo/actions/runs/9/jobs";
					return String(url).includes("page=2")
						? json(200, { total_count: 130, jobs: jobs(30, 100) })
						: json(
								200,
								{ total_count: 130, jobs: jobs(100, 0) },
								{ link: `<${base}?per_page=100&page=2>; rel="next"` },
							);
				},
			},
		);
		const listed = await client.listRunJobs("Flots-app/monorepo", "9");
		expect(listed).toHaveLength(130);
		expect(listed[129]).toMatchObject({
			name: "job-129",
			labels: ["self-hosted", "ci"],
		});
		expect(urls).toHaveLength(2);
		await expect(client.listRunJobs("someone/else", "9")).rejects.toThrow(
			"outside this pool",
		);
		const slow = createGithubRunnerClient(
			target,
			{ type: "token", token: "t" },
			{
				timeoutMs: 20,
				fetch: (_url, init) =>
					new Promise((_resolve, reject) =>
						init?.signal?.addEventListener("abort", () =>
							reject(init.signal?.reason),
						),
					),
			},
		);
		const timedOut = await slow
			.listRunJobs("Flots-app/monorepo", "9")
			.catch((error: unknown) => error);
		expect(timedOut).toBeInstanceOf(GithubRunnerApiError);
		expect((timedOut as GithubRunnerApiError).status).toBeNull();
		expect(isPermanentGithubError(timedOut)).toBe(false);
	});

	describe("routing variable", () => {
		let answer = 204;
		const fetched: string[] = [];
		const pool = (overrides: Record<string, unknown>) =>
			({
				githubRunnerPoolId: "pool-e1",
				name: "Lab",
				scope: "organization",
				owner: "Flots-app",
				repository: null,
				runnerGroup: "Default",
				apiUrl: "https://api.github.com",
				authType: "token",
				token: "t",
				labels: ["ci"],
				fallbackLabels: ["ubuntu-24.04"],
				routingVariable: null,
				routing: {
					variable: "DOKPLOY_RUNS_ON",
					target: "pool",
					value: '["self-hosted","ci"]',
					since: "2026-10-22T08:00:00.000Z",
					unavailableSince: null,
					syncedValue: '["self-hosted","ci"]',
					syncedAt: "2026-10-22T08:00:00.000Z",
					attemptedAt: "2026-10-22T08:00:00.000Z",
					error: null,
				},
				...overrides,
			}) as never;
		beforeAll(() => {
			vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
				fetched.push(`${init?.method ?? "GET"} ${url}`);
				return init?.method === "DELETE" && answer !== 204
					? json(answer, { message: "Resource not accessible by integration" })
					: json(204, null);
			});
		});
		afterAll(() => vi.unstubAllGlobals());

		it("keeps the routing, with the error, until GitHub deleted the variable", async () => {
			answer = 403;
			const failed = recordUpdates([]);
			try {
				await routePool(pool({}));
			} finally {
				failed.restore();
			}
			expect(fetched).toContain(
				"DELETE https://api.github.com/orgs/Flots-app/actions/variables/DOKPLOY_RUNS_ON",
			);
			expect(failed.calls).toHaveLength(1);
			expect(failed.calls[0]?.values.routing).toMatchObject({
				variable: "DOKPLOY_RUNS_ON",
				error: expect.stringContaining("Cannot delete DOKPLOY_RUNS_ON"),
			});
			answer = 204;
			const deleted = recordUpdates([]);
			try {
				await routePool(pool({}));
			} finally {
				deleted.restore();
			}
			expect(deleted.calls[0]?.values).toEqual({ routing: null });
		});

		it("keeps a renamed variable until the previous one is deleted", async () => {
			answer = 403;
			fetched.length = 0;
			const renamed = recordUpdates([]);
			try {
				await routePool(pool({ routingVariable: "CI_RUNS_ON" }));
			} finally {
				renamed.restore();
			}
			expect(fetched.slice(0, 2)).toEqual([
				"PATCH https://api.github.com/orgs/Flots-app/actions/variables/CI_RUNS_ON",
				"DELETE https://api.github.com/orgs/Flots-app/actions/variables/DOKPLOY_RUNS_ON",
			]);
			expect(renamed.calls[0]?.values.routing).toMatchObject({
				variable: "DOKPLOY_RUNS_ON",
				error: expect.stringContaining("DOKPLOY_RUNS_ON could not be deleted"),
			});
		});

		it("tells the operator when a deleted pool leaves its variable", async () => {
			answer = 500;
			await expect(
				clearPoolRouting(pool({ githubRunnerPoolId: "pool-e1-delete" })),
			).resolves.toMatch(
				/DOKPLOY_RUNS_ON could not be deleted .*delete it on GitHub/,
			);
			answer = 204;
			await expect(
				clearPoolRouting(pool({ githubRunnerPoolId: "pool-e1-delete" })),
			).resolves.toBeNull();
		});
	});

	it("gives the slider thumb its accessible name", () => {
		const markup = renderToStaticMarkup(
			createElement(Slider, {
				"aria-label": "CPU budget",
				value: [50],
				min: 10,
				max: 100,
			}),
		);
		expect(markup).toMatch(
			/<span[^>]*role="slider"[^>]*aria-label="CPU budget"|<span[^>]*aria-label="CPU budget"[^>]*role="slider"/,
		);
	});

	it("shows the validation messages instead of the zod issues", () => {
		const refused = Object.assign(
			new Error(
				'[{"origin":"string","code":"invalid_format","message":"Invalid host"}]',
			),
			{
				data: {
					zodError: {
						formErrors: [],
						fieldErrors: { host: ["Invalid host"], token: ["Too small"] },
					},
				},
			},
		);
		expect(errorText(refused)).toBe("Invalid host · token: Too small");
		expect(errorText(new Error("Pool Lab has no token"))).toBe(
			"Pool Lab has no token",
		);
		expect(errorText(null, "Unable to save")).toBe("Unable to save");
	});
});

describe("runner versions", () => {
	const DAY = 24 * 60 * 60_000;
	const now = Date.parse("2026-10-22T12:00:00Z");
	const ago = (days: number) => new Date(now - days * DAY).toISOString();
	const releases = [
		{ version: "2.331.0", publishedAt: ago(0.5) },
		{ version: "2.330.0", publishedAt: ago(10) },
		{ version: "2.329.0", publishedAt: ago(40) },
	];
	const status = (
		installed: string | null,
		options: Partial<Parameters<typeof runnerVersionStatus>[0]> = {},
	) =>
		runnerVersionStatus({
			installed,
			releases,
			pinned: null,
			updating: true,
			now,
			...options,
		});

	it("compares versions by number", () => {
		expect(compareVersions("2.330.0", "2.329.10")).toBe(1);
		expect(compareVersions("2.329.10", "2.329.9")).toBe(1);
		expect(compareVersions("v2.329.0", "2.329.0")).toBe(0);
		expect(compareVersions("2.328.0", "2.329.0")).toBe(-1);
	});

	it("is current on the latest release", () => {
		expect(status("2.331.0").state).toBe("current");
		expect(status("2.332.0").state).toBe("current");
	});

	it("waits for Dokploy's own update right after a release", () => {
		const result = status("2.330.0");
		expect(result.state).toBe("pending");
		expect(result.latest).toBe("2.331.0");
	});

	it("flags an update Dokploy did not apply a day after the release", () => {
		const result = status("2.330.0", {
			releases: [
				{ version: "2.331.0", publishedAt: ago(2) },
				...releases.slice(1),
			],
		});
		expect(result.state).toBe("outdated");
		expect(result.message).toMatch(/events and its last error/);
	});

	it("counts GitHub's 30 days from the first newer release", () => {
		// 2.329.0 is behind 2.330.0, out 10 days ago: 20 days left.
		const result = status("2.329.0");
		expect(result.deadline).toBe(
			new Date(Date.parse(ago(10)) + RUNNER_UPDATE_DEADLINE_MS).toISOString(),
		);
		expect(result.state).toBe("outdated");
		// 2.328.0 is behind 2.329.0, out 40 days ago: GitHub no longer queues jobs.
		const unsupported = status("2.328.0");
		expect(unsupported.state).toBe("unsupported");
		expect(unsupported.message).toMatch(/no longer queues jobs/);
	});

	it("blames a pinned version and tells how to fix it", () => {
		const result = status("2.330.0", { pinned: "2.330.0" });
		expect(result.state).toBe("outdated");
		expect(result.message).toMatch(/pinned in the pool settings \(2\.330\.0\)/);
	});

	it("waits for a disabled machine to be enabled", () => {
		const result = status("2.330.0", { updating: false });
		expect(result.state).toBe("pending");
		expect(result.message).toMatch(/once the machine is enabled/);
	});

	it("says nothing it does not know", () => {
		expect(status(null).state).toBe("unknown");
		expect(status("2.330.0", { releases: [] }).state).toBe("unknown");
	});

	it("lists published runner releases only", async () => {
		const fetch = vi.fn(
			async (_url: string) =>
				new Response(
					JSON.stringify([
						{
							tag_name: "v2.332.0",
							draft: true,
							prerelease: false,
							published_at: null,
						},
						{
							tag_name: "v2.331.1",
							draft: false,
							prerelease: true,
							published_at: ago(1),
						},
						{
							tag_name: "v2.331.0",
							draft: false,
							prerelease: false,
							published_at: ago(0.5),
						},
					]),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);
		await expect(
			listRunnerReleases({
				fetch: fetch as unknown as typeof globalThis.fetch,
			}),
		).resolves.toEqual([{ version: "2.331.0", publishedAt: ago(0.5) }]);
		expect(String(fetch.mock.calls[0]?.[0])).toContain(
			"/repos/actions/runner/releases?per_page=30",
		);
	});
});
