/**
 * Fastest-first placement. GitHub hands a queued job to any idle runner with
 * its labels, so Dokploy decides where jobs land by choosing where runners
 * wait: only on the slots where a new job would run fastest. When those are
 * taken, the next best slots are armed at the next tick.
 */

/** Cores a typical CI job keeps busy: a job alone on a big machine gains little beyond. */
export const JOB_PARALLELISM = 4;
/**
 * A slot waits for jobs when it is at least this fast relative to the best free
 * slot of the other machines: a job never lands on a machine while another one
 * would run it clearly faster.
 */
export const ARM_WITHIN = 0.85;
/** Waiting runners below this, relative to the best free slot elsewhere, are released. */
export const KEEP_WITHIN = 0.7;
/** Runners always waiting, so a burst of jobs does not start one per tick. */
export const MIN_WAITING = 2;
/** A waiting runner is released only after waiting this long. */
export const RELEASE_AFTER_MS = 60_000;

/** Benchmark of a machine's runner budget, in work units per second. */
export interface MachineSpeed {
	/** One core. */
	single: number;
	/** Every CPU of the budget at once. */
	multi: number;
}

/** Score of an unmeasured machine: about what an Apple silicon core scores. */
const DEFAULT_SINGLE = 1000;

export interface PlacementMachine {
	id: string;
	/** Enabled, provisioned, not draining, above its disk reserve. */
	accepting: boolean;
	maxRunners: number;
	/** Jobs running now. */
	busy: number;
	speed: MachineSpeed | null;
	/** CPUs of the budget, used until the machine is measured. */
	cpus: number;
}

/**
 * How fast a job runs as the k-th job at once on a machine: its share of the
 * budget, capped by the cores one job uses.
 */
export const slotSpeed = (machine: PlacementMachine, k: number) => {
	const single = machine.speed?.single ?? DEFAULT_SINGLE;
	const multi = machine.speed?.multi ?? single * machine.cpus;
	return Math.min(single * JOB_PARALLELISM, multi / k);
};

export interface WaitingTarget {
	/** Arm runners until this many wait for jobs. */
	arm: number;
	/** Release waiting runners beyond this many. */
	keep: number;
}

/**
 * How many runners should wait on each machine. "spread" arms every free slot
 * (lowest wait, jobs land anywhere); "fastest" only the slots about as fast as
 * the best free slot of the other machines. Within one machine there is no
 * choice to make, so a machine alone arms all its free slots.
 */
export const placeWaitingRunners = (
	machines: PlacementMachine[],
	placement: "fastest" | "spread",
) => {
	const targets = new Map<string, WaitingTarget>();
	const open = machines.filter(
		(machine) => machine.accepting && machine.maxRunners > machine.busy,
	);
	const firstSlot = new Map(
		open.map((machine) => [machine.id, slotSpeed(machine, machine.busy + 1)]),
	);
	/** Free slots of a machine as fast as `within` of the best slot elsewhere. */
	const fastEnough = (machine: PlacementMachine, within: number) => {
		const others = open
			.filter((other) => other.id !== machine.id)
			.map((other) => firstSlot.get(other.id) ?? 0);
		const free = machine.maxRunners - machine.busy;
		if (placement === "spread" || !others.length) return free;
		const bar = Math.max(...others) * within;
		let count = 0;
		// Slot speeds only decrease as jobs are added.
		for (let k = machine.busy + 1; k <= machine.maxRunners; k++) {
			if (slotSpeed(machine, k) < bar) break;
			count++;
		}
		return count;
	};
	const arm = new Map(
		open.map((machine) => [machine.id, fastEnough(machine, ARM_WITHIN)]),
	);
	// Keep a couple of runners waiting, on the fastest of the remaining slots.
	let total = [...arm.values()].reduce((sum, value) => sum + value, 0);
	const remaining = open
		.flatMap((machine) =>
			Array.from(
				{
					length:
						machine.maxRunners - machine.busy - (arm.get(machine.id) ?? 0),
				},
				(_, index) => ({
					id: machine.id,
					speed: slotSpeed(
						machine,
						machine.busy + (arm.get(machine.id) ?? 0) + index + 1,
					),
				}),
			),
		)
		.sort((a, b) => b.speed - a.speed);
	for (const slot of remaining) {
		if (total >= MIN_WAITING) break;
		arm.set(slot.id, (arm.get(slot.id) ?? 0) + 1);
		total++;
	}
	for (const machine of machines) {
		const armed = arm.get(machine.id) ?? 0;
		targets.set(machine.id, {
			arm: armed,
			keep: open.includes(machine)
				? Math.max(armed, fastEnough(machine, KEEP_WITHIN))
				: 0,
		});
	}
	return targets;
};

/** The machine the next job goes to, for display. */
export const nextMachine = (machines: PlacementMachine[]) => {
	let best: { id: string; speed: number } | null = null;
	for (const machine of machines) {
		if (!machine.accepting || machine.busy >= machine.maxRunners) continue;
		const speed = slotSpeed(machine, machine.busy + 1);
		if (!best || speed > best.speed) best = { id: machine.id, speed };
	}
	return best?.id ?? null;
};
