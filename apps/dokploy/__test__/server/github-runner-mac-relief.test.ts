import {
	MAC_RESTART_IDLE_MS,
	macRelief,
	macRoomToStart,
} from "@dokploy/server/utils/github-runners/mac-relief";
import { describe, expect, it } from "vitest";

const GiB = 1024 ** 3;
const now = Date.parse("2026-11-12T03:44:00Z");
/** The Mac mini of the incident: 228 GiB disk, 15 GiB reserve. */
const mac = (freeGiB: number, memoryFreePercent: number | null = 60) => ({
	diskFreeBytes: freeGiB * GiB,
	diskTotalBytes: 228 * GiB,
	memoryFreePercent,
});
const reserveBytes = 15 * GiB;

describe("macRelief", () => {
	it("stops the VM of a Mac below its disk reserve", () => {
		const relief = macRelief({
			now,
			host: mac(12.2),
			reserveBytes,
			lastJobAt: null,
		});
		expect(relief).toEqual({
			action: "stop",
			reason: "the Mac has 12.2 GiB free, below its 15 GiB reserve",
		});
	});

	it("stops rather than restarts when the Mac is short of both", () => {
		expect(
			macRelief({
				now,
				host: mac(1, 34),
				reserveBytes,
				lastJobAt: now - 2 * MAC_RESTART_IDLE_MS,
			}).action,
		).toBe("stop");
	});

	it("never takes a Mac that did not report its disk for a full one", () => {
		expect(
			macRelief({
				now,
				host: { diskFreeBytes: 0, diskTotalBytes: 0, memoryFreePercent: 70 },
				reserveBytes,
				lastJobAt: null,
			}),
		).toEqual({ action: "none" });
	});

	it("restarts a VM that ran jobs once it has idled on a Mac short of memory", () => {
		expect(
			macRelief({
				now,
				host: mac(30, 38),
				reserveBytes,
				lastJobAt: now - MAC_RESTART_IDLE_MS,
			}),
		).toEqual({
			action: "restart",
			reason: "the Mac has 38% of its memory free",
		});
	});

	it("leaves a VM alone right after a job, or on a Mac with memory to spare", () => {
		const relief = (
			lastJobAt: number | null,
			memoryFreePercent: number | null,
		) =>
			macRelief({
				now,
				host: mac(30, memoryFreePercent),
				reserveBytes,
				lastJobAt,
			}).action;
		// The job only just ended: more may follow.
		expect(relief(now - MAC_RESTART_IDLE_MS + 1, 38)).toBe("none");
		// No job since it started: a fresh VM holds little.
		expect(relief(null, 20)).toBe("none");
		expect(relief(now - 2 * MAC_RESTART_IDLE_MS, 50)).toBe("none");
		// The Mac did not say how much memory it has free.
		expect(relief(now - 2 * MAC_RESTART_IDLE_MS, null)).toBe("none");
	});
});

describe("macRoomToStart", () => {
	it("keeps a stopped VM stopped until the Mac has its reserve and a margin free", () => {
		expect(macRoomToStart(mac(18.8), reserveBytes)).toEqual({
			ok: false,
			reason: "the Mac has 18.8 GiB free; its VM starts again above 20 GiB",
		});
		expect(macRoomToStart(mac(20), reserveBytes)).toEqual({ ok: true });
	});

	it("lets the VM start when the Mac did not report its disk", () => {
		expect(macRoomToStart(null, reserveBytes)).toEqual({ ok: true });
		expect(
			macRoomToStart(
				{ diskFreeBytes: 0, diskTotalBytes: 0, memoryFreePercent: null },
				reserveBytes,
			),
		).toEqual({ ok: true });
	});
});
