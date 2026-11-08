/**
 * The OS updates controller on a real PostgreSQL, against fake servers: each
 * fake answers the scripts the controller sends over "SSH" (start a step,
 * follow it, reboot, read the boot id...) with what a server would print.
 * Notifications are captured instead of sent.
 */
import { db } from "@dokploy/server/db";
import {
	type OsUpdateRunProgress,
	osUpdateRuns,
	osUpdateServers,
	server,
	sshKeys,
} from "@dokploy/server/db/schema";
import type { NodeSession } from "@dokploy/server/utils/github-runners/ssh";
import type { OsUpdateNotice } from "@dokploy/server/utils/notifications/os-updates";
import {
	BUSY_MESSAGE,
	startOsUpdatesController,
	stopOsUpdatesController,
	tickOsUpdates,
} from "@dokploy/server/utils/os-updates/controller";
import {
	DEFAULT_OS_UPDATE_SETTINGS,
	type OsUpdateSettings,
} from "@dokploy/server/utils/os-updates/filters";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createOrganization, type Person, removeCreatedRows } from "./fixtures";

interface Scenario {
	/** Records of the prepare step (an assessment, then its exit code). */
	prepare: string;
	/** Records of the install step. */
	install?: string;
	/** What the assessment over SSH prints. */
	assess?: string;
	/** Called when the controller first follows the prepare step. */
	onPrepare?: () => void;
}

/** A server as the controller sees it through SSH. */
class FakeServer {
	bootId = "boot-1";
	scripts: string[] = [];
	private prepared = false;

	constructor(readonly scenario: Scenario) {}

	session(): NodeSession {
		return {
			fingerprint: "SHA256:fake",
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
		if (script.includes("follow size=")) {
			const install = script.includes("/install.log");
			if (!install && !this.prepared) {
				this.prepared = true;
				this.scenario.onPrepare?.();
			}
			const result = install ? this.scenario.install : this.scenario.prepare;
			return `follow size=0 unit=inactive done=yes\n${result ?? ""}\n--- log\n`;
		}
		if (script.includes("systemd-run --on-active=5")) {
			// The reboot: the next boot id differs.
			this.bootId = "boot-2";
			return "";
		}
		if (script.includes("systemd-run --unit=")) return "started\n";
		if (script.startsWith("cat /proc/sys/kernel/random/boot_id")) {
			return `${this.bootId}\n`;
		}
		if (script.includes("exec 3>&1 >/dev/null 2>&1")) {
			return this.scenario.assess ?? this.scenario.prepare;
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
		openNodeSession: async (connection: { port: number; name: string }) => {
			const fake = fakes.get(connection.port);
			if (!fake) throw new Error(`Unable to connect to ${connection.name}`);
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

const PREPARED = `os id=ubuntu like=debian version=24.04 codename=noble kernel=6.8.0-45-generic apt=yes
pretty Ubuntu 24.04.1 LTS
state lists=1794079799 refreshed=yes reboot=no dpkg=ok boot=boot-1
docker active=active pid=812
swarm {"LocalNodeState":"inactive"}
--- simulation
Inst openssl [3.0.13-0ubuntu3.1] (3.0.13-0ubuntu3.4 Ubuntu:24.04/noble-updates, Ubuntu:24.04/noble-security [amd64])
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
let nextPort = 41_000;

/** A fake server, registered in Dokploy with a port of its own. */
const fakeServer = async (name: string, scenario: Scenario) => {
	const fake = new FakeServer(scenario);
	const port = nextPort++;
	fakes.set(port, fake);
	const [row] = await db
		.insert(server)
		.values({
			organizationId: owner.organizationId,
			name,
			ipAddress: "192.0.2.50",
			port,
			username: "root",
			sshKeyId: keyId,
			createdAt: new Date().toISOString(),
		})
		.returning();
	if (!row) throw new Error("server not created");
	return { fake, server: row };
};

const queueRun = async (
	serverId: string,
	settings: Partial<OsUpdateSettings>,
	values: Partial<typeof osUpdateRuns.$inferInsert> = {},
) => {
	// As Install now and assignments do: the server's row holds its assessment.
	await db
		.insert(osUpdateServers)
		.values({ serverId, periodicAssessment: false })
		.onConflictDoNothing();
	const [run] = await db
		.insert(osUpdateRuns)
		.values({
			organizationId: owner.organizationId,
			serverId,
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

/** Ticks until the run ends (or the condition holds). */
const settle = async <T>(
	read: () => Promise<T>,
	done: (value: T) => boolean,
) => {
	const giveUp = Date.now() + 20_000;
	for (;;) {
		await tickOsUpdates();
		const value = await read();
		if (done(value)) return value;
		if (Date.now() > giveUp) throw new Error("the controller did not settle");
		await sleep(200);
	}
};

const finished = (runId: string) =>
	settle(
		() =>
			db.query.osUpdateRuns.findFirst({
				where: eq(osUpdateRuns.osUpdateRunId, runId),
			}),
		(run) =>
			["succeeded", "failed", "skipped", "cancelled"].includes(
				run?.status ?? "",
			),
	);

const noticesOf = (server: string) =>
	notices
		.filter((item) => item.organizationId === owner.organizationId)
		.map((item) => item.notice)
		.filter((notice) => notice.server === server);

beforeAll(async () => {
	owner = await createOrganization("os-controller");
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

describe("the run of a server", () => {
	it("installs the selected updates and needs no reboot", async () => {
		const { fake, server } = await fakeServer("plain", {
			prepare: PREPARED,
			install: installed({ reboot: false }),
		});
		const run = await finished(
			(await queueRun(server.serverId, { reboot: "if-required" }))
				.osUpdateRunId,
		);
		expect(run).toMatchObject({
			status: "succeeded",
			rebooted: false,
			rebootRequired: false,
			attempts: 1,
		});
		expect(run?.packages).toEqual([
			{
				name: "openssl",
				from: "3.0.13-0ubuntu3.1",
				to: "3.0.13-0ubuntu3.4",
				security: true,
			},
		]);
		// Only the selected update is allowed in the install step.
		expect(fake.sent("for name in 'openssl'; do")).toBe(true);
		expect(fake.sent("systemd-run --on-active=5")).toBe(false);
		// The run's files go, and the server is assessed again.
		expect(fake.sent("rm -rf /var/lib/dokploy-os-updates/")).toBe(true);
		const state = await db.query.osUpdateServers.findFirst({
			where: eq(osUpdateServers.serverId, server.serverId),
		});
		expect(state?.assessment?.os.id).toBe("ubuntu");
	});

	it("reboots when an update asks for it, and waits for the server", async () => {
		const { fake, server } = await fakeServer("reboot", {
			prepare: PREPARED,
			install: installed({ reboot: true }),
		});
		const run = await finished(
			(await queueRun(server.serverId, { reboot: "if-required" }))
				.osUpdateRunId,
		);
		expect(run).toMatchObject({ status: "succeeded", rebooted: true });
		expect(run?.message).toMatch(/server rebooted/);
		expect(fake.sent("systemd-run --on-active=5")).toBe(true);
		expect(fake.bootId).toBe("boot-2");
	});

	it("installs nothing once the window closed during the preparation", async () => {
		const { fake, server } = await fakeServer("late", {
			prepare: PREPARED,
			install: installed({ reboot: false }),
			// The preparation took the rest of the window.
			onPrepare: () => vi.setSystemTime(Date.now() + 3 * 60 * 60_000),
		});
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			const run = await finished(
				(await queueRun(server.serverId, {})).osUpdateRunId,
			);
			expect(run?.status).toBe("skipped");
			expect(run?.message).toMatch(/closed before the install could start/);
			expect(fake.sent("-install ")).toBe(false);
			expect(run?.packages).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("records a failed install, what it changed, and notifies", async () => {
		const { server } = await fakeServer("broken", {
			prepare: PREPARED,
			install: installed({ reboot: false, exitCode: 100 }),
		});
		const run = await finished(
			(await queueRun(server.serverId, {})).osUpdateRunId,
		);
		expect(run?.status).toBe("failed");
		expect(run?.message).toMatch(
			/apt-get upgrade failed \(exit 100\).*1 package changed before it stopped/,
		);
		expect(run?.packages.map((item) => item.name)).toEqual(["openssl"]);
		expect(noticesOf("broken")).toEqual([
			expect.objectContaining({
				event: "failed",
				title: "OS updates failed on broken",
			}),
		]);
	});
});

describe("runs left by a stopped Dokploy", () => {
	const orphan = async (serverId: string, attempts: number) =>
		queueRun(
			serverId,
			{ reboot: "never" },
			{
				status: "running",
				attempts,
				startedAt: new Date().toISOString(),
				lockedBy: "a-stopped-process",
				lockedUntil: new Date(Date.now() - 60_000).toISOString(),
				progress: {
					step: "install",
					logOffset: 0,
					allowed: ["openssl"],
					bootId: null,
					rebootRequestedAt: null,
				} satisfies OsUpdateRunProgress,
			},
		);

	it("resumes a run from its install step", async () => {
		const { fake, server } = await fakeServer("resumed", {
			prepare: PREPARED,
			install: installed({ reboot: false }),
		});
		const run = await finished(
			(await orphan(server.serverId, 1)).osUpdateRunId,
		);
		expect(run).toMatchObject({ status: "succeeded", attempts: 2 });
		expect(run?.log).toMatch(/resuming from its last step/);
		// The install step that ran on the server is followed, not started again.
		expect(fake.sent("follow size=")).toBe(true);
		expect(fake.sent("systemd-run --unit=")).toBe(false);
		expect(run?.packages.map((item) => item.name)).toEqual(["openssl"]);
	});

	it("gives up after three interruptions, and notifies", async () => {
		const { fake, server } = await fakeServer("given-up", {
			prepare: PREPARED,
			install: installed({ reboot: false }),
		});
		const run = await finished(
			(await orphan(server.serverId, 3)).osUpdateRunId,
		);
		expect(run?.status).toBe("failed");
		expect(run?.message).toMatch(/stopped during this run 3 times/);
		expect(fake.scripts).toEqual([]);
		expect(noticesOf("given-up")).toEqual([
			expect.objectContaining({
				event: "failed",
				title: "OS updates failed on given-up",
			}),
		]);
	});
});

describe("Check now", () => {
	it("says so and asks again when another OS update script holds the server", async () => {
		const { server } = await fakeServer("busy", {
			prepare: PREPARED,
			assess: "busy\n",
		});
		const requestedAt = new Date().toISOString();
		await db.insert(osUpdateServers).values({
			serverId: server.serverId,
			periodicAssessment: false,
			assessmentRequestedAt: requestedAt,
		});
		const state = await settle(
			() =>
				db.query.osUpdateServers.findFirst({
					where: eq(osUpdateServers.serverId, server.serverId),
				}),
			(row) =>
				row?.assessmentError !== null && row?.assessmentError !== undefined,
		);
		expect(state?.assessmentError).toBe(BUSY_MESSAGE);
		// Still asked: the next try comes a minute later.
		expect(state?.assessmentRequestedAt).toBe(requestedAt);
		expect(state?.assessmentTriedAt).not.toBeNull();
	});
});
