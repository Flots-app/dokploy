/**
 * OS updates of a Linux GitHub runner machine, on a real PostgreSQL: the run
 * drains the machine through the runner controller, installs once it is
 * empty, and gives it back whatever happens. The machine is a fake answering
 * over "SSH" what a machine would print; the runner controller's side is its
 * planner (planNode) and the very function its tick calls (settleOsUpdateDrain),
 * fed with the slots a machine would report. Notifications are captured.
 */
import { db } from "@dokploy/server/db";
import {
	type GithubRunnerDrain,
	githubRunnerNodes,
	type OsUpdateRunProgress,
	osUpdateConfigurations,
	osUpdateRunnerNodes,
	osUpdateRuns,
	sshKeys,
} from "@dokploy/server/db/schema";
import {
	cancelOsUpdateRun,
	listOsUpdateRunnerNodes,
	type OsUpdateAccess,
	requestOsUpdateAssessment,
} from "@dokploy/server/services/os-update";
import {
	disableRunnerNode,
	enableRunnerNode,
} from "@dokploy/server/utils/github-runners/controller";
import type { GithubRunner } from "@dokploy/server/utils/github-runners/github-api";
import type { LocalSlot } from "@dokploy/server/utils/github-runners/probe";
import {
	planNode,
	runnerNamePrefix,
} from "@dokploy/server/utils/github-runners/reconcile";
import { RUNTIME_VERSION } from "@dokploy/server/utils/github-runners/runtime";
import type { NodeSession } from "@dokploy/server/utils/github-runners/ssh";
import type { OsUpdateNotice } from "@dokploy/server/utils/notifications/os-updates";
import {
	planOsUpdateWindows,
	startOsUpdatesController,
	stopOsUpdatesController,
	tickOsUpdates,
} from "@dokploy/server/utils/os-updates/controller";
import {
	DEFAULT_OS_UPDATE_SETTINGS,
	type OsUpdateSettings,
} from "@dokploy/server/utils/os-updates/filters";
import {
	markOsUpdateDrained,
	markOsUpdateInstalling,
	notInstallingOsUpdates,
	releaseOsUpdateDrain,
	settleOsUpdateDrain,
	staleOsUpdateDrains,
	startOsUpdateDrain,
} from "@dokploy/server/utils/os-updates/runner-drain";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	createOrganization,
	insertNode,
	insertPool,
	type Person,
	removeCreatedRows,
} from "./fixtures";

interface Scenario {
	/** What the assessment over SSH prints (before the drain). */
	assess: string;
	/** Records of the prepare step. */
	prepare: string;
	/** Records of the install step. */
	install: string;
}

/**
 * A runner machine as the OS updates controller sees it through SSH, with
 * a job running on it or not. Every script that changes the system (a step
 * started, a reboot) while a job runs is recorded: none may ever be.
 */
class FakeMachine {
	bootId = "boot-1";
	scripts: string[] = [];
	jobRunning = false;
	/** Scripts that would have hit a running job. */
	violations: string[] = [];

	constructor(readonly scenario: Scenario) {}

	session(): NodeSession {
		return {
			fingerprint: "SHA256:pinned",
			close: () => undefined,
			run: async (_command, options = {}) => {
				const script = options.input ?? "";
				this.scripts.push(script);
				return { stdout: this.answer(script), stderr: "", exitCode: 0 };
			},
		};
	}

	sent(fragment: string) {
		return this.scripts.some((script) => script.includes(fragment));
	}

	private answer(script: string) {
		const changes =
			script.includes("systemd-run --unit=") ||
			script.includes("systemd-run --on-active=5");
		if (changes && this.jobRunning) this.violations.push(script);
		if (script.includes("follow size=")) {
			const result = script.includes("/install.log")
				? this.scenario.install
				: this.scenario.prepare;
			return `follow size=0 unit=inactive done=yes\n${result}\n--- log\n`;
		}
		if (script.includes("systemd-run --on-active=5")) {
			this.bootId = "boot-2";
			return "";
		}
		if (script.includes("systemd-run --unit=")) return "started\n";
		if (script.startsWith("cat /proc/sys/kernel/random/boot_id")) {
			return `${this.bootId}\n`;
		}
		if (script.includes("exec 3>&1 >/dev/null 2>&1")) {
			return this.scenario.assess;
		}
		if (script.includes("docker active=$(clean")) {
			return 'docker active=active\nswarm {"LocalNodeState":"inactive"}\n';
		}
		return "";
	}
}

const { fakes, notices } = vi.hoisted(() => ({
	fakes: new Map<number, { session: () => NodeSession }>(),
	notices: [] as { organizationId: string; notice: OsUpdateNotice }[],
}));

vi.mock("@dokploy/server/utils/github-runners/ssh", async (importOriginal) => {
	const original =
		await importOriginal<
			typeof import("@dokploy/server/utils/github-runners/ssh")
		>();
	return {
		...original,
		openNodeSession: async (connection: {
			port: number;
			name: string;
			hostKeyFingerprint: string | null;
		}) => {
			const fake = fakes.get(connection.port);
			if (!fake) throw new Error(`Unable to connect to ${connection.name}`);
			// As the real one: a pinned key that differs is refused.
			if (connection.hostKeyFingerprint !== "SHA256:pinned") {
				throw new Error(`Host key of ${connection.name} not pinned`);
			}
			return fake.session();
		},
	};
});

vi.mock(
	"@dokploy/server/utils/notifications/os-updates",
	async (importOriginal) => {
		const original =
			await importOriginal<
				typeof import("@dokploy/server/utils/notifications/os-updates")
			>();
		return {
			...original,
			sendOsUpdateNotifications: async (
				organizationId: string,
				notice: OsUpdateNotice,
			) => {
				notices.push({ organizationId, notice });
			},
		};
	},
);

const PENDING = `os id=ubuntu like=debian version=24.04 codename=noble kernel=6.8.0-45-generic apt=yes
pretty Ubuntu 24.04.1 LTS
state lists=1794079799 refreshed=yes reboot=no dpkg=ok boot=boot-1
docker active=active pid=812
swarm {"LocalNodeState":"inactive"}
--- simulation
Inst openssl [3.0.13-0ubuntu3.1] (3.0.13-0ubuntu3.4 Ubuntu:24.04/noble-updates, Ubuntu:24.04/noble-security [amd64])
--- simulation status=0
exit code=0`;

const UP_TO_DATE = `os id=ubuntu like=debian version=24.04 codename=noble kernel=6.8.0-45-generic apt=yes
pretty Ubuntu 24.04.1 LTS
state lists=1794079799 refreshed=yes reboot=no dpkg=ok boot=boot-1
docker active=active pid=812
swarm {"LocalNodeState":"inactive"}
--- simulation
--- simulation status=0
exit code=0`;

const installed = (options: { reboot: boolean; exitCode?: number }) =>
	[
		"changed name=openssl from=3.0.13-0ubuntu3.1 to=3.0.13-0ubuntu3.4",
		options.exitCode
			? ""
			: `result status=installed reboot=${options.reboot ? "yes" : "no"} docker-before=812 docker-after=812`,
		`exit code=${options.exitCode ?? 0}`,
	]
		.filter(Boolean)
		.join("\n");

let owner: Person;
let keyId: string;
let pool: Awaited<ReturnType<typeof insertPool>>;
let nextPort = 42_000;

/** A fake Linux runner machine, ready, with its host key pinned. */
const fakeRunner = async (
	name: string,
	scenario: Scenario,
	values: Partial<typeof githubRunnerNodes.$inferInsert> = {},
) => {
	const fake = new FakeMachine(scenario);
	const port = nextPort++;
	fakes.set(port, fake);
	const node = await insertNode(pool, name, {
		port,
		sshKeyId: keyId,
		hostKeyFingerprint: "SHA256:pinned",
		phase: "ready",
		applied: {
			runtimeVersion: RUNTIME_VERSION,
			runnerVersion: "2.330.0",
			cpuPercent: 70,
			memoryPercent: 70,
			vmDiskGb: null,
			cpus: 4,
			memoryBytes: 8 * 1024 ** 3,
			envHash: "test",
		},
		...values,
	});
	return { fake, node };
};

const queueRun = async (
	nodeId: string,
	settings: Partial<OsUpdateSettings> = {},
	values: Partial<typeof osUpdateRuns.$inferInsert> = {},
) => {
	await db
		.insert(osUpdateRunnerNodes)
		.values({ githubRunnerNodeId: nodeId, periodicAssessment: false })
		.onConflictDoNothing();
	const [run] = await db
		.insert(osUpdateRuns)
		.values({
			organizationId: owner.organizationId,
			githubRunnerNodeId: nodeId,
			trigger: "manual",
			deadline: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
			settings: { ...DEFAULT_OS_UPDATE_SETTINGS, ...settings },
			...values,
		})
		.returning();
	if (!run) throw new Error("run not queued");
	return run;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Ticks until the condition holds. */
const settle = async <T>(
	read: () => Promise<T>,
	done: (value: T) => boolean,
	timeoutMs = 20_000,
) => {
	const giveUp = Date.now() + timeoutMs;
	for (;;) {
		await tickOsUpdates();
		const value = await read();
		if (done(value)) return value;
		if (Date.now() > giveUp) throw new Error("the controller did not settle");
		await sleep(100);
	}
};

const runOf = (runId: string) =>
	db.query.osUpdateRuns.findFirst({
		where: eq(osUpdateRuns.osUpdateRunId, runId),
	});

const nodeOf = async (nodeId: string) => {
	const node = await db.query.githubRunnerNodes.findFirst({
		where: eq(githubRunnerNodes.githubRunnerNodeId, nodeId),
	});
	if (!node) throw new Error("machine gone");
	return node;
};

const finished = (runId: string, timeoutMs?: number) =>
	settle(
		() => runOf(runId),
		(run) =>
			["succeeded", "failed", "skipped", "cancelled"].includes(
				run?.status ?? "",
			),
		timeoutMs,
	);

/** Until the run took the machine out of service. */
const drainedBy = (nodeId: string, runId: string) =>
	settle(
		() => nodeOf(nodeId),
		(node) =>
			node.phase === "draining" &&
			(node.drain as GithubRunnerDrain | null)?.osUpdateRunId === runId,
	);

/** A slot whose runner runs a job, as `runnerctl status` reports it. */
const busySlot = (name: string): LocalSlot => ({
	slot: 1,
	active: "active",
	since: Math.floor(Date.now() / 1000) - 600,
	runnerName: `${runnerNamePrefix(name)}1-abc123`,
	job: {
		repository: "example/ci",
		runId: "1",
		runAttempt: "1",
		workflow: "CI",
		job: "build",
		startedAt: new Date(Date.now() - 600_000).toISOString(),
		completedAt: null,
	},
});

const busyRunner = (name: string): GithubRunner => ({
	id: 7,
	name: `${runnerNamePrefix(name)}1-abc123`,
	os: "Linux",
	status: "online",
	busy: true,
	labels: ["self-hosted", "Linux"],
	customLabels: [],
	version: "2.330.0",
});

/**
 * One tick of the runner controller on the machine: its planner on what the
 * machine reports, then the hand-over the tick does (actOnNode).
 */
const runnerTick = async (
	nodeId: string,
	report: { slots: LocalSlot[]; runners: GithubRunner[] },
) => {
	const node = await nodeOf(nodeId);
	const plan = planNode({
		now: Date.now(),
		node: {
			enabled: node.enabled,
			phase: node.phase,
			drain: node.drain,
			maxRunners: 2,
			namePrefix: runnerNamePrefix(node.name),
			labels: ["self-hosted", "Linux"],
			runnerVersion: null,
			admission: { ok: true },
			maxArmsPerTick: 4,
		},
		slots: report.slots,
		runners: report.runners,
	});
	const handed = await settleOsUpdateDrain({
		nodeId,
		drain: node.drain,
		drained: plan.actions.some((action) => action.type === "drained"),
		// Autonomy off: the drain told the machine not to arm itself.
		runtime: { runtimeVersion: RUNTIME_VERSION, autonomySetting: "off" },
		autonomyRuntime: 7,
	});
	return { plan, handed };
};

const accessOf = (runner: boolean): OsUpdateAccess => ({
	organizationId: owner.organizationId,
	serverIds: new Set(),
	runnerNodeIds: new Set(),
	requireRun: async () => undefined,
	requireRunnerUpdate: async () => {
		if (!runner) throw new Error("githubRunner.update needed");
	},
});

/** The member's access, seeing every machine of the organization. */
const ownerAccess = async (runner = true): Promise<OsUpdateAccess> => ({
	...accessOf(runner),
	runnerNodeIds: new Set(
		(
			await db.query.githubRunnerNodes.findMany({
				where: eq(githubRunnerNodes.organizationId, owner.organizationId),
				columns: { githubRunnerNodeId: true },
			})
		).map((row) => row.githubRunnerNodeId),
	),
});

beforeAll(async () => {
	owner = await createOrganization("os-runner");
	pool = await insertPool(owner.organizationId, "os-runner-pool");
	const [key] = await db
		.insert(sshKeys)
		.values({
			name: "fake",
			organizationId: owner.organizationId,
			privateKey: "not-a-key",
			publicKey: "not-a-key",
		})
		.returning();
	if (!key) throw new Error("key not created");
	keyId = key.sshKeyId;
	await startOsUpdatesController();
});

afterAll(async () => {
	await stopOsUpdatesController();
	await removeCreatedRows();
});

describe("the drain of a runner machine", () => {
	it("installs only once its running job ended, and never interrupts it", async () => {
		const { fake, node } = await fakeRunner("drain", {
			assess: PENDING,
			prepare: PENDING,
			install: installed({ reboot: true }),
		});
		fake.jobRunning = true;
		const run = await queueRun(node.githubRunnerNodeId, {
			reboot: "if-required",
		});
		await drainedBy(node.githubRunnerNodeId, run.osUpdateRunId);

		// The runner controller, while the job runs: no new job, the job is
		// left alone, and the machine is not handed over.
		for (let tick = 0; tick < 5; tick++) {
			const { plan, handed } = await runnerTick(node.githubRunnerNodeId, {
				slots: [busySlot(node.name)],
				runners: [busyRunner(node.name)],
			});
			expect(plan.actions.map((action) => action.type)).toEqual([]);
			expect(handed).toBe(false);
			await tickOsUpdates();
			await sleep(100);
		}
		const waiting = await runOf(run.osUpdateRunId);
		expect(waiting?.status).toBe("running");
		expect((waiting?.progress as OsUpdateRunProgress).step).toBe("drain");
		expect(fake.sent("systemd-run --unit=")).toBe(false);
		expect(waiting?.log).toMatch(/takes no new job/);

		// GitHub still sees a busy runner after the slot went: not empty yet.
		expect(
			(
				await runnerTick(node.githubRunnerNodeId, {
					slots: [],
					runners: [busyRunner(node.name)],
				})
			).handed,
		).toBe(false);

		// The job ends: the machine is empty, and handed to the run.
		fake.jobRunning = false;
		const { plan, handed } = await runnerTick(node.githubRunnerNodeId, {
			slots: [],
			runners: [],
		});
		expect(plan.actions).toEqual([{ type: "drained" }]);
		expect(handed).toBe(true);

		const done = await finished(run.osUpdateRunId);
		expect(done).toMatchObject({ status: "succeeded", rebooted: true });
		expect(done?.message).toMatch(/machine rebooted/);
		expect(done?.log).toMatch(/runs no job any more: installing/);
		expect(done?.log).toMatch(/takes jobs again/);
		expect(fake.sent("for name in 'openssl'; do")).toBe(true);
		expect(fake.violations).toEqual([]);
		// Back to work.
		const back = await nodeOf(node.githubRunnerNodeId);
		expect(back.phase).toBe("ready");
		expect(back.drain).toBeNull();
	});

	it("gives the machine back with nothing installed when the job outlasts the window", async () => {
		const { fake, node } = await fakeRunner("outlast", {
			assess: PENDING,
			prepare: PENDING,
			install: installed({ reboot: false }),
		});
		fake.jobRunning = true;
		// The install limit (15 minutes before the end) comes in a few seconds.
		const run = await queueRun(
			node.githubRunnerNodeId,
			{},
			{ deadline: new Date(Date.now() + 15 * 60_000 + 6_000).toISOString() },
		);
		await drainedBy(node.githubRunnerNodeId, run.osUpdateRunId);
		const done = await settle(
			async () => {
				const { plan } = await runnerTick(node.githubRunnerNodeId, {
					slots: [busySlot(node.name)],
					runners: [busyRunner(node.name)],
				});
				// The job is never stopped, at any tick.
				expect(plan.actions.some((action) => action.type === "stop")).toBe(
					false,
				);
				return runOf(run.osUpdateRunId);
			},
			(current) => current?.status === "skipped",
		);
		expect(done?.message).toMatch(/Jobs still ran on outlast/);
		expect(fake.sent("systemd-run --unit=")).toBe(false);
		expect(fake.violations).toEqual([]);
		expect((await nodeOf(node.githubRunnerNodeId)).phase).toBe("ready");
	});

	it("gives the machine back when the run is cancelled while the job runs", async () => {
		const { fake, node } = await fakeRunner("cancel", {
			assess: PENDING,
			prepare: PENDING,
			install: installed({ reboot: false }),
		});
		fake.jobRunning = true;
		const run = await queueRun(node.githubRunnerNodeId);
		await drainedBy(node.githubRunnerNodeId, run.osUpdateRunId);
		const { run: cancelled } = await cancelOsUpdateRun(
			run.osUpdateRunId,
			await ownerAccess(),
		);
		expect(cancelled.status).toBe("cancelled");
		expect(cancelled.message).toMatch(/takes jobs again/);
		const back = await settle(
			() => nodeOf(node.githubRunnerNodeId),
			(current) => current.phase === "ready",
		);
		expect(back.drain).toBeNull();
		expect(fake.sent("systemd-run --unit=")).toBe(false);
		// Once handed over and installing, a run can no longer be cancelled.
		expect((await runOf(run.osUpdateRunId))?.status).toBe("cancelled");
	});

	it("gives the machine back when the install fails", async () => {
		const { node } = await fakeRunner("failing", {
			assess: PENDING,
			prepare: PENDING,
			install: installed({ reboot: false, exitCode: 100 }),
		});
		const run = await queueRun(node.githubRunnerNodeId);
		await drainedBy(node.githubRunnerNodeId, run.osUpdateRunId);
		await runnerTick(node.githubRunnerNodeId, { slots: [], runners: [] });
		const done = await finished(run.osUpdateRunId);
		expect(done?.status).toBe("failed");
		expect(done?.message).toMatch(/apt-get upgrade failed \(exit 100\)/);
		const back = await nodeOf(node.githubRunnerNodeId);
		expect(back.phase).toBe("ready");
		expect(back.drain).toBeNull();
		expect(
			notices.some(
				(item) =>
					item.notice.event === "failed" && item.notice.server === "failing",
			),
		).toBe(true);
	});

	it("keeps the machine taking jobs when nothing is to install", async () => {
		const { fake, node } = await fakeRunner("current", {
			assess: UP_TO_DATE,
			prepare: UP_TO_DATE,
			install: installed({ reboot: false }),
		});
		fake.jobRunning = true;
		const done = await finished(
			(await queueRun(node.githubRunnerNodeId)).osUpdateRunId,
		);
		expect(done?.status).toBe("succeeded");
		expect(done?.message).toMatch(/kept taking jobs/);
		expect(fake.violations).toEqual([]);
		const after = await nodeOf(node.githubRunnerNodeId);
		expect(after.phase).toBe("ready");
		expect(after.drain).toBeNull();
	});

	it("never connects to a runner machine without its pinned host key", async () => {
		const { fake, node } = await fakeRunner(
			"unpinned",
			{
				assess: PENDING,
				prepare: PENDING,
				install: installed({ reboot: false }),
			},
			{ hostKeyFingerprint: null },
		);
		const done = await finished(
			(await queueRun(node.githubRunnerNodeId)).osUpdateRunId,
		);
		expect(done?.status).toBe("failed");
		expect(done?.message).toMatch(/no pinned host key/);
		expect(fake.scripts).toEqual([]);
		expect((await nodeOf(node.githubRunnerNodeId)).drain).toBeNull();
	});

	it("skips a machine in error without draining it", async () => {
		const { fake, node } = await fakeRunner(
			"broken",
			{
				assess: PENDING,
				prepare: PENDING,
				install: installed({ reboot: false }),
			},
			{ phase: "error" },
		);
		const done = await finished(
			(await queueRun(node.githubRunnerNodeId)).osUpdateRunId,
		);
		expect(done?.status).toBe("skipped");
		expect(done?.message).toMatch(/not set up, or in error/);
		expect(fake.scripts).toEqual([]);
	});
});

describe("the machine while its run installs", () => {
	it("refuses to be put back to work, disabled, or changed by an operator update", async () => {
		const { node } = await fakeRunner("locked", {
			assess: PENDING,
			prepare: PENDING,
			install: installed({ reboot: false }),
		});
		const runId = "installing-run";
		const nodeId = node.githubRunnerNodeId;
		expect(
			await startOsUpdateDrain({
				nodeId,
				runId,
				abortAt: new Date(Date.now() + 60 * 60_000),
			}),
		).toBe(true);
		expect(await markOsUpdateInstalling(nodeId, runId)).toBe(false);
		expect(await markOsUpdateDrained(nodeId, runId)).toBe(true);
		expect(await markOsUpdateInstalling(nodeId, runId)).toBe(true);

		await expect(enableRunnerNode(nodeId, null)).rejects.toThrow(
			/OS updates are being installed on locked/,
		);
		await expect(
			disableRunnerNode(nodeId, { mode: "kill", timeoutMinutes: null }, null),
		).rejects.toThrow(/OS updates are being installed/);
		// The guard of the operator updates, raced: no row changes.
		const raced = await db
			.update(githubRunnerNodes)
			.set({ drain: null, phase: "ready" })
			.where(
				and(
					eq(githubRunnerNodes.githubRunnerNodeId, nodeId),
					notInstallingOsUpdates(),
				),
			)
			.returning();
		expect(raced).toEqual([]);
		const still = await nodeOf(nodeId);
		expect(still.phase).toBe("draining");
		expect((still.drain as GithubRunnerDrain).installingAt).toBeTruthy();
		// Only its run gives it back.
		expect(await releaseOsUpdateDrain(nodeId, "another-run")).toBe(false);
		expect(await releaseOsUpdateDrain(nodeId, runId)).toBe(true);
		expect((await nodeOf(nodeId)).phase).toBe("ready");
	});

	it("is given back by the runner controller when its run ended without doing it", async () => {
		const { node } = await fakeRunner("orphan", {
			assess: PENDING,
			prepare: PENDING,
			install: installed({ reboot: false }),
		});
		const nodeId = node.githubRunnerNodeId;
		const failed = await queueRun(nodeId, {}, { status: "failed" });
		await startOsUpdateDrain({
			nodeId,
			runId: failed.osUpdateRunId,
			abortAt: new Date(Date.now() + 60 * 60_000),
		});
		const nodes = [await nodeOf(nodeId)];
		expect(
			(await staleOsUpdateDrains(nodes, Date.now())).map(
				(item) => item.githubRunnerNodeId,
			),
		).toEqual([nodeId]);
		// A running run that installs is left alone, even past its limit.
		await releaseOsUpdateDrain(nodeId, failed.osUpdateRunId);
		const running = await queueRun(
			nodeId,
			{},
			{
				status: "running",
				progress: {
					step: "install",
					logOffset: 0,
					allowed: null,
					bootId: null,
					rebootRequestedAt: null,
				},
			},
		);
		await startOsUpdateDrain({
			nodeId,
			runId: running.osUpdateRunId,
			abortAt: new Date(Date.now() - 1_000),
		});
		await markOsUpdateDrained(nodeId, running.osUpdateRunId);
		await markOsUpdateInstalling(nodeId, running.osUpdateRunId);
		expect(
			await staleOsUpdateDrains([await nodeOf(nodeId)], Date.now()),
		).toEqual([]);
		// The same run, not installing yet and past its limit: given back.
		await db
			.update(githubRunnerNodes)
			.set({
				drain: {
					...((await nodeOf(nodeId)).drain as GithubRunnerDrain),
					installingAt: null,
				},
			})
			.where(eq(githubRunnerNodes.githubRunnerNodeId, nodeId));
		expect(
			(await staleOsUpdateDrains([await nodeOf(nodeId)], Date.now())).length,
		).toBe(1);
		await db
			.update(osUpdateRuns)
			.set({ status: "failed" })
			.where(eq(osUpdateRuns.osUpdateRunId, running.osUpdateRunId));
		await releaseOsUpdateDrain(nodeId, running.osUpdateRunId);
	});
});

describe("runner machines in a maintenance configuration", () => {
	it("get a run of their own in an open window", async () => {
		const { node } = await fakeRunner("windowed", {
			assess: UP_TO_DATE,
			prepare: UP_TO_DATE,
			install: installed({ reboot: false }),
		});
		const now = new Date();
		const [configuration] = await db
			.insert(osUpdateConfigurations)
			.values({
				organizationId: owner.organizationId,
				name: "runners-nightly",
				// Every day, open from an hour ago for three hours.
				schedule: {
					recurrence: "daily",
					startTime: `${String((now.getUTCHours() + 23) % 24).padStart(2, "0")}:00`,
					timeZone: "UTC",
					durationMinutes: 240,
					weekdays: [],
					monthlyMode: "day",
					monthDay: 1,
					monthWeek: 1,
					monthWeekday: 0,
				},
				// Disabled: the controller of this file must not run it.
				enabled: false,
			})
			.returning();
		if (!configuration) throw new Error("configuration not created");
		await db.insert(osUpdateRunnerNodes).values({
			githubRunnerNodeId: node.githubRunnerNodeId,
			osUpdateConfigurationId: configuration.osUpdateConfigurationId,
			assignedAt: new Date(now.getTime() - 2 * 60 * 60_000).toISOString(),
		});
		await db
			.update(osUpdateConfigurations)
			.set({ enabled: true })
			.where(
				eq(
					osUpdateConfigurations.osUpdateConfigurationId,
					configuration.osUpdateConfigurationId,
				),
			);
		await planOsUpdateWindows(now);
		const runs = await db.query.osUpdateRuns.findMany({
			where: eq(osUpdateRuns.githubRunnerNodeId, node.githubRunnerNodeId),
		});
		expect(runs).toHaveLength(1);
		expect(runs[0]).toMatchObject({
			trigger: "schedule",
			serverId: null,
			osUpdateConfigurationId: configuration.osUpdateConfigurationId,
		});
		// Planned twice, still one run.
		await planOsUpdateWindows(now);
		expect(
			await db.query.osUpdateRuns.findMany({
				where: eq(osUpdateRuns.githubRunnerNodeId, node.githubRunnerNodeId),
			}),
		).toHaveLength(1);
		await finished(runs[0]?.osUpdateRunId ?? "");
	});

	it("are listed, and changed, only with the runner rights", async () => {
		const { node } = await fakeRunner("listed", {
			assess: UP_TO_DATE,
			prepare: UP_TO_DATE,
			install: installed({ reboot: false }),
		});
		const mac = await insertNode(pool, "listed-mac", {
			platform: "macos",
			phase: "ready",
		});
		expect(
			(await listOsUpdateRunnerNodes(accessOf(true))).map((row) => row.name),
		).toEqual([]);
		const listed = await listOsUpdateRunnerNodes(await ownerAccess());
		expect(listed.map((row) => row.name)).toContain("listed");
		// The VM of a Mac follows its pool's update policy: not listed.
		expect(listed.map((row) => row.name)).not.toContain("listed-mac");
		await expect(
			requestOsUpdateAssessment(
				{ githubRunnerNodeId: node.githubRunnerNodeId },
				await ownerAccess(false),
			),
		).rejects.toThrow(/githubRunner.update needed/);
		await expect(
			requestOsUpdateAssessment(
				{ githubRunnerNodeId: mac.githubRunnerNodeId },
				await ownerAccess(),
			),
		).rejects.toThrow(/Linux runner machines only/);
		await requestOsUpdateAssessment(
			{ githubRunnerNodeId: node.githubRunnerNodeId },
			await ownerAccess(),
		);
		const state = await settle(
			() =>
				db.query.osUpdateRunnerNodes.findFirst({
					where: eq(
						osUpdateRunnerNodes.githubRunnerNodeId,
						node.githubRunnerNodeId,
					),
				}),
			(row) => Boolean(row?.assessedAt),
		);
		expect(state?.assessment?.os.id).toBe("ubuntu");
	});
});
