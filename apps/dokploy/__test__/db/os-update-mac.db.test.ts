/**
 * OS updates of a Mac runner machine, on a real PostgreSQL:
 * - its Linux VM is updated as a Linux runner machine, every root command
 *   going through `limactl shell` on the Mac, and the VM restarted with the
 *   runner controller's stop and start scripts instead of a reboot;
 * - macOS is handed to its owner: Dokploy drains the Mac, waits for another
 *   macOS version, and gives it back. It never installs anything on macOS.
 * The Mac is a fake answering over "SSH"; the runner controller's side is its
 * planner and the hand-over its tick calls, as in os-update-runner.db.test.ts.
 */
import { db } from "@dokploy/server/db";
import {
	type GithubRunnerDrain,
	githubRunnerNodes,
	type OsUpdateRunProgress,
	osUpdateRunnerNodes,
	osUpdateRuns,
	sshKeys,
} from "@dokploy/server/db/schema";
import {
	cancelOsUpdateRun,
	handOffMacos,
	listOsUpdateMacs,
	type OsUpdateAccess,
} from "@dokploy/server/services/os-update";
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
	startOsUpdatesController,
	stopOsUpdatesController,
	tickOsUpdates,
} from "@dokploy/server/utils/os-updates/controller";
import { DEFAULT_OS_UPDATE_SETTINGS } from "@dokploy/server/utils/os-updates/filters";
import {
	settleOsUpdateDrain,
	wakeOsUpdateDrains,
} from "@dokploy/server/utils/os-updates/runner-drain";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	createOrganization,
	insertNode,
	insertPool,
	type Person,
	removeCreatedRows,
} from "./fixtures";

interface Scenario {
	/** What an assessment of the VM prints. */
	assess: string;
	prepare: string;
	install: string;
}

/**
 * A Mac and its Lima VM, as the OS updates controller sees them over SSH:
 * commands for the VM arrive wrapped in `limactl shell`, the others run on
 * macOS as the Mac's account.
 */
class FakeMac {
	macos = { version: "26.0", build: "25A100", extra: "" };
	/** The Mac restarts for its update: macOS does not answer. */
	offline = false;
	vmRunning = true;
	vmBootId = "vm-boot-1";
	jobRunning = false;
	/** Commands run on macOS itself, and scripts run in the VM. */
	hostCommands: string[] = [];
	guestScripts: string[] = [];
	/** Anything that would have hit a running job. */
	violations: string[] = [];

	constructor(readonly scenario: Scenario) {}

	session(): NodeSession {
		return {
			fingerprint: "SHA256:pinned-mac",
			close: () => undefined,
			run: async (command, options = {}) => {
				if (this.offline) throw new Error("the connection is closed");
				if (command.includes("limactl shell")) {
					if (!this.vmRunning)
						throw new Error("VM dokploy-runners is not running");
					const script = options.input ?? "";
					this.guestScripts.push(script);
					return { stdout: this.guest(script), stderr: "", exitCode: 0 };
				}
				this.hostCommands.push(command);
				return { stdout: this.host(command), stderr: "", exitCode: 0 };
			},
		};
	}

	private host(command: string) {
		if (command.includes("sw_vers")) {
			return `version=${this.macos.version}\nbuild=${this.macos.build}\nextra=${this.macos.extra}\n`;
		}
		if (command.includes("limactl start --tty=false")) {
			if (!this.vmRunning) {
				this.vmRunning = true;
				this.vmBootId = "vm-boot-2";
			}
			return "";
		}
		if (command.includes("limactl stop")) {
			if (this.jobRunning) this.violations.push(command);
			this.vmRunning = false;
			return "";
		}
		return "";
	}

	private guest(script: string) {
		if (
			(script.includes("systemd-run --unit=") ||
				script.includes("systemd-run --on-active=5")) &&
			this.jobRunning
		) {
			this.violations.push(script);
		}
		if (script.includes("follow size=")) {
			const result = script.includes("/install.log")
				? this.scenario.install
				: this.scenario.prepare;
			return `follow size=0 unit=inactive done=yes\n${result}\n--- log\n`;
		}
		if (script.includes("systemd-run --unit=")) return "started\n";
		if (script.startsWith("cat /proc/sys/kernel/random/boot_id")) {
			return `${this.vmBootId}\n`;
		}
		if (script.includes("exec 3>&1 >/dev/null 2>&1"))
			return this.scenario.assess;
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
			if (connection.hostKeyFingerprint !== "SHA256:pinned-mac") {
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
state lists=1794079799 refreshed=yes reboot=no dpkg=ok boot=vm-boot-1
docker active=active pid=812
swarm {"LocalNodeState":"inactive"}
--- simulation
Inst openssl [3.0.13-0ubuntu3.1] (3.0.13-0ubuntu3.4 Ubuntu:24.04/noble-updates, Ubuntu:24.04/noble-security [amd64])
--- simulation status=0
exit code=0`;

const INSTALLED = [
	"changed name=openssl from=3.0.13-0ubuntu3.1 to=3.0.13-0ubuntu3.4",
	"result status=installed reboot=yes docker-before=812 docker-after=812",
	"exit code=0",
].join("\n");

const SCENARIO: Scenario = {
	assess: PENDING,
	prepare: PENDING,
	install: INSTALLED,
};

let owner: Person;
let keyId: string;
let pool: Awaited<ReturnType<typeof insertPool>>;
let nextPort = 43_000;

/** A fake Mac runner machine, ready, host key pinned, its VM running. */
const fakeMac = async (
	name: string,
	values: Partial<typeof githubRunnerNodes.$inferInsert> = {},
) => {
	const fake = new FakeMac(SCENARIO);
	const port = nextPort++;
	fakes.set(port, fake);
	const node = await insertNode(pool, name, {
		port,
		platform: "macos",
		username: "dokploy",
		sshKeyId: keyId,
		hostKeyFingerprint: "SHA256:pinned-mac",
		phase: "ready",
		osReport: {
			at: new Date().toISOString(),
			host: {
				id: "macos",
				version: "26.0",
				build: "25A100",
				kernel: "25.0.0",
				updates: 1,
				security: 1,
				reboot: null,
				listsAt: null,
			},
			guest: null,
		},
		...values,
	});
	return { fake, node };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

const ENDED = ["succeeded", "failed", "skipped", "cancelled"];

const finished = (runId: string) =>
	settle(
		() => {
			// A hand-off sleeps a minute between its looks at macOS.
			wakeOsUpdateDrains();
			return runOf(runId);
		},
		(run) => ENDED.includes(run?.status ?? ""),
	);

const drainedBy = (nodeId: string, runId: string) =>
	settle(
		() => nodeOf(nodeId),
		(node) =>
			node.phase === "draining" &&
			(node.drain as GithubRunnerDrain | null)?.osUpdateRunId === runId,
	);

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
		job: "ios",
		startedAt: new Date(Date.now() - 600_000).toISOString(),
		completedAt: null,
	},
});

const busyRunner = (name: string): GithubRunner => ({
	id: 9,
	name: `${runnerNamePrefix(name)}1-abc123`,
	os: "Linux",
	status: "online",
	busy: true,
	labels: ["self-hosted", "Linux"],
	customLabels: [],
	version: "2.330.0",
});

/** One tick of the runner controller on the Mac (its VM's runtime). */
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
			maxRunners: 1,
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
		runtime: { runtimeVersion: RUNTIME_VERSION, autonomySetting: "off" },
		autonomyRuntime: 7,
	});
	return { plan, handed };
};

const ownerAccess = async (): Promise<OsUpdateAccess> => ({
	organizationId: owner.organizationId,
	serverIds: new Set(),
	runnerNodeIds: new Set(
		(
			await db.query.githubRunnerNodes.findMany({
				where: eq(githubRunnerNodes.organizationId, owner.organizationId),
				columns: { githubRunnerNodeId: true },
			})
		).map((row) => row.githubRunnerNodeId),
	),
	requireRun: async () => undefined,
	requireRunnerUpdate: async () => undefined,
});

/** Nothing on macOS ran as root, touched its updates, or rebooted it. */
const expectMacosUntouched = (fake: FakeMac) => {
	for (const command of fake.hostCommands) {
		expect(command).not.toMatch(/\bsudo\b|softwareupdate|shutdown|\breboot\b/);
	}
};

beforeAll(async () => {
	owner = await createOrganization("os-mac");
	pool = await insertPool(owner.organizationId, "os-mac-pool");
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

describe("the Linux VM of a Mac", () => {
	it("installs through limactl once its job ended, and restarts the VM instead of rebooting", async () => {
		const { fake, node } = await fakeMac("vm-update");
		fake.jobRunning = true;
		await db
			.insert(osUpdateRunnerNodes)
			.values({ githubRunnerNodeId: node.githubRunnerNodeId })
			.onConflictDoNothing();
		const [run] = await db
			.insert(osUpdateRuns)
			.values({
				organizationId: owner.organizationId,
				githubRunnerNodeId: node.githubRunnerNodeId,
				trigger: "manual",
				deadline: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
				settings: { ...DEFAULT_OS_UPDATE_SETTINGS, reboot: "if-required" },
			})
			.returning();
		if (!run) throw new Error("run not queued");
		await drainedBy(node.githubRunnerNodeId, run.osUpdateRunId);
		const { plan, handed } = await runnerTick(node.githubRunnerNodeId, {
			slots: [busySlot(node.name)],
			runners: [busyRunner(node.name)],
		});
		expect(plan.actions).toEqual([]);
		expect(handed).toBe(false);
		expect(
			fake.guestScripts.some((script) => script.includes("systemd-run")),
		).toBe(false);

		fake.jobRunning = false;
		expect(
			(await runnerTick(node.githubRunnerNodeId, { slots: [], runners: [] }))
				.handed,
		).toBe(true);
		const done = await finished(run.osUpdateRunId);
		expect(done).toMatchObject({ status: "succeeded", rebooted: true });
		expect(done?.message).toMatch(/machine rebooted/);
		expect(done?.log).toMatch(/Restarting VM dokploy-runners of vm-update/);
		// Every step and the assessment ran in the VM.
		expect(
			fake.guestScripts.some((script) =>
				script.includes("for name in 'openssl'; do"),
			),
		).toBe(true);
		// The VM restarted with the runner controller's scripts; the guest
		// never got a reboot, and macOS was not touched.
		expect(fake.vmBootId).toBe("vm-boot-2");
		expect(
			fake.guestScripts.some((script) =>
				script.includes("systemd-run --on-active=5"),
			),
		).toBe(false);
		expectMacosUntouched(fake);
		expect(fake.violations).toEqual([]);
		const back = await nodeOf(node.githubRunnerNodeId);
		expect(back.phase).toBe("ready");
		expect(back.drain).toBeNull();
	});

	it("skips a Mac whose VM does not run", async () => {
		const { fake, node } = await fakeMac("vm-stopped", { phase: "stopped" });
		const [run] = await db
			.insert(osUpdateRuns)
			.values({
				organizationId: owner.organizationId,
				githubRunnerNodeId: node.githubRunnerNodeId,
				trigger: "manual",
				deadline: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
				settings: DEFAULT_OS_UPDATE_SETTINGS,
			})
			.returning();
		if (!run) throw new Error("run not queued");
		const done = await finished(run.osUpdateRunId);
		expect(done?.status).toBe("skipped");
		expect(fake.guestScripts).toEqual([]);
	});
});

describe("the macOS hand-off", () => {
	it("drains the Mac, waits for its owner's update, and gives it back", async () => {
		const { fake, node } = await fakeMac("handoff");
		fake.jobRunning = true;
		const { run } = await handOffMacos(
			{ githubRunnerNodeId: node.githubRunnerNodeId, maxHours: 24 },
			await ownerAccess(),
			owner.email,
		);
		await drainedBy(node.githubRunnerNodeId, run.osUpdateRunId);
		expect(
			(
				await runnerTick(node.githubRunnerNodeId, {
					slots: [busySlot(node.name)],
					runners: [busyRunner(node.name)],
				})
			).handed,
		).toBe(false);
		// Not handed to the owner while the job runs.
		expect(
			notices.some(
				(item) =>
					item.notice.event === "handoff" && item.notice.server === "handoff",
			),
		).toBe(false);

		fake.jobRunning = false;
		await runnerTick(node.githubRunnerNodeId, { slots: [], runners: [] });
		const waiting = await settle(
			() => runOf(run.osUpdateRunId),
			(current) =>
				(current?.progress as OsUpdateRunProgress | null)?.step === "handoff",
		);
		expect((waiting?.progress as OsUpdateRunProgress).macos).toEqual({
			version: "26.0",
			build: "25A100",
			extra: "",
		});
		const held = await nodeOf(node.githubRunnerNodeId);
		expect((held.drain as GithubRunnerDrain).handoff).toBe(true);
		expect((held.drain as GithubRunnerDrain).installingAt).toBeTruthy();
		expect(notices).toContainEqual(
			expect.objectContaining({
				notice: expect.objectContaining({
					event: "handoff",
					title: "handoff is ready for its macOS update",
				}),
			}),
		);
		const listed = (await listOsUpdateMacs(await ownerAccess())).find(
			(mac) => mac.githubRunnerNodeId === node.githubRunnerNodeId,
		);
		expect(listed?.lastHandoff?.step).toBe("handoff");

		// The owner updates: the Mac restarts, then reports macOS 26.1.
		fake.offline = true;
		await settle(
			() => {
				wakeOsUpdateDrains();
				return runOf(run.osUpdateRunId);
			},
			(current) => /does not answer/.test(current?.log ?? ""),
		);
		fake.offline = false;
		fake.macos = { version: "26.1", build: "25B78", extra: "" };
		const done = await finished(run.osUpdateRunId);
		expect(done?.status).toBe("succeeded");
		expect(done?.message).toBe(
			"macOS updated: macOS 26.0 (25A100) → macOS 26.1 (25B78). handoff takes jobs again.",
		);
		expect((await nodeOf(node.githubRunnerNodeId)).phase).toBe("ready");
		// Dokploy installed nothing anywhere, and never rebooted the Mac.
		expect(fake.guestScripts).toEqual([]);
		expectMacosUntouched(fake);
		expect(
			fake.hostCommands.every((command) => command.includes("sw_vers")),
		).toBe(true);
		expect(notices).toContainEqual(
			expect.objectContaining({
				notice: expect.objectContaining({
					event: "succeeded",
					title: "macOS updated on handoff",
				}),
			}),
		);
	});

	it("gives the Mac back at once when a user asks", async () => {
		const { node } = await fakeMac("give-back");
		const { run } = await handOffMacos(
			{ githubRunnerNodeId: node.githubRunnerNodeId, maxHours: 24 },
			await ownerAccess(),
			owner.email,
		);
		await drainedBy(node.githubRunnerNodeId, run.osUpdateRunId);
		await runnerTick(node.githubRunnerNodeId, { slots: [], runners: [] });
		await settle(
			() => runOf(run.osUpdateRunId),
			(current) =>
				(current?.progress as OsUpdateRunProgress | null)?.step === "handoff",
		);
		// One hand-off at a time per Mac.
		await expect(
			handOffMacos(
				{ githubRunnerNodeId: node.githubRunnerNodeId, maxHours: 24 },
				await ownerAccess(),
				owner.email,
			),
		).rejects.toThrow(/already handed off/);
		const { run: cancelled } = await cancelOsUpdateRun(
			run.osUpdateRunId,
			await ownerAccess(),
		);
		expect(cancelled.status).toBe("cancelled");
		expect(cancelled.message).toMatch(/Given back by a user/);
		wakeOsUpdateDrains();
		const back = await settle(
			() => nodeOf(node.githubRunnerNodeId),
			(current) => current.phase === "ready",
		);
		expect(back.drain).toBeNull();
	});

	it("gives the Mac back when macOS did not change before the end", async () => {
		const { fake, node } = await fakeMac("expired");
		const [run] = await db
			.insert(osUpdateRuns)
			.values({
				organizationId: owner.organizationId,
				githubRunnerNodeId: node.githubRunnerNodeId,
				trigger: "manual",
				kind: "handoff",
				deadline: new Date(Date.now() + 8_000).toISOString(),
				settings: DEFAULT_OS_UPDATE_SETTINGS,
			})
			.returning();
		if (!run) throw new Error("hand-off not queued");
		await drainedBy(node.githubRunnerNodeId, run.osUpdateRunId);
		await runnerTick(node.githubRunnerNodeId, { slots: [], runners: [] });
		const done = await finished(run.osUpdateRunId);
		expect(done?.status).toBe("skipped");
		expect(done?.message).toMatch(
			/macOS did not change before the hand-off expired/,
		);
		expect((await nodeOf(node.githubRunnerNodeId)).phase).toBe("ready");
		expectMacosUntouched(fake);
		expect(notices).toContainEqual(
			expect.objectContaining({
				notice: expect.objectContaining({
					event: "missed",
					title: "Hand-off of expired expired",
				}),
			}),
		);
	});
});
