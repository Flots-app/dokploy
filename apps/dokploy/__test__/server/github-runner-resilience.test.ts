import { spawnSync } from "node:child_process";
import type {
	GithubRunnerNode,
	GithubRunnerPool,
	GithubRunnerRollout,
} from "@dokploy/server/db/schema";
import {
	runnerAlertConditions,
	runnerAlerts,
} from "@dokploy/server/utils/github-runners/alerts";
import {
	autonomySetting,
	MAX_SPARES_PER_TICK,
	planSpares,
	SPARE_ROTATE_MS,
} from "@dokploy/server/utils/github-runners/autonomy";
import type { GithubRunner } from "@dokploy/server/utils/github-runners/github-api";
import {
	osPatchScript,
	parsePatchResult,
} from "@dokploy/server/utils/github-runners/os";
import {
	parseRecords,
	parseRuntimeStatus,
} from "@dokploy/server/utils/github-runners/probe";
import { planNode } from "@dokploy/server/utils/github-runners/reconcile";
import {
	CANARY_GIVE_UP_MS,
	CANARY_SOAK_MS,
	canaryProgress,
	type RolloutMachine,
	rolloutGate,
	UPDATE_STALE_MS,
} from "@dokploy/server/utils/github-runners/rollout";
import {
	updatePolicySchema,
	updateWindowEnd,
} from "@dokploy/server/utils/github-runners/updates";
import { ntfyHeaderValue } from "@dokploy/server/utils/notifications/github-runners";
import { describe, expect, it } from "vitest";
import {
	machineUpdatePolicy,
	type RunnerMachine,
} from "@/components/dashboard/github-runners/format";

const now = Date.parse("2026-10-22T08:00:00.000Z");
const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();
const MINUTE = 60_000;

const machine = (
	id: string,
	overrides: Partial<RolloutMachine> = {},
): RolloutMachine => ({
	githubRunnerNodeId: id,
	name: id,
	enabled: true,
	updateState: null,
	...overrides,
});

const updating = (id: string, startedMinutesAgo = 5) =>
	machine(id, {
		updateState: {
			inProgress: {
				kind: "runner",
				target: "2.332.0",
				startedAt: iso(-startedMinutesAgo * MINUTE),
			},
		},
	});

const rollout = (
	overrides: Partial<GithubRunnerRollout> = {},
): GithubRunnerRollout => ({
	target: "2.332.0",
	canaryNodeId: "m6",
	startedAt: iso(-20 * MINUTE),
	installedAt: null,
	passedAt: null,
	failedAt: null,
	error: null,
	...overrides,
});

const gate = (
	overrides: Partial<Parameters<typeof rolloutGate>[0]> = {},
): ReturnType<typeof rolloutGate> =>
	rolloutGate({
		kind: "runner",
		target: "2.332.0",
		reason: "anytime",
		selfId: "m4",
		policy: { maxUnavailable: 1, canary: true },
		rollout: undefined,
		machines: [machine("m6"), machine("m4"), machine("build-1")],
		now,
		...overrides,
	});

describe("rolling updates", () => {
	it("makes the first machine to update a release its canary", () => {
		expect(gate()).toEqual({ go: true, canary: true });
	});

	it("keeps the others waiting until the canary passed", () => {
		expect(gate({ rollout: rollout() })).toEqual({
			go: false,
			reason: "m6 runs 2.332.0 first, as the canary",
		});
		expect(
			gate({
				rollout: rollout({ installedAt: iso(-5 * MINUTE), passedAt: iso(0) }),
			}),
		).toEqual({ go: true, canary: false });
	});

	it("pauses the rollout when the canary failed", () => {
		expect(
			gate({
				rollout: rollout({ failedAt: iso(-MINUTE), error: "download failed" }),
			}),
		).toEqual({
			go: false,
			reason: "the rollout of 2.332.0 is paused: it failed on m6",
		});
		// The canary itself tries again (after the retry delay of its policy).
		expect(
			gate({ selfId: "m6", rollout: rollout({ failedAt: iso(-MINUTE) }) }),
		).toEqual({ go: true, canary: true });
	});

	it("hands the canary role over when the canary is gone or disabled", () => {
		expect(
			gate({
				rollout: rollout(),
				machines: [machine("m6", { enabled: false }), machine("m4")],
			}),
		).toEqual({ go: true, canary: true });
		expect(gate({ rollout: rollout({ canaryNodeId: "removed" }) })).toEqual({
			go: true,
			canary: true,
		});
	});

	it("starts a new rollout for a newer release", () => {
		expect(
			gate({
				target: "2.333.0",
				rollout: rollout({ passedAt: iso(-MINUTE) }),
			}),
		).toEqual({ go: true, canary: true });
	});

	it("updates a few machines at a time", () => {
		const machines = [updating("m6"), machine("m4"), machine("build-1")];
		expect(gate({ machines, rollout: rollout({ passedAt: iso(0) }) })).toEqual({
			go: false,
			reason: "m6 is updating (1 machine at a time)",
		});
		expect(
			gate({
				machines,
				rollout: rollout({ passedAt: iso(0) }),
				policy: { maxUnavailable: 2, canary: true },
			}),
		).toEqual({ go: true, canary: false });
		// An update left by a process that died does not hold the place forever.
		expect(
			gate({
				machines: [updating("m6", UPDATE_STALE_MS / MINUTE + 1), machine("m4")],
				rollout: rollout({ passedAt: iso(0) }),
			}),
		).toEqual({ go: true, canary: false });
	});

	it("lets urgent updates skip the canary, not the limit", () => {
		for (const reason of ["required", "deadline"] as const) {
			expect(gate({ reason, rollout: rollout() })).toEqual({
				go: true,
				canary: false,
			});
			expect(
				gate({ reason, machines: [updating("m6"), machine("m4")] }).go,
			).toBe(false);
		}
		// "Update now": the operator decides.
		expect(
			gate({
				reason: "requested",
				rollout: rollout({ failedAt: iso(0) }),
				machines: [updating("m6"), machine("m4")],
			}),
		).toEqual({ go: true, canary: false });
	});

	it("rolls OS updates one machine at a time, without a canary", () => {
		expect(gate({ kind: "os", target: "os", rollout: rollout() })).toEqual({
			go: true,
			canary: false,
		});
		expect(
			gate({
				kind: "os",
				target: "os",
				machines: [updating("m6"), machine("m4")],
			}).go,
		).toBe(false);
	});

	it("follows the canary from install to soak", () => {
		const fresh = rollout();
		const installed = canaryProgress({
			rollout: fresh,
			installed: "2.332.0",
			healthy: false,
			now,
		});
		expect(installed).toMatchObject({ installedAt: iso(0), failedAt: null });
		expect(
			canaryProgress({
				rollout: fresh,
				installed: "2.331.0",
				healthy: true,
				now,
			}),
		).toBeNull();
		const soaking = rollout({ installedAt: iso(-CANARY_SOAK_MS + MINUTE) });
		expect(
			canaryProgress({
				rollout: soaking,
				installed: "2.332.0",
				healthy: true,
				now,
			}),
		).toBeNull();
		expect(
			canaryProgress({
				rollout: rollout({ installedAt: iso(-CANARY_SOAK_MS) }),
				installed: "2.332.0",
				healthy: true,
				now,
			}),
		).toMatchObject({ passedAt: iso(0) });
	});

	it("pauses a canary that never gets healthy, until resumed", () => {
		const stuck = canaryProgress({
			rollout: rollout({ installedAt: iso(-CANARY_GIVE_UP_MS) }),
			installed: "2.332.0",
			healthy: false,
			now,
		});
		expect(stuck?.failedAt).toBe(iso(0));
		expect(stuck?.error).toContain("no runner of the canary came online");
		// It stays paused, even once healthy: an operator resumes it.
		expect(
			canaryProgress({
				rollout: stuck as GithubRunnerRollout,
				installed: "2.332.0",
				healthy: true,
				now: now + MINUTE,
			}),
		).toBeNull();
		// A failed update (nothing installed) that a retry installs starts over.
		expect(
			canaryProgress({
				rollout: rollout({ failedAt: iso(-MINUTE), error: "x" }),
				installed: "2.332.0",
				healthy: true,
				now,
			}),
		).toMatchObject({ installedAt: iso(0), failedAt: null, error: null });
	});
});

describe("update window end", () => {
	const window = {
		days: [1, 2, 3, 4, 5],
		start: "01:00",
		end: "04:00",
		timeZone: "Europe/Paris",
	};
	it("finds when the open window closes, past midnight too", () => {
		// Thursday 2026-10-22 02:30 in Paris (UTC+2).
		expect(
			updateWindowEnd(window, new Date("2026-10-22T00:30:00Z"))?.toISOString(),
		).toBe("2026-10-22T02:00:00.000Z");
		expect(
			updateWindowEnd(window, new Date("2026-10-22T08:00:00Z")),
		).toBeNull();
		expect(updateWindowEnd(null, new Date(now))).toBeNull();
		const overnight = { ...window, days: [4], start: "23:00", end: "02:00" };
		expect(
			updateWindowEnd(
				overnight,
				new Date("2026-10-22T21:30:00Z"),
			)?.toISOString(),
		).toBe("2026-10-23T00:00:00.000Z");
	});

	it("keeps the OS updates setting optional in stored policies", () => {
		expect(updatePolicySchema.parse({ auto: true, window: null })).toEqual({
			auto: true,
			window: null,
		});
		expect(
			updatePolicySchema.parse({ auto: true, window: null, osPatches: true })
				.osPatches,
		).toBe(true);
	});
});

const prefix = "dkp-m6-";
const ghRunner = (name: string, overrides: Partial<GithubRunner> = {}) =>
	({
		id: Number.parseInt(name.slice(-2), 16) || 1,
		name,
		os: "Linux",
		status: "offline",
		busy: false,
		labels: ["self-hosted", "Linux", "ARM64", "flots"],
		customLabels: ["flots"],
		version: null,
		...overrides,
	}) as GithubRunner;
const spare = (slot: number, name: string, ageMs = 10 * MINUTE) => ({
	slot,
	name: `${prefix}${slot}-${name}`,
	createdAt: Math.floor((now - ageMs) / 1000),
});

describe("machine reserve", () => {
	const plan = (overrides: Partial<Parameters<typeof planSpares>[0]> = {}) =>
		planSpares({
			now,
			accepting: true,
			maxRunners: 2,
			reserve: 2,
			spares: [],
			runners: [],
			isStale: () => false,
			...overrides,
		});

	it("fills every slot evenly, a few registrations per tick", () => {
		expect(plan()).toEqual([
			{ type: "add", slot: 1 },
			{ type: "add", slot: 2 },
		]);
		expect(plan({ limit: 10 })).toEqual([
			{ type: "add", slot: 1 },
			{ type: "add", slot: 2 },
			{ type: "add", slot: 1 },
			{ type: "add", slot: 2 },
		]);
		expect(MAX_SPARES_PER_TICK).toBe(2);
		const full = [
			spare(1, "aa"),
			spare(1, "ab"),
			spare(2, "ac"),
			spare(2, "ad"),
		];
		expect(
			plan({ spares: full, runners: full.map((item) => ghRunner(item.name)) }),
		).toEqual([]);
	});

	it("waits for GitHub before adding any", () => {
		expect(plan({ runners: null })).toEqual([]);
	});

	it("drops the whole reserve of a machine that takes no job", () => {
		const spares = [spare(1, "aa")];
		expect(
			plan({ accepting: false, spares, runners: [ghRunner(spares[0]!.name)] }),
		).toEqual([
			{
				type: "drop",
				slot: 1,
				name: "dkp-m6-1-aa",
				runnerId: 0xaa,
				reason: "machine takes no job",
			},
		]);
		expect(plan({ reserve: 0, spares })[0]).toMatchObject({
			type: "drop",
			reason: "reserve turned off",
		});
	});

	it("replaces registrations before GitHub forgets them", () => {
		const old = spare(1, "aa", SPARE_ROTATE_MS);
		const actions = plan({
			reserve: 1,
			maxRunners: 1,
			spares: [old],
			runners: [ghRunner(old.name)],
		});
		expect(actions).toEqual([
			expect.objectContaining({
				type: "drop",
				reason: "replaced before it expires",
			}),
			{ type: "add", slot: 1 },
		]);
	});

	it("drops what GitHub no longer lists, once it had time to list it", () => {
		const recent = spare(1, "aa", MINUTE);
		const older = spare(2, "ab", 5 * MINUTE);
		const actions = plan({ reserve: 1, spares: [recent, older], runners: [] });
		expect(actions).toEqual([
			expect.objectContaining({
				name: older.name,
				runnerId: null,
				reason: "no longer registered on GitHub",
			}),
			{ type: "add", slot: 2 },
		]);
	});

	it("drops stale, surplus and out-of-range registrations", () => {
		const stale = spare(1, "aa");
		const extra = [spare(1, "ab", 5 * MINUTE), spare(1, "ac", 20 * MINUTE)];
		const high = spare(3, "ad");
		const all = [stale, ...extra, high];
		const actions = plan({
			reserve: 1,
			spares: all,
			runners: all.map((item) => ghRunner(item.name)),
			isStale: (runner) => runner.name === stale.name,
		});
		expect(
			actions
				.filter((action) => action.type === "drop")
				.map((action) => [
					action.type === "drop" && action.name,
					action.type === "drop" && action.reason,
				]),
		).toEqual([
			["dkp-m6-1-aa", "runner settings changed"],
			["dkp-m6-3-ad", "above the concurrency limit"],
			["dkp-m6-1-ac", "more than the reserve"],
		]);
	});

	it("keeps reserved registrations out of the runners the planner forgets", () => {
		const reserved = ghRunner(`${prefix}2-aa`);
		const leftover = ghRunner(`${prefix}2-bb`, { id: 7 });
		const result = planNode({
			now,
			node: {
				enabled: true,
				phase: "ready",
				drain: null,
				maxRunners: 0,
				namePrefix: prefix,
				labels: ["self-hosted"],
				runnerVersion: null,
				admission: { ok: true },
				maxArmsPerTick: 4,
			},
			slots: [],
			runners: [reserved, leftover],
			spares: [reserved.name],
		});
		expect(result.actions).toEqual([
			expect.objectContaining({ type: "forget", runnerId: 7 }),
		]);
	});

	it("reads the reserve and the autonomous arming from the runtime", () => {
		const status = parseRuntimeStatus(
			parseRecords(
				[
					"runtime version=7",
					"spare slot=1 name=dkp-m6-1-aaaaaa created=1792656000",
					"spare slot=2 name=bad;name created=1792656000",
					"autonomy armed=3 last=1792659600",
				].join("\n"),
			),
		);
		expect(status.spares).toEqual([
			{ slot: 1, name: "dkp-m6-1-aaaaaa", createdAt: 1792656000 },
		]);
		expect(status.autonomy).toEqual({ armed: 3, last: 1792659600 });
		expect(
			parseRuntimeStatus(parseRecords("runtime version=7")).autonomy,
		).toBeNull();
	});
});

describe("OS updates", () => {
	it("installs with apt, keeping the configuration, and tells about a reboot", () => {
		const script = osPatchScript();
		expect(script).toContain("--force-confold");
		expect(script).toContain("--with-new-pkgs upgrade");
		expect(script).not.toContain("autoremove");
		expect(spawnSync("bash", ["-n"], { input: script }).status).toBe(0);
		expect(parsePatchResult("…\npatched boot=abc-123 reboot=yes\n")).toEqual({
			bootId: "abc-123",
			reboot: true,
		});
		expect(parsePatchResult("E: broken")).toBeNull();
	});

	it("alerts on failed OS updates and on a paused rollout", () => {
		const pool = {
			githubRunnerPoolId: "pool",
			name: "Flots CI",
			authType: "app",
			runnerVersion: null,
			updatePolicy: { auto: true, window: null, osPatches: true },
			routingVariable: null,
			routing: null,
			fallbackLabels: ["ubuntu-24.04"],
			rollouts: {
				runner: rollout({ failedAt: iso(0), error: "download failed" }),
			},
		} as unknown as GithubRunnerPool;
		const node = {
			githubRunnerNodeId: "m6",
			githubRunnerPoolId: "pool",
			name: "m6",
			host: "m6",
			platform: "linux",
			enabled: true,
			phase: "ready",
			drain: null,
			lastSeenAt: iso(0),
			updatePolicy: null,
			updateState: { patchError: "apt-get failed", patchErrorAt: iso(0) },
			osReport: {
				at: iso(0),
				host: {
					id: "ubuntu",
					version: "24.04",
					build: null,
					kernel: "",
					updates: 3,
					security: 0,
					reboot: false,
					listsAt: iso(0),
				},
				guest: null,
			},
			firewall: null,
			observed: {
				at: iso(0),
				reachable: true,
				admission: { ok: true },
				slots: [],
				runtime: { version: 7, runnerVersion: null },
			},
		} as unknown as GithubRunnerNode;
		const alerts = runnerAlertConditions({
			pool,
			nodes: [node],
			now,
			runnerReleases: [],
			osReleases: () => [],
			token: null,
		});
		expect(alerts.map((alert) => [alert.subject, alert.title])).toEqual([
			["m6:os-patch", "OS updates failed on m6"],
			[
				"pool:rollout-runner",
				"Flots CI: rollout of actions/runner 2.332.0 paused",
			],
		]);
	});
});

describe("review fixes", () => {
	const plannerNode = {
		enabled: true,
		phase: "ready",
		drain: null,
		maxRunners: 2,
		namePrefix: prefix,
		labels: ["self-hosted", "Linux", "ARM64", "flots"],
		runnerVersion: null,
		admission: { ok: true },
		maxArmsPerTick: 4,
	};
	const live = (slot: number, name: string) => ({
		slot,
		active: "active",
		since: Math.floor(now / 1000) - 600,
		runnerName: name,
		job: null,
	});

	it("releases idle runners while the firewall is not in place", () => {
		const idle = ghRunner(`${prefix}1-aa`, { id: 1, status: "online" });
		const busy = ghRunner(`${prefix}2-bb`, {
			id: 2,
			status: "online",
			busy: true,
		});
		const blocked = planNode({
			now,
			node: {
				...plannerNode,
				admission: { ok: false, reason: "firewall" },
				stopIdle: 'Firewall "Internet only" not applied',
			},
			slots: [live(1, idle.name), live(2, busy.name)],
			runners: [idle, busy],
		});
		expect(blocked.actions).toEqual([
			{
				type: "release",
				slot: 1,
				runnerId: 1,
				reason: 'Firewall "Internet only" not applied',
			},
		]);
		// A disk below the reserve only stops new runners.
		const disk = planNode({
			now,
			node: { ...plannerNode, admission: { ok: false, reason: "disk" } },
			slots: [live(1, idle.name), live(2, busy.name)],
			runners: [idle, busy],
		});
		expect(disk.actions).toEqual([]);
	});

	it("never lets a machine refused jobs arm itself", () => {
		const setting = (admitted: boolean, accepting = true) =>
			autonomySetting({
				accepting,
				admitted,
				reserve: 2,
				maxRunners: 3,
				minFreeKib: 1024,
				firewall: "host",
			});
		expect(setting(true)).toBe("on 3 1024 host");
		expect(setting(false)).toBe("off");
		expect(setting(true, false)).toBe("off");
	});

	it("counts a machine draining for OS updates as updating, whatever its state", () => {
		const draining = machine("m6", { drain: { reason: "patch" } });
		expect(
			gate({ kind: "os", target: "os", machines: [draining, machine("m4")] }),
		).toEqual({ go: false, reason: "m6 is updating (1 machine at a time)" });
		// Even after its update state was lost, and long after it started.
		expect(
			gate({
				kind: "os",
				target: "os",
				machines: [
					machine("m6", {
						drain: { reason: "patch" },
						updateState: {
							inProgress: {
								kind: "os",
								target: "os",
								startedAt: iso(-UPDATE_STALE_MS - MINUTE),
							},
						},
					}),
					machine("m4"),
				],
			}).go,
		).toBe(false);
		expect(
			gate({
				kind: "os",
				target: "os",
				machines: [
					machine("m6", { drain: { reason: "disable" } }),
					machine("m4"),
				],
			}).go,
		).toBe(true);
	});

	it("keeps every field of a machine's update policy in its editor", () => {
		const updates = {
			inherited: false,
			auto: true,
			window: null,
			description: "any time",
			open: true,
			requestedAt: null,
			error: null,
			inProgress: null,
			osPatches: true,
			patchedAt: null,
			patchError: null,
		};
		expect(
			machineUpdatePolicy({ updates } as unknown as RunnerMachine),
		).toEqual({
			auto: true,
			window: null,
			osPatches: true,
		});
	});
});

describe("review fixes, warnings", () => {
	const pool = (overrides: Record<string, unknown> = {}) =>
		({
			githubRunnerPoolId: "pool",
			name: "Flots CI",
			authType: "app",
			runnerVersion: null,
			updatePolicy: { auto: true, window: null, osPatches: true },
			routingVariable: null,
			routing: null,
			fallbackLabels: ["ubuntu-24.04"],
			rollouts: {},
			...overrides,
		}) as unknown as GithubRunnerPool;
	const ubuntu = (updates: number) => ({
		id: "ubuntu",
		version: "20.04",
		build: null,
		kernel: "",
		updates,
		security: 0,
		reboot: false,
		listsAt: iso(0),
	});
	const node = (overrides: Record<string, unknown> = {}) =>
		({
			githubRunnerNodeId: "m6",
			githubRunnerPoolId: "pool",
			name: "m6",
			host: "m6",
			platform: "linux",
			enabled: true,
			phase: "ready",
			drain: null,
			lastSeenAt: iso(0),
			updatePolicy: null,
			updateState: null,
			osReport: { at: iso(0), host: ubuntu(0), guest: null },
			firewall: null,
			observed: {
				at: iso(0),
				reachable: true,
				admission: { ok: true },
				slots: [],
				runtime: { version: 7, runnerVersion: "2.320.0" },
			},
			...overrides,
		}) as unknown as GithubRunnerNode;
	const oldRelease = [
		{ version: "2.321.0", publishedAt: iso(-40 * 24 * 60 * MINUTE) },
	];
	const ended = [
		{ name: "20.04", isEol: true, eolFrom: "2025-05-31", latest: null },
	];
	const alerts = (
		nodes: GithubRunnerNode[],
		overrides: Partial<Parameters<typeof runnerAlerts>[0]> = {},
	) =>
		runnerAlerts({
			pool: pool(),
			nodes,
			now,
			runnerReleases: oldRelease,
			osReleases: () => ended,
			token: null,
			...overrides,
		});
	const subjects = (result: ReturnType<typeof runnerAlerts>) => ({
		conditions: result.conditions.map((item) => item.subject),
		unknown: result.unknown,
	});

	it("keeps what a process that just took the lead cannot tell yet", () => {
		expect(subjects(alerts([node()]))).toEqual({
			conditions: ["m6:runner-version", "m6:os-host"],
			unknown: [],
		});
		// Releases, support dates and the token check not read yet.
		expect(
			subjects(
				alerts([node()], {
					pool: pool({ authType: "token" }),
					runnerReleases: [],
					osReleases: () => null,
				}),
			),
		).toEqual({
			conditions: [],
			unknown: ["m6:runner-version", "m6:os-host", "pool:token"],
		});
		// No OS report (VM stopped, report failed): what was known holds.
		expect(subjects(alerts([node({ osReport: null })])).unknown).toEqual([
			"m6:os-host",
		]);
	});

	it("leaves disabled machines alone about their runner", () => {
		expect(
			subjects(alerts([node({ enabled: false, phase: "stopped" })])),
		).toEqual({ conditions: ["m6:os-host"], unknown: [] });
	});

	it("tells a failed OS update only while Dokploy would still install it", () => {
		const failed = { patchError: "apt-get failed", patchErrorAt: iso(0) };
		const withUpdates = {
			at: iso(0),
			host: { ...ubuntu(3), version: "24.04" },
			guest: null,
		};
		const kinds = (...args: Parameters<typeof alerts>) =>
			alerts(...args).conditions.map((item) => item.kind);
		expect(
			kinds([node({ updateState: failed, osReport: withUpdates })]),
		).toContain("os-patch");
		// Installed by hand, or OS updates turned off: nothing left to tell.
		expect(
			kinds([
				node({
					updateState: failed,
					osReport: {
						...withUpdates,
						host: { ...withUpdates.host, updates: 0 },
					},
				}),
			]),
		).not.toContain("os-patch");
		expect(
			kinds([node({ updateState: failed, osReport: withUpdates })], {
				pool: pool({ updatePolicy: { auto: true, window: null } }),
			}),
		).not.toContain("os-patch");
	});

	it("does not take planned OS updates for a lack of capacity", () => {
		const patching = node({
			phase: "draining",
			drain: { reason: "patch", mode: "wait" },
		});
		expect(
			alerts([patching]).conditions.map((item) => item.kind),
		).not.toContain("no-capacity");
		const stuck = node({
			observed: {
				at: iso(0),
				reachable: false,
				admission: { ok: true },
				slots: [],
			},
		});
		expect(alerts([stuck]).conditions.map((item) => item.kind)).toContain(
			"no-capacity",
		);
	});

	it("encodes ntfy headers that HTTP cannot carry", () => {
		expect(ntfyHeaderValue("m6 is unreachable")).toBe("m6 is unreachable");
		const encoded = ntfyHeaderValue("Flots – CI: no machine takes jobs 🚀");
		expect(encoded).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
		expect(Buffer.from(encoded.slice(10, -2), "base64").toString("utf8")).toBe(
			"Flots – CI: no machine takes jobs 🚀",
		);
		expect(() => new Headers({ "X-Title": encoded })).not.toThrow();
	});

	it("lets OS updates finish before another update on the machine", () => {
		const patching = machine("m4", { drain: { reason: "patch" } });
		for (const reason of ["requested", "required", "anytime"] as const) {
			expect(
				gate({
					reason,
					kind: "runtime",
					target: "7",
					machines: [machine("m6"), patching],
				}),
			).toEqual({ go: false, reason: "OS updates run on this machine first" });
		}
	});

	it("keeps a failed rollout paused once its canary is disabled or removed", () => {
		const failed = rollout({ failedAt: iso(-MINUTE), error: "x" });
		expect(
			gate({
				rollout: failed,
				machines: [machine("m6", { enabled: false }), machine("m4")],
			}),
		).toEqual({
			go: false,
			reason: "the rollout of 2.332.0 is paused: it failed on m6",
		});
		expect(gate({ rollout: { ...failed, canaryNodeId: "removed" } })).toEqual({
			go: false,
			reason:
				"the rollout of 2.332.0 is paused: it failed on a removed machine",
		});
	});
});
