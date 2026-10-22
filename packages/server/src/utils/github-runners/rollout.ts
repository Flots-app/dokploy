/**
 * Rolling updates: a pool updates a few machines at a time (one by default),
 * so the others keep taking jobs, and a new release reaches one machine first,
 * its canary. The others follow once the canary has run it healthily for a
 * while; a failed canary pauses the rollout until an operator resumes it.
 */
import type {
	GithubRunnerRollout,
	GithubRunnerRolloutPolicy,
	GithubRunnerUpdateKind,
	GithubRunnerUpdateState,
} from "@dokploy/server/db/schema";
import type { UpdateReason } from "./updates";

/** The canary runs the new release this long before the others follow. */
export const CANARY_SOAK_MS = 10 * 60_000;
/** A canary that runs the release without a runner online this long fails. */
export const CANARY_GIVE_UP_MS = 30 * 60_000;
/** An update still marked running after this long was left by a dead process. */
export const UPDATE_STALE_MS = 2 * 60 * 60_000;

export const UPDATE_KIND_LABELS: Record<GithubRunnerUpdateKind, string> = {
	runner: "actions/runner",
	runtime: "the Dokploy runtime",
	os: "OS updates",
};

export interface RolloutMachine {
	githubRunnerNodeId: string;
	name: string;
	enabled: boolean;
	updateState: GithubRunnerUpdateState | null;
}

export type RolloutGate =
	| {
			go: true;
			/** This machine leads the rollout of the release. */
			canary: boolean;
	  }
	| { go: false; reason: string };

/** Machines of the pool counted as updating now, this one aside. */
export const updatingMachines = (
	machines: RolloutMachine[],
	selfId: string,
	now: number,
) =>
	machines.filter((machine) => {
		const started = machine.updateState?.inProgress?.startedAt;
		return (
			machine.githubRunnerNodeId !== selfId &&
			started !== undefined &&
			now - Date.parse(started) < UPDATE_STALE_MS
		);
	});

/**
 * Whether a machine may start an update now. "Update now" goes ahead
 * whatever the rollout; a required runtime and a runner about to be refused by
 * GitHub skip the canary, not the limit of machines at a time.
 */
export const rolloutGate = (input: {
	kind: GithubRunnerUpdateKind;
	target: string;
	reason: UpdateReason;
	selfId: string;
	policy: GithubRunnerRolloutPolicy;
	rollout: GithubRunnerRollout | undefined;
	machines: RolloutMachine[];
	now: number;
}): RolloutGate => {
	const { selfId, rollout } = input;
	if (input.reason === "requested") return { go: true, canary: false };
	const busy = updatingMachines(input.machines, selfId, input.now);
	if (busy.length >= Math.max(1, input.policy.maxUnavailable)) {
		return {
			go: false,
			reason: `${busy.map((machine) => machine.name).join(", ")} ${busy.length === 1 ? "is" : "are"} updating (${input.policy.maxUnavailable} machine${input.policy.maxUnavailable === 1 ? "" : "s"} at a time)`,
		};
	}
	if (
		input.kind === "os" ||
		!input.policy.canary ||
		input.reason === "required" ||
		input.reason === "deadline"
	) {
		return { go: true, canary: false };
	}
	if (!rollout || rollout.target !== input.target) {
		return { go: true, canary: true };
	}
	if (rollout.canaryNodeId === selfId) return { go: true, canary: true };
	const canary = input.machines.find(
		(machine) => machine.githubRunnerNodeId === rollout.canaryNodeId,
	);
	// The canary left or was disabled: another machine leads.
	if (!canary?.enabled) return { go: true, canary: true };
	if (rollout.failedAt) {
		return {
			go: false,
			reason: `the rollout of ${input.target} is paused: it failed on ${canary.name}`,
		};
	}
	if (!rollout.passedAt) {
		return {
			go: false,
			reason: `${canary.name} runs ${input.target} first, as the canary`,
		};
	}
	return { go: true, canary: false };
};

/**
 * Where a canary stands, from what it runs now: the next state of the
 * rollout, or null when nothing changes.
 */
export const canaryProgress = (input: {
	rollout: GithubRunnerRollout;
	/** Release the canary reports. */
	installed: string | null;
	/** It answers, takes jobs and its runners come online. */
	healthy: boolean;
	now: number;
}): GithubRunnerRollout | null => {
	const { rollout, now } = input;
	if (rollout.passedAt || input.installed !== rollout.target) return null;
	const at = new Date(now).toISOString();
	if (!rollout.installedAt) {
		// Installed at last (a retry after a failed update included): the soak starts.
		return { ...rollout, installedAt: at, failedAt: null, error: null };
	}
	// Unhealthy once installed: paused until an operator resumes the rollout.
	if (rollout.failedAt) return null;
	const elapsed = now - Date.parse(rollout.installedAt);
	if (input.healthy && elapsed >= CANARY_SOAK_MS) {
		return { ...rollout, passedAt: at };
	}
	if (!input.healthy && elapsed >= CANARY_GIVE_UP_MS) {
		return {
			...rollout,
			failedAt: at,
			error: `no runner of the canary came online within ${CANARY_GIVE_UP_MS / 60_000} minutes of the update`,
		};
	}
	return null;
};
