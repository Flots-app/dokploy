import { db } from "@dokploy/server/db";
import {
	requestTick,
	rotateRunnerNodeKey,
} from "@dokploy/server/utils/github-runners/controller";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

/**
 * The controller's tick against fake machines: SSH sessions answer from
 * `machines`, GitHub lists no runner, the database is the shared mock.
 */
const machines: Record<
	string,
	{ probe: () => Promise<string>; commands: string[] }
> = {};

vi.mock("@dokploy/server/utils/github-runners/ssh", async (importOriginal) => {
	const original =
		await importOriginal<
			typeof import("@dokploy/server/utils/github-runners/ssh")
		>();
	const fakeSession = (connection: { name: string }) => ({
		fingerprint: "SHA256:test",
		run: async (script: string, options?: { label?: string }) => {
			const machine = machines[connection.name];
			machine?.commands.push(script);
			const stdout =
				options?.label === "Probe" && machine ? await machine.probe() : "";
			return { stdout, stderr: "", exitCode: 0 };
		},
		close: () => undefined,
	});
	return {
		...original,
		sharedNodeSession: async (connection: { name: string }) =>
			fakeSession(connection),
		openNodeSession: async (connection: { name: string }) =>
			fakeSession(connection),
		closeSharedSessions: () => undefined,
	};
});

vi.mock(
	"@dokploy/server/utils/github-runners/github-api",
	async (importOriginal) => {
		const original =
			await importOriginal<
				typeof import("@dokploy/server/utils/github-runners/github-api")
			>();
		return {
			...original,
			createGithubRunnerClient: () => ({
				authorization: async () => "token test",
				listRunners: async () => [],
				deleteRunner: async () => undefined,
			}),
			resolveRunnerRelease: async () => ({
				version: "2.330.0",
				url: "https://example.invalid/actions-runner.tar.gz",
				sha256: "0".repeat(64),
			}),
			listRunnerReleases: async () => [],
			checkToken: async () => ({ valid: true, expiresAt: null }),
		};
	},
);

vi.mock(
	"@dokploy/server/utils/notifications/github-runners",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("@dokploy/server/utils/notifications/github-runners")
		>()),
		sendGithubRunnerNotifications: async () => undefined,
	}),
);

interface Update {
	values: Record<string, unknown>;
	sql: string;
	params: unknown[];
}

const state = (
	globalThis as {
		__dokployGithubRunners?: {
			owner: string;
			leader: boolean;
			running: boolean;
			timer: NodeJS.Timeout | null;
			leaseRenewals: Map<string, NodeJS.Timeout>;
			autonomyApplied: Map<string, string>;
			reconnects: Map<string, unknown>;
			tasks: Map<string, Promise<void>>;
		};
	}
).__dokployGithubRunners;
if (!state) throw new Error("The controller state is not loaded");

/** Records every db.update; `fail` makes `.returning()` of the matching ones throw. */
const recordUpdates = (fail: (update: Update) => boolean = () => false) => {
	const updates: Update[] = [];
	vi.mocked(db.update).mockImplementation(() => {
		const update: Update = { values: {}, sql: "", params: [] };
		const query = {
			set: (values: Record<string, unknown>) => {
				update.values = values;
				return query;
			},
			where: (where: unknown) => {
				const rendered = where
					? new PgDialect().sqlToQuery(where as SQL)
					: { sql: "", params: [] };
				update.sql = rendered.sql;
				update.params = rendered.params;
				updates.push(update);
				return query;
			},
			returning: async () => {
				if (fail(update)) {
					throw new Error("Connection terminated unexpectedly");
				}
				return [{ id: update.params[0] }];
			},
			// biome-ignore lint/suspicious/noThenProperty: drizzle queries are awaitable
			then: (resolve: (value: unknown) => void) => resolve([]),
		};
		return query as never;
	});
	return updates;
};

const pool = (id: string) => ({
	githubRunnerPoolId: id,
	organizationId: "org",
	name: id,
	authType: "token",
	token: "ghp_test",
	scope: "organization",
	owner: "Flots-app",
	repository: null,
	runnerGroup: "Default",
	apiUrl: "https://api.github.com",
	labels: ["ci"],
	runnerVersion: null,
	runnerEnv: "",
	placement: "fastest",
	rerunInterruptedJobs: false,
	autonomyReserve: 1,
	routingVariable: null,
	updatePolicy: null,
	rollouts: {},
});

const node = (
	id: string,
	poolRow: ReturnType<typeof pool>,
	overrides: Record<string, unknown> = {},
) => ({
	githubRunnerNodeId: id,
	organizationId: "org",
	githubRunnerPoolId: poolRow.githubRunnerPoolId,
	name: id,
	host: "192.0.2.10",
	port: 22,
	username: "root",
	platform: "linux",
	vmName: "dokploy-runners",
	vmDiskGb: 64,
	enabled: true,
	phase: "ready",
	drain: null,
	applied: null,
	observed: null,
	lastError: null,
	lastSeenAt: new Date().toISOString(),
	cpuPercent: 80,
	memoryPercent: 80,
	maxRunners: 2,
	diskReserveGb: 10,
	diskCleanupGb: 20,
	extraLabels: [],
	hostKeyFingerprint: "SHA256:test",
	sshPrivateKey: "private",
	sshPublicKey: "ssh-ed25519 AAAA test",
	sshKey: null,
	cleanups: [],
	benchmark: { at: new Date().toISOString() },
	caches: { at: new Date().toISOString() },
	updatePolicy: null,
	updateState: null,
	osReport: null,
	pool: poolRow,
	...overrides,
});

/** What `runnerctl status` prints on a Linux machine with runtime v8 and no slot. */
const status = (autonomy: string) =>
	[
		"runtime version=8",
		"host cpus=4 memory_kib=8388608 available_kib=4194304 arch=x86_64 load=0.10",
		"disk total_kib=209715200 free_kib=157286400",
		"release current=2.330.0",
		"cpu busy=100 total=1000",
		"slice usage_usec= memory_current= memory_max=",
		"docker state=active",
		autonomy,
		"firewall helper=yes loaded=none",
	].join("\n");

const machine = (name: string, probe: () => Promise<string>) => {
	machines[name] = { probe, commands: [] };
	return machines[name];
};

const tick = async () => {
	const loads = vi.mocked(db.query.githubRunnerNodes.findMany).mock.calls
		.length;
	requestTick();
	await vi.waitFor(
		() => {
			const started =
				vi.mocked(db.query.githubRunnerNodes.findMany).mock.calls.length >
				loads;
			if (!started) throw new Error("the tick has not started");
		},
		{ timeout: 2_000, interval: 10 },
	);
	await vi.waitFor(
		() => {
			if (state.running) throw new Error("the tick still runs");
		},
		{ timeout: 10_000, interval: 20 },
	);
};

const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

beforeEach(() => {
	state.leader = true;
	state.timer = setInterval(() => undefined, 1e9);
});

afterEach(async () => {
	if (state.timer) clearInterval(state.timer);
	state.timer = null;
	state.leader = false;
	await Promise.allSettled([...state.tasks.values()]);
	for (const timer of state.leaseRenewals.values()) clearInterval(timer);
	state.leaseRenewals.clear();
	state.reconnects.clear();
	state.autonomyApplied.clear();
	for (const name of Object.keys(machines)) delete machines[name];
	vi.mocked(db.query.githubRunnerNodes.findMany).mockReset();
	vi.mocked(db.query.githubRunnerNodes.findMany).mockResolvedValue([]);
	vi.mocked(db.query.githubRunnerNodes.findFirst).mockReset();
	vi.mocked(db.query.githubRunnerNodes.findFirst).mockResolvedValue(undefined);
});

afterAll(() => errors.mockRestore());

const leaseWrites = (updates: Update[], id: string) =>
	updates.filter(
		(update) => "lockedBy" in update.values && update.params.includes(id),
	);

describe("review fixes, sixth review", () => {
	it("lets every machine go when the database fails on one of them", async () => {
		const ci = pool("pool-1");
		vi.mocked(db.query.githubRunnerNodes.findMany).mockResolvedValue([
			node("node-a", ci),
			node("node-b", ci),
		] as never);
		machine("node-a", async () => "runtime version=0");
		machine("node-b", async () => "runtime version=0");
		// Postgres restarting: the lease of B cannot be written.
		const updates = recordUpdates(
			(update) =>
				update.params.includes("node-b") && update.values.lockedBy !== null,
		);
		await tick();
		const releasedA = leaseWrites(updates, "node-a").filter(
			(update) => update.values.lockedBy === null,
		);
		expect(releasedA).toHaveLength(1);
		expect(state.leaseRenewals.has("node-a")).toBe(false);
		expect(state.leaseRenewals.has("node-b")).toBe(false);
	});

	it("ends a tick only once every pool has", async () => {
		let answer: (stdout: string) => void = () => undefined;
		const slow = new Promise<string>((resolve) => {
			answer = resolve;
		});
		vi.mocked(db.query.githubRunnerNodes.findMany).mockResolvedValue([
			node("node-a", pool("pool-1")),
			node("node-c", pool("pool-2")),
		] as never);
		machine("node-a", async () => "runtime version=0");
		machine("node-c", () => slow);
		recordUpdates(
			(update) =>
				update.params.includes("node-a") && update.values.lockedBy !== null,
		);
		requestTick();
		await vi.waitFor(
			() => {
				if (!machines["node-c"]?.commands.length) throw new Error("not probed");
			},
			{ timeout: 2_000, interval: 10 },
		);
		await new Promise((resolve) => setTimeout(resolve, 100));
		// Pool 1 failed, pool 2 still probes its machine: the tick goes on.
		expect(state.running).toBe(true);
		answer("runtime version=0");
		await vi.waitFor(
			() => {
				if (state.running) throw new Error("the tick still runs");
			},
			{ timeout: 10_000, interval: 20 },
		);
	});

	it("turns autonomy off on a machine that follows another leader's setting", async () => {
		const ci = pool("pool-1");
		// Disabled: the machine must not arm itself. This process wrote "off"
		// when it led before; another leader wrote "on" since.
		vi.mocked(db.query.githubRunnerNodes.findMany).mockResolvedValue([
			node("node-x", ci, { enabled: false }),
		] as never);
		const x = machine("node-x", async () =>
			status("autonomyset max_runners=2 min_free_kib=10485760 firewall=host"),
		);
		state.autonomyApplied.set("node-x", "off");
		recordUpdates();
		await tick();
		expect(
			x.commands.filter((command) => command.includes("runnerctl autonomy")),
		).toEqual([expect.stringMatching(/runnerctl autonomy off$/)]);
	});

	it("leaves the autonomy setting a machine already follows", async () => {
		const ci = pool("pool-1");
		vi.mocked(db.query.githubRunnerNodes.findMany).mockResolvedValue([
			node("node-y", ci, { enabled: false }),
		] as never);
		const y = machine("node-y", async () => status("autonomyset state=off"));
		recordUpdates();
		await tick();
		// It already follows what Dokploy wants: nothing to write.
		expect(
			y.commands.filter((command) => command.includes("runnerctl autonomy")),
		).toEqual([]);
	});

	it("never reports a key rotation that did not run", async () => {
		vi.mocked(db.query.githubRunnerNodes.findFirst).mockResolvedValue(
			node("node-k", pool("pool-1")) as never,
		);
		machine("node-k", async () => "runtime version=0");
		// The lease cannot be written: the rotation never starts.
		recordUpdates((update) => update.values.lockedBy !== undefined);
		await expect(rotateRunnerNodeKey("node-k")).rejects.toThrow(
			"Connection terminated unexpectedly",
		);
		expect(machines["node-k"]?.commands).toEqual([]);
	});
});
