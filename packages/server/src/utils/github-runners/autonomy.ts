/**
 * A machine keeps runner registrations in reserve, for each of its slots, and
 * arms itself with them while no controller answers (runnerctl autoarm, run by
 * a timer on the machine). Each one is a JIT runner registered on GitHub and
 * not started yet: single use, scoped to the pool's runner group, and removed
 * by GitHub after a day offline. The controller keeps the reserve full and
 * fresh; this plans it.
 */
import type { GithubRunner } from "./github-api";
import { SPARE_MAX_AGE_S } from "./runtime";

/** Replaced before the machine stops using it (SPARE_MAX_AGE_S). */
export const SPARE_ROTATE_MS = (SPARE_MAX_AGE_S - 2 * 60 * 60) * 1000;
/** Registrations added per machine and tick: GitHub's API is shared. */
export const MAX_SPARES_PER_TICK = 2;
/** GitHub may list a new registration a little later: missing only after this. */
const LISTING_DELAY_MS = 2 * 60_000;

export interface LocalSpare {
	slot: number;
	name: string;
	/** Epoch seconds. */
	createdAt: number;
}

export type SpareAction =
	| { type: "add"; slot: number }
	| {
			type: "drop";
			slot: number;
			name: string;
			/** Its registration on GitHub, when GitHub still lists it. */
			runnerId: number | null;
			reason: string;
	  };

export const planSpares = (input: {
	now: number;
	/** A machine that takes no job (disabled, draining) keeps no reserve. */
	accepting: boolean;
	maxRunners: number;
	/** Registrations wanted per slot. */
	reserve: number;
	spares: LocalSpare[];
	/** GitHub's runners of the machine; null when GitHub could not be read. */
	runners: GithubRunner[] | null;
	isStale: (runner: GithubRunner) => boolean;
	limit?: number;
}): SpareAction[] => {
	const { now, reserve, maxRunners } = input;
	const byName = new Map(
		(input.runners ?? []).map((runner) => [runner.name, runner]),
	);
	const actions: SpareAction[] = [];
	const drop = (spare: LocalSpare, reason: string) =>
		actions.push({
			type: "drop",
			slot: spare.slot,
			name: spare.name,
			runnerId: byName.get(spare.name)?.id ?? null,
			reason,
		});
	if (!input.accepting || reserve === 0) {
		for (const spare of input.spares) {
			drop(
				spare,
				input.accepting ? "reserve turned off" : "machine takes no job",
			);
		}
		return actions;
	}
	const kept = new Map<number, LocalSpare[]>();
	for (const spare of [...input.spares].sort(
		(a, b) => b.createdAt - a.createdAt,
	)) {
		const runner = byName.get(spare.name);
		const list = kept.get(spare.slot) ?? [];
		if (spare.slot > maxRunners) drop(spare, "above the concurrency limit");
		else if (now - spare.createdAt * 1000 >= SPARE_ROTATE_MS) {
			drop(spare, "replaced before it expires");
		} else if (
			input.runners &&
			!runner &&
			now - spare.createdAt * 1000 >= LISTING_DELAY_MS
		) {
			drop(spare, "no longer registered on GitHub");
		} else if (runner && input.isStale(runner)) {
			drop(spare, "runner settings changed");
		} else if (list.length >= reserve) drop(spare, "more than the reserve");
		else {
			list.push(spare);
			kept.set(spare.slot, list);
		}
	}
	// New registrations need GitHub; slots are filled evenly, a round at a time.
	if (!input.runners) return actions;
	const limit = input.limit ?? MAX_SPARES_PER_TICK;
	let added = 0;
	for (let round = 0; round < reserve && added < limit; round++) {
		for (let slot = 1; slot <= maxRunners && added < limit; slot++) {
			if ((kept.get(slot)?.length ?? 0) + countAdds(actions, slot) > round) {
				continue;
			}
			actions.push({ type: "add", slot });
			added++;
		}
	}
	return actions;
};

const countAdds = (actions: SpareAction[], slot: number) =>
	actions.filter((action) => action.type === "add" && action.slot === slot)
		.length;
