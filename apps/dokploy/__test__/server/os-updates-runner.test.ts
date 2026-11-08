/**
 * The drain an OS update run puts on a GitHub runner machine, as the runner
 * controller's pure pieces see it: the planner never interrupts a job under
 * it, the machine is handed over only once empty and unable to arm itself,
 * and the runner controller's own updates wait for it. The run itself, on a
 * real database, is in __test__/db/os-update-runner.db.test.ts.
 */
import type { GithubRunnerDrain } from "@dokploy/server/db/schema";
import type { GithubRunner } from "@dokploy/server/utils/github-runners/github-api";
import type { LocalSlot } from "@dokploy/server/utils/github-runners/probe";
import {
	planNode,
	runnerNamePrefix,
} from "@dokploy/server/utils/github-runners/reconcile";
import {
	rolloutGate,
	updatingMachines,
} from "@dokploy/server/utils/github-runners/rollout";
import { keyOf, machineOf } from "@dokploy/server/utils/os-updates/controller";
import {
	assertNotInstallingOsUpdates,
	isOsUpdateDrain,
	isOsUpdateInstalling,
	osUpdateDrainComplete,
} from "@dokploy/server/utils/os-updates/runner-drain";
import { describe, expect, it } from "vitest";

const now = Date.parse("2026-11-08T02:30:00.000Z");
const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();

const drain = (
	overrides: Partial<GithubRunnerDrain> = {},
): GithubRunnerDrain => ({
	mode: "wait",
	reason: "os-update",
	requestedAt: iso(-60_000),
	deadline: null,
	operationId: null,
	abortAt: iso(60 * 60_000),
	osUpdateRunId: "run-1",
	drainedAt: null,
	installingAt: null,
	...overrides,
});

const prefix = runnerNamePrefix("lx1");

const slot = (state: "busy" | "idle" | "done"): LocalSlot => ({
	slot: 1,
	active: state === "done" ? "inactive" : "active",
	since: Math.floor(now / 1000) - 900,
	runnerName: `${prefix}1-abc123`,
	job:
		state === "idle"
			? null
			: {
					repository: "example/ci",
					runId: "42",
					runAttempt: "1",
					workflow: "CI",
					job: "build",
					startedAt: iso(-900_000),
					completedAt: state === "done" ? iso(-1_000) : null,
				},
});

const runner = (busy: boolean): GithubRunner => ({
	id: 7,
	name: `${prefix}1-abc123`,
	os: "Linux",
	status: "online",
	busy,
	labels: ["self-hosted", "Linux"],
	customLabels: [],
	version: "2.330.0",
});

const plan = (
	current: GithubRunnerDrain | null,
	slots: LocalSlot[],
	runners: GithubRunner[],
	at = now,
) =>
	planNode({
		now: at,
		node: {
			enabled: true,
			phase: current ? "draining" : "ready",
			drain: current,
			maxRunners: 2,
			namePrefix: prefix,
			labels: ["self-hosted", "Linux"],
			runnerVersion: null,
			admission: { ok: true },
			maxArmsPerTick: 4,
		},
		slots,
		runners,
	});

describe("the planner under an OS update drain", () => {
	it("leaves a running job alone and starts no runner", () => {
		const result = plan(drain(), [slot("busy")], [runner(true)]);
		expect(result.actions).toEqual([]);
		expect(result.busy).toBe(1);
	});

	it("never interrupts it, even past the end of the window", () => {
		const late = plan(
			drain({ abortAt: iso(-60_000) }),
			[slot("busy")],
			[runner(true)],
			now + 24 * 60 * 60_000,
		);
		expect(late.actions.some((action) => action.type === "stop")).toBe(false);
	});

	it("sends an idle runner away (GitHub refuses if it just took a job)", () => {
		expect(plan(drain(), [slot("idle")], [runner(false)]).actions).toEqual([
			{
				type: "release",
				slot: 1,
				runnerId: 7,
				reason: "draining",
			},
		]);
	});

	it("finds the machine empty only when no runner runs and GitHub sees no job", () => {
		expect(plan(drain(), [], [runner(true)]).actions).toEqual([]);
		expect(plan(drain(), [], []).actions).toEqual([{ type: "drained" }]);
	});

	it("arms runners again once the drain is gone", () => {
		expect(
			plan(null, [], []).actions.filter((action) => action.type === "arm"),
		).toHaveLength(2);
	});
});

describe("the hand-over to the run", () => {
	const runtime = (autonomySetting: string | null, runtimeVersion = 9) => ({
		runtimeVersion,
		autonomySetting,
	});

	it("needs an empty machine that can no longer arm itself", () => {
		expect(
			osUpdateDrainComplete({
				drained: true,
				runtime: runtime("off"),
				autonomyRuntime: 7,
			}),
		).toBe(true);
		expect(
			osUpdateDrainComplete({
				drained: false,
				runtime: runtime("off"),
				autonomyRuntime: 7,
			}),
		).toBe(false);
		// Still allowed to arm itself (the "off" not written yet).
		expect(
			osUpdateDrainComplete({
				drained: true,
				runtime: runtime("on 2 1024 none"),
				autonomyRuntime: 7,
			}),
		).toBe(false);
		// A runtime that did not answer proves nothing.
		expect(
			osUpdateDrainComplete({
				drained: true,
				runtime: null,
				autonomyRuntime: 7,
			}),
		).toBe(false);
		// Runtimes older than autonomy cannot arm themselves.
		expect(
			osUpdateDrainComplete({
				drained: true,
				runtime: runtime(null, 6),
				autonomyRuntime: 7,
			}),
		).toBe(true);
	});

	it("tells an install apart from the wait for the jobs", () => {
		expect(isOsUpdateDrain(drain())).toBe(true);
		expect(isOsUpdateDrain({ ...drain(), reason: "patch" })).toBe(false);
		expect(isOsUpdateInstalling(drain())).toBe(false);
		expect(isOsUpdateInstalling(drain({ installingAt: iso(0) }))).toBe(true);
		expect(() =>
			assertNotInstallingOsUpdates({ name: "lx1", drain: drain() }),
		).not.toThrow();
		expect(() =>
			assertNotInstallingOsUpdates({
				name: "lx1",
				drain: drain({ installingAt: iso(0) }),
			}),
		).toThrow(/OS updates are being installed on lx1/);
	});
});

describe("the runner controller's own updates", () => {
	const machine = (id: string, current: GithubRunnerDrain | null = null) => ({
		githubRunnerNodeId: id,
		name: id,
		enabled: true,
		updateState: null,
		drain: current,
	});

	it("count a machine drained for OS updates as one out", () => {
		expect(
			updatingMachines(
				[machine("lx1", drain()), machine("lx2")],
				"lx2",
				now,
			).map((item) => item.name),
		).toEqual(["lx1"]);
		expect(
			rolloutGate({
				kind: "runner",
				target: "2.332.0",
				reason: "anytime",
				selfId: "lx2",
				policy: { maxUnavailable: 1, canary: false },
				rollout: undefined,
				machines: [machine("lx1", drain()), machine("lx2")],
				now,
			}),
		).toEqual({ go: false, reason: "lx1 is updating (1 machine at a time)" });
	});

	it("wait on the drained machine itself, Update now included", () => {
		expect(
			rolloutGate({
				kind: "runtime",
				target: "9",
				reason: "requested",
				selfId: "lx1",
				policy: { maxUnavailable: 1, canary: false },
				rollout: undefined,
				machines: [machine("lx1", drain())],
				now,
			}),
		).toEqual({ go: false, reason: "OS updates run on this machine first" });
	});
});

describe("the machine of a run", () => {
	it("is a server or a runner machine, never confused", () => {
		const server = machineOf({ serverId: "abc", githubRunnerNodeId: null });
		const node = machineOf({ serverId: null, githubRunnerNodeId: "abc" });
		expect(server).toEqual({ kind: "server", id: "abc" });
		expect(node).toEqual({ kind: "runner", id: "abc" });
		expect(keyOf(server)).not.toBe(keyOf(node));
	});
});
