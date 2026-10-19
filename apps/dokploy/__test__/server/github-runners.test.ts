import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GithubRunnerDrain } from "@dokploy/server/db/schema";
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
	versionAtLeast,
} from "@dokploy/server/utils/github-runners/checks";
import {
	describeCleanup,
	limaLogLine,
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
	createGithubRunnerClient,
	decodeJitConfig,
	type GithubRunner,
	resolveRunnerRelease,
} from "@dokploy/server/utils/github-runners/github-api";
import {
	macCreateVmScript,
	macDeleteVmScript,
	macProbeScript,
	macResizeVmScript,
	macStartVmScript,
	macStopVmScript,
} from "@dokploy/server/utils/github-runners/macos";
import {
	type LocalSlot,
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
	installRuntimeScript,
	linuxFactsScript,
	runnerEnvironment,
	sh,
} from "@dokploy/server/utils/github-runners/runtime";
import {
	fingerprintOf,
	HostKeyMismatchError,
	openNodeSession,
} from "@dokploy/server/utils/github-runners/ssh";
import { Server, utils } from "ssh2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

const json = (status: number, body: unknown) =>
	new Response(status === 204 ? null : JSON.stringify(body), { status });

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
			new Response(
				JSON.stringify({
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
				}),
			);
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
});

const scripts = () => ({
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

	it("requires Lima on a Mac and adopts an existing VM", () => {
		const mac = parseMacStatus(
			[
				"mac cpus=10 memory_bytes=17179869184 arch=arm64 version=26.1 load=1",
				"macdisk total_kib=482797652 free_kib=104857600",
				"network github=200",
				"lima version=",
			].join("\n"),
		);
		expect(
			macChecks(mac, settings).find((item) => item.id === "lima")?.status,
		).toBe("fail");
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

	it("compares versions", () => {
		expect(versionAtLeast("2.2.0", "1.0.0")).toBe(true);
		expect(versionAtLeast("v1.0.0", "1.0.0")).toBe(true);
		expect(versionAtLeast("0.23.2", "1.0.0")).toBe(false);
		expect(versionAtLeast(null, "1.0.0")).toBe(false);
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

	beforeAll(async () => {
		server = new Server({ hostKeys: [hostKey.private] }, (client) => {
			client
				.on("authentication", (context) =>
					context.method === "publickey"
						? context.accept()
						: context.reject(["publickey"]),
				)
				.on("ready", () => {
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
	) => ({ name: "job", status, conclusion, runnerName });

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
