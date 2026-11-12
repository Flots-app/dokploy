/**
 * A Mac lends memory and disk to its runner VM, and the people working on the
 * Mac come first. While a VM runs, Virtualization.framework gives macOS none
 * of the memory its jobs touched: after a few jobs the VM holds most of its
 * size, the Mac swaps, and the swap files take its disk. With the disk almost
 * full, macOS services crash in a loop (a Mac mini fell to 1 GiB free and
 * showed "identityservicesd quit unexpectedly" around the clock).
 *
 * So, once no job runs in the VM:
 * - below the disk reserve, the VM stops, and starts again only once the Mac
 *   has the reserve and a margin free;
 * - on a Mac short of memory, a VM that ran jobs restarts after a quiet while:
 *   a fresh VM holds only what it uses.
 */
import { formatBytes } from "./budget";

const GiB = 1024 ** 3;

/** A stopped VM starts again only with this much free above the reserve. */
export const MAC_START_MARGIN_BYTES = 5 * GiB;
/** Below this share of free memory (memory_pressure), the Mac is short of memory. */
export const MAC_MEMORY_SHORT_PERCENT = 50;
/** A VM that ran jobs restarts once no job has run in it for this long. */
export const MAC_RESTART_IDLE_MS = 10 * 60_000;

export interface MacHostState {
	diskFreeBytes: number;
	/** 0 when the Mac did not report its disk. */
	diskTotalBytes: number;
	memoryFreePercent: number | null;
}

export type MacRelief =
	| { action: "none" }
	/** Stop the VM; it stays stopped until `macRoomToStart` allows it. */
	| { action: "stop"; reason: string }
	/** Stop the VM and start it again right away. */
	| { action: "restart"; reason: string };

/**
 * What a running VM should do for its Mac. The controller acts on it once no
 * job runs in the VM, and stops new jobs meanwhile.
 */
export const macRelief = (input: {
	now: number;
	host: MacHostState;
	reserveBytes: number;
	/** Last time a job was seen running in the VM since it started; null for none. */
	lastJobAt: number | null;
}): MacRelief => {
	const { host, reserveBytes } = input;
	// A Mac that did not report its disk is not taken for a full one.
	if (host.diskTotalBytes > 0 && host.diskFreeBytes < reserveBytes) {
		return {
			action: "stop",
			reason: `the Mac has ${formatBytes(host.diskFreeBytes)} free, below its ${formatBytes(reserveBytes)} reserve`,
		};
	}
	if (
		input.lastJobAt !== null &&
		input.now - input.lastJobAt >= MAC_RESTART_IDLE_MS &&
		host.memoryFreePercent !== null &&
		host.memoryFreePercent < MAC_MEMORY_SHORT_PERCENT
	) {
		return {
			action: "restart",
			reason: `the Mac has ${Math.round(host.memoryFreePercent)}% of its memory free`,
		};
	}
	return { action: "none" };
};

/** Free space a stopped VM waits for before it starts again. */
export const macStartThreshold = (reserveBytes: number) =>
	reserveBytes + MAC_START_MARGIN_BYTES;

/**
 * Whether a stopped VM may start: the Mac needs its reserve and a margin free,
 * or the VM would stop again at once. A Mac that did not report its disk may.
 */
export const macRoomToStart = (
	host: MacHostState | null,
	reserveBytes: number,
): { ok: true } | { ok: false; reason: string } => {
	if (!host || host.diskTotalBytes <= 0) return { ok: true };
	const needed = macStartThreshold(reserveBytes);
	if (host.diskFreeBytes >= needed) return { ok: true };
	return {
		ok: false,
		reason: `the Mac has ${formatBytes(host.diskFreeBytes)} free; its VM starts again above ${formatBytes(needed)}`,
	};
};
