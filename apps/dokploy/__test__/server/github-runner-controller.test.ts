import { db } from "@dokploy/server/db";
import {
	environmentHash,
	requestTick,
	rotateRunnerNodeKey,
} from "@dokploy/server/utils/github-runners/controller";
import {
	JOB_GUARD_RUNTIME,
	RUNTIME_VERSION,
} from "@dokploy/server/utils/github-runners/runtime";
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
/** Labels of the runners registered on GitHub, in order. */
const registered: string[][] = [];

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
				generateJitConfig: async (options: { labels: string[] }) => {
					registered.push(options.labels);
					const file = (text: string) => Buffer.from(text).toString("base64");
					return {
						runnerId: registered.length,
						encodedJitConfig: file(
							JSON.stringify({
								".runner": file("{}"),
								".credentials": file("{}"),
							}),
						),
					};
				},
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
			macJobAt: Map<string, number>;
			pendingEvents: Map<string, { message: string }[]>;
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
	jobGuard: {
		repositories: [],
		events: [],
		refuseForks: true,
		refuseDependabot: true,
	},
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
	diskCleanupPercent: 90,
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

/** What `runnerctl status` prints on a Linux machine with the current runtime and no slot. */
const status = (autonomy: string, runtimeVersion = RUNTIME_VERSION) =>
	[
		`runtime version=${runtimeVersion}`,
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
	state.macJobAt.clear();
	state.pendingEvents.clear();
	registered.length = 0;
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

describe("job guard", () => {
	const applied = {
		runtimeVersion: RUNTIME_VERSION,
		runnerVersion: "2.330.0",
		cpuPercent: 80,
		memoryPercent: 80,
		vmDiskGb: null,
		cpus: 4,
		memoryBytes: 8 * 1024 ** 3,
		envHash: "written-before",
	};
	const writes = (commands: string[]) =>
		commands.flatMap((command) => {
			const match = command.match(/runnerctl (env|guard)$/);
			return match ? [match[1]] : [];
		});

	it("writes the guard with the environment on a runtime that reads it", async () => {
		const ci = pool("pool-1");
		vi.mocked(db.query.githubRunnerNodes.findMany).mockResolvedValue([
			node("node-g", ci, { enabled: false, applied }),
		] as never);
		const g = machine("node-g", async () => status("autonomyset state=off"));
		recordUpdates();
		await tick();
		expect(writes(g.commands)).toEqual(["env", "guard"]);
	});

	it("leaves the guard to the runtime update on an older runtime", async () => {
		const ci = pool("pool-1");
		vi.mocked(db.query.githubRunnerNodes.findMany).mockResolvedValue([
			node("node-o", ci, {
				enabled: false,
				applied: {
					...applied,
					runtimeVersion: JOB_GUARD_RUNTIME - 1,
					envHash: environmentHash(ci as never, JOB_GUARD_RUNTIME - 1),
				},
			}),
		] as never);
		const o = machine("node-o", async () =>
			status("autonomyset state=off", JOB_GUARD_RUNTIME - 1),
		);
		recordUpdates();
		await tick();
		// Its environment is the one written before: nothing to rewrite, and no
		// `runnerctl guard` that this runtime does not have.
		expect(writes(o.commands)).toEqual([]);
		// The same pool on the new runtime: the hash now covers the guard.
		expect(environmentHash(ci as never, JOB_GUARD_RUNTIME)).not.toBe(
			environmentHash(ci as never, JOB_GUARD_RUNTIME - 1),
		);
	});
});

describe("a Mac short of disk or memory", () => {
	const GiB_KIB = 1024 * 1024;
	/** What the Mac mini of the incident reports: 32 GiB, 228 GiB disk. */
	const macProbe =
		(options: {
			freeGiB: number;
			memoryFree?: number;
			vm?: string;
			guest?: string;
		}) =>
		async () => {
			const vm = options.vm ?? "Running";
			return [
				"mac cpus=12 memory_bytes=34359738368 arch=arm64 version=27.0.1 load=1.00",
				`macmem free_percent=${options.memoryFree ?? 60}`,
				`macdisk total_kib=${228 * GiB_KIB} free_kib=${Math.round(options.freeGiB * GiB_KIB)}`,
				"lima version=2.2.1 managed=yes",
				`vm status=${vm} cpus=9 memory_bytes=17179869184 disk_bytes=26843545600 type=vz`,
				...(vm === "Running"
					? (options.guest ?? status("autonomyset state=off"))
							.split("\n")
							.map((line) => `guest: ${line}`)
					: []),
			].join("\n");
		};
	const mac = (id: string) =>
		node(id, pool("pool-1"), {
			platform: "macos",
			username: "dokploy-manager",
			diskReserveGb: 15,
			maxRunners: 1,
		});
	const load = (row: ReturnType<typeof mac>) => {
		vi.mocked(db.query.githubRunnerNodes.findMany).mockResolvedValue([
			row,
		] as never);
		vi.mocked(db.query.githubRunnerNodes.findFirst).mockResolvedValue(
			row as never,
		);
	};
	const count = (commands: string[], what: RegExp) =>
		commands.filter((command) => what.test(command)).length;
	const observed = (updates: Update[]) =>
		updates.find((update) => update.values.observed)?.values.observed as {
			admission: { ok: boolean; reason?: string };
			events: { message: string }[];
		};
	const settle = () => Promise.allSettled([...state.tasks.values()]);

	it("stops the VM once no job runs, below the disk reserve", async () => {
		const row = mac("mac-a");
		load(row);
		const a = machine("mac-a", macProbe({ freeGiB: 12 }));
		const updates = recordUpdates();
		await tick();
		await settle();
		expect(count(a.commands, /limactl stop/)).toBe(1);
		expect(count(a.commands, /limactl start/)).toBe(0);
		const seen = observed(updates);
		expect(seen.admission).toEqual({
			ok: false,
			reason: "12 GiB free, below the 15 GiB reserve",
		});
		expect(seen.events.map((event) => event.message)).toContain(
			"Stopping VM dokploy-runners: the Mac has 12 GiB free, below its 15 GiB reserve",
		);
		expect(state.pendingEvents.get("mac-a")?.[0]?.message).toBe(
			"VM dokploy-runners stopped to give the Mac its memory back: the Mac has 12 GiB free, below its 15 GiB reserve. It starts again once the Mac has 20 GiB free",
		);
	});

	it("waits for a running slot before it stops the VM", async () => {
		const row = mac("mac-b");
		load(row);
		const since = Math.floor(Date.now() / 1000);
		const b = machine(
			"mac-b",
			macProbe({
				freeGiB: 12,
				guest: `${status("autonomyset state=off")}\nslot id=1 active=active since=${since} name=dkp-mac-b-1-abc000`,
			}),
		);
		recordUpdates();
		await tick();
		await settle();
		expect(count(b.commands, /limactl stop/)).toBe(0);
	});

	it("starts the stopped VM again only once the Mac has room", async () => {
		const row = mac("mac-c");
		load(row);
		let freeGiB = 18.8;
		const c = machine("mac-c", () => macProbe({ freeGiB, vm: "Stopped" })());
		const updates = recordUpdates();
		await tick();
		await settle();
		expect(count(c.commands, /limactl start/)).toBe(0);
		expect(observed(updates).admission).toEqual({
			ok: false,
			reason: "the Mac has 18.8 GiB free; its VM starts again above 20 GiB",
		});
		freeGiB = 25;
		await tick();
		await vi.waitFor(
			() => {
				if (!count(c.commands, /limactl start/)) throw new Error("not started");
			},
			{ timeout: 5_000, interval: 20 },
		);
		await settle();
	});

	it("restarts a VM that ran jobs once it idled on a Mac short of memory", async () => {
		const row = mac("mac-d");
		load(row);
		state.macJobAt.set("mac-d", Date.now() - 11 * 60_000);
		const d = machine("mac-d", macProbe({ freeGiB: 30, memoryFree: 38 }));
		const updates = recordUpdates();
		await tick();
		await settle();
		expect(observed(updates).admission).toEqual({
			ok: false,
			reason:
				"the VM restarts to give the Mac its memory back (the Mac has 38% of its memory free)",
		});
		const order = d.commands.flatMap((command) =>
			/limactl stop/.test(command)
				? ["stop"]
				: /limactl start/.test(command)
					? ["start"]
					: [],
		);
		expect(order).toEqual(["stop", "start"]);
		expect(state.macJobAt.has("mac-d")).toBe(false);
	});

	it("leaves the VM of a Mac with memory and disk to spare", async () => {
		const row = mac("mac-e");
		load(row);
		state.macJobAt.set("mac-e", Date.now() - 11 * 60_000);
		const e = machine("mac-e", macProbe({ freeGiB: 30, memoryFree: 70 }));
		recordUpdates();
		await tick();
		await settle();
		expect(count(e.commands, /limactl (stop|start)/)).toBe(0);
	});
});

describe("x86_64 runners on a Mac", () => {
	const GiB_KIB = 1024 * 1024;
	const macProbe = (rosettaLine: string) => async () =>
		[
			"mac cpus=10 memory_bytes=17179869184 arch=arm64 version=27.2 load=1.00",
			"macmem free_percent=70",
			`macdisk total_kib=${460 * GiB_KIB} free_kib=${200 * GiB_KIB}`,
			"macsetup admin=no sleep=0 filevault=off daemon=yes rosetta=yes",
			"lima version=2.2.1 managed=yes",
			"vm status=Running cpus=7 memory_bytes=10200547328 disk_bytes=64424509440 type=vz",
			...`${status("autonomyset state=off").replace("arch=x86_64", "arch=aarch64")}\n${rosettaLine}`
				.split("\n")
				.map((line) => `guest: ${line}`),
		].join("\n");
	const m4 = (id: string, rosetta: boolean) =>
		node(id, pool("pool-1"), {
			platform: "macos",
			username: "dokploy-manager",
			maxRunners: 1,
			x64Runners: 1,
			applied: {
				runtimeVersion: RUNTIME_VERSION,
				runnerVersion: "2.330.0",
				cpuPercent: 80,
				memoryPercent: 80,
				vmDiskGb: 60,
				cpus: 7,
				memoryBytes: 10200547328,
				envHash: "",
				bootScript: 3,
				rosetta,
			},
		});
	const load = (row: ReturnType<typeof m4>) => {
		vi.mocked(db.query.githubRunnerNodes.findMany).mockResolvedValue([
			row,
		] as never);
		vi.mocked(db.query.githubRunnerNodes.findFirst).mockResolvedValue(
			row as never,
		);
	};
	const observedOf = (updates: Update[]) =>
		updates.find((update) => update.values.observed)?.values.observed as {
			x64?: { runners: number; release: string | null; blocked: string | null };
			events: { message: string }[];
		};

	it("arms the x86_64 slot with its labels and Docker platform", async () => {
		const row = m4("mac-x1", true);
		load(row);
		const mac = machine(
			"mac-x1",
			macProbe("rosetta enabled=yes release=2.330.0"),
		);
		const updates = recordUpdates();
		await tick();
		await Promise.allSettled([...state.tasks.values()]);
		const arms = mac.commands.filter((command) =>
			/runnerctl arm \d+ \d+/.test(command),
		);
		expect(
			arms.map((command) => command.match(/runnerctl arm .*$/m)?.[0]),
		).toEqual([
			expect.stringMatching(/^runnerctl arm 1 \d+$/),
			expect.stringMatching(/^runnerctl arm 32 \d+ x64$/),
		]);
		expect(registered.slice(0, 2)).toEqual([
			["self-hosted", "Linux", "ARM64", "ci", "dokploy-mac-x1"],
			["self-hosted", "Linux", "X64", "ci-x64", "dokploy-mac-x1-x64"],
		]);
		// The reserve the machine arms itself with holds native runners only.
		expect(registered.filter((labels) => labels.includes("X64"))).toHaveLength(
			1,
		);
		expect(observedOf(updates).x64).toEqual({
			runners: 1,
			release: "2.330.0",
			blocked: null,
		});
	});

	it("installs the x86_64 runner of the native release, then arms it", async () => {
		const row = m4("mac-x2", true);
		load(row);
		const mac = machine("mac-x2", macProbe("rosetta enabled=yes release="));
		const updates = recordUpdates();
		await tick();
		await Promise.allSettled([...state.tasks.values()]);
		expect(
			mac.commands.filter((command) => command.includes("install-release")),
		).toEqual([
			expect.stringMatching(
				/runnerctl install-release 2\.330\.0 https:\/\/example\.invalid\/actions-runner\.tar\.gz 0{64} x64$/,
			),
		]);
		// No x86_64 slot before its runner is there.
		expect(registered.some((labels) => labels.includes("X64"))).toBe(false);
		expect(observedOf(updates).x64?.blocked).toBe(
			"installing the x86_64 runner",
		);
	});

	it("waits for the VM to restart with Rosetta", async () => {
		const row = m4("mac-x3", false);
		load(row);
		const mac = machine("mac-x3", macProbe("rosetta enabled=no release="));
		const updates = recordUpdates();
		await tick();
		await Promise.allSettled([...state.tasks.values()]);
		expect(mac.commands.some((command) => / x64$/.test(command))).toBe(false);
		const seen = observedOf(updates);
		expect(seen.x64?.blocked).toBe(
			"the VM restarts with Rosetta once no job runs",
		);
		expect(seen.events.map((event) => event.message)).toContain(
			"x86_64 runners wait: the VM restarts with Rosetta once no job runs",
		);
	});
});
