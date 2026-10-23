import type {
	GithubRunnerDrain,
	GithubRunnerSlotObservation,
} from "@dokploy/server/db/schema";
import type { GithubRunner } from "./github-api";
import { RELEASE_AFTER_MS, type WaitingTarget } from "./placement";
import type { LocalSlot } from "./probe";

/** A runner that has not come online this long after its slot started is restarted. */
export const STARTUP_GRACE_MS = 3 * 60_000;

const RUNNING_STATES = new Set(["active", "activating", "reloading"]);

export interface PlannerNode {
	enabled: boolean;
	phase: string;
	drain: GithubRunnerDrain | null;
	/** Resolved concurrency (never "auto" here). */
	maxRunners: number;
	/** Every runner of the machine is named `<prefix><slot>-<suffix>`. */
	namePrefix: string;
	/** Labels the runners are registered with. */
	labels: string[];
	/** Runner release installed on the machine, to recycle idle runners after an upgrade. */
	runnerVersion: string | null;
	admission: { ok: boolean; reason?: string };
	/**
	 * Why no job may start on the machine at all (its firewall is not in
	 * place): idle runners leave too, not only new ones. A disk below the
	 * reserve only stops new runners.
	 */
	stopIdle?: string | null;
	maxArmsPerTick: number;
	/**
	 * Runners waiting for jobs on this machine (fastest-first placement across
	 * the pool); without it every free slot waits.
	 */
	waiting?: WaitingTarget;
}

export type PlannedAction =
	/** Register a JIT runner on GitHub and start it in this slot. */
	| { type: "arm"; slot: number }
	/**
	 * Unregister an idle runner, then stop its slot. GitHub refuses to unregister
	 * a runner that took a job meanwhile, which makes this safe against races.
	 */
	| { type: "release"; slot: number; runnerId: number; reason: string }
	/** Stop the slot now; a running job is cancelled. */
	| { type: "stop"; slot: number; runnerId: number | null; reason: string }
	/** Remove a GitHub registration no slot uses any more. */
	| { type: "forget"; runnerId: number; runnerName: string; reason: string }
	/** Draining finished: no slot runs any more. */
	| { type: "drained" };

export interface Plan {
	actions: PlannedAction[];
	slots: GithubRunnerSlotObservation[];
	busy: number;
	/** Active slots, including the ones stopping. */
	running: number;
}

export const runnerNamePrefix = (nodeName: string) => `dkp-${nodeName}-`;

export const slotOfRunner = (prefix: string, name: string) => {
	if (!name.startsWith(prefix)) return null;
	const match = name.slice(prefix.length).match(/^(\d{1,2})-[a-z0-9]+$/);
	return match ? Number(match[1]) : null;
};

/**
 * Whether a runner belongs to the machine with this prefix. A prefix alone is
 * not enough: "dkp-mac-" also starts the runners of a machine named "mac-2".
 */
export const isRunnerOf = (prefix: string, name: string) =>
	slotOfRunner(prefix, name) !== null;

const lower = (values: string[]) =>
	new Set(values.map((value) => value.toLowerCase()));

/**
 * An idle runner is recycled when its labels or release no longer match: GitHub
 * may add read-only labels, so only missing labels and unexpected custom ones count.
 */
export const isStale = (runner: GithubRunner, node: PlannerNode) => {
	const actual = lower(runner.labels);
	const wanted = lower(node.labels);
	if ([...wanted].some((label) => !actual.has(label))) return true;
	if (runner.customLabels.some((label) => !wanted.has(label.toLowerCase()))) {
		return true;
	}
	return Boolean(
		node.runnerVersion &&
			runner.status === "online" &&
			runner.version &&
			runner.version !== node.runnerVersion,
	);
};

export const isKillDrain = (drain: GithubRunnerDrain | null, now: number) =>
	Boolean(
		drain &&
			(drain.mode === "kill" ||
				(drain.deadline !== null && now >= Date.parse(drain.deadline))),
	);

/**
 * Decides what to do on a machine from what runs on it and what GitHub reports.
 * Pure, so every transition is unit-tested; the controller executes the plan.
 */
export const planNode = (input: {
	now: number;
	node: PlannerNode;
	slots: LocalSlot[];
	runners: GithubRunner[];
	/** Registrations the machine keeps in reserve: not started, never forgotten here. */
	spares?: string[];
}): Plan => {
	const { now, node } = input;
	const actions: PlannedAction[] = [];
	const observations: GithubRunnerSlotObservation[] = [];
	const runners = input.runners.filter((runner) =>
		isRunnerOf(node.namePrefix, runner.name),
	);
	const byName = new Map(runners.map((runner) => [runner.name, runner]));
	const kill = isKillDrain(node.drain, now);
	const accepting =
		node.enabled && node.phase === "ready" && node.drain === null;

	const live = input.slots.filter(
		(slot) => RUNNING_STATES.has(slot.active) || slot.active === "deactivating",
	);
	const attached = new Set<string>();
	let busyCount = 0;
	/** Slots whose runner waits for a job, or is starting to. */
	const waiting: {
		slot: number;
		runner: GithubRunner | undefined;
		age: number;
	}[] = [];

	for (const slot of [...live].sort((a, b) => a.slot - b.slot)) {
		const runner = slot.runnerName ? byName.get(slot.runnerName) : undefined;
		if (slot.runnerName) attached.add(slot.runnerName);
		const jobRunning = Boolean(slot.job && !slot.job.completedAt);
		const busy = Boolean(runner?.busy) || jobRunning;
		const age = slot.since ? now - slot.since * 1000 : 0;
		if (busy) busyCount++;

		observations.push({
			slot: slot.slot,
			state:
				slot.active === "deactivating"
					? "stopping"
					: busy
						? "busy"
						: slot.job?.completedAt
							? "exited"
							: runner?.status === "online"
								? "idle"
								: "starting",
			runnerName: slot.runnerName,
			runnerId: runner?.id ?? null,
			since: slot.since ? new Date(slot.since * 1000).toISOString() : null,
			job: slot.job
				? {
						repository: slot.job.repository,
						runId: slot.job.runId,
						runAttempt: slot.job.runAttempt,
						workflow: slot.job.workflow,
						job: slot.job.job,
						startedAt: slot.job.startedAt,
					}
				: null,
		});

		if (slot.active === "deactivating") continue;

		if (kill) {
			actions.push({
				type: "stop",
				slot: slot.slot,
				runnerId: runner?.id ?? null,
				reason: busy
					? "interrupting the running job"
					: "stopping the idle runner",
			});
			continue;
		}

		const stale = runner ? isStale(runner, node) : false;
		const wanted =
			accepting && !node.stopIdle && slot.slot <= node.maxRunners && !stale;
		if (!wanted) {
			// Never interrupt a job here: an ephemeral runner exits after its job.
			if (busy || slot.job?.completedAt) continue;
			if (runner) {
				actions.push({
					type: "release",
					slot: slot.slot,
					runnerId: runner.id,
					reason: stale
						? "runner settings changed"
						: node.stopIdle
							? node.stopIdle
							: node.drain
								? "draining"
								: !node.enabled
									? "machine disabled"
									: "above the concurrency limit",
				});
			} else {
				actions.push({
					type: "stop",
					slot: slot.slot,
					runnerId: null,
					reason: "runner no longer registered on GitHub",
				});
			}
			continue;
		}

		if (!busy && runner?.status !== "online" && age > STARTUP_GRACE_MS) {
			actions.push({
				type: "stop",
				slot: slot.slot,
				runnerId: runner?.id ?? null,
				reason: runner
					? "runner did not come online"
					: "runner registration disappeared",
			});
			continue;
		}
		if (!busy && !slot.job?.completedAt) {
			waiting.push({ slot: slot.slot, runner, age });
		}
	}

	// A faster machine has room: runners waiting here beyond the target leave,
	// the ones waiting longest first; GitHub refuses if one just took a job.
	if (node.waiting && accepting && waiting.length > node.waiting.keep) {
		const releasable = waiting
			.filter(
				(item) =>
					item.runner?.status === "online" &&
					!item.runner.busy &&
					item.age >= RELEASE_AFTER_MS,
			)
			.sort((a, b) => b.slot - a.slot)
			.slice(0, waiting.length - node.waiting.keep);
		for (const item of releasable) {
			if (!item.runner) continue;
			actions.push({
				type: "release",
				slot: item.slot,
				runnerId: item.runner.id,
				reason: "a faster machine has room",
			});
		}
	}

	const spares = new Set(input.spares ?? []);
	for (const runner of runners) {
		if (attached.has(runner.name) || spares.has(runner.name)) continue;
		// GitHub refuses to remove a busy runner; a crashed one goes offline first.
		if (runner.busy) continue;
		actions.push({
			type: "forget",
			runnerId: runner.id,
			runnerName: runner.name,
			reason:
				runner.status === "offline"
					? "registration left by a finished or stopped runner"
					: "runner not started by this machine",
		});
	}

	if (accepting && node.admission.ok) {
		const used = new Set(live.map((slot) => slot.slot));
		const limit = Math.min(
			node.maxArmsPerTick,
			node.waiting
				? Math.max(0, node.waiting.arm - waiting.length)
				: Number.POSITIVE_INFINITY,
		);
		let armed = 0;
		for (let slot = 1; slot <= node.maxRunners; slot++) {
			if (armed >= limit) break;
			if (used.has(slot)) continue;
			actions.push({ type: "arm", slot });
			armed++;
		}
	}

	if (node.drain && live.length === 0) {
		actions.push({ type: "drained" });
	}

	return {
		actions,
		slots: observations,
		busy: busyCount,
		running: live.length,
	};
};
