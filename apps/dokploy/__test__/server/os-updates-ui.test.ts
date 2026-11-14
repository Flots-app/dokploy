import { describe, expect, it } from "vitest";
import {
	cancelRunText,
	dateText,
	openWindowWarning,
	periodText,
	REBOOT_LABELS,
	zonedDateText,
} from "@/components/dashboard/os-updates/format";

/** Sundays 02:00-05:00 in Paris. */
const sundayNights = {
	recurrence: "weekly",
	startTime: "02:00",
	timeZone: "Europe/Paris",
	durationMinutes: 180,
	weekdays: [0],
	monthlyMode: "day",
	monthDay: 1,
	monthWeek: 1,
	monthWeekday: 0,
};

describe("OS updates page helpers", () => {
	it("show a time in the zone it belongs to, and name the zone", () => {
		// 01:00 UTC is 02:00 in Paris in November, 20:00 the day before in New York.
		const iso = "2026-11-08T01:00:00.000Z";
		expect(dateText(iso, "Europe/Paris")).toBe("2026-11-08 02:00");
		expect(dateText(iso, "America/New_York")).toBe("2026-11-07 20:00");
		expect(zonedDateText(iso, "Europe/Paris")).toBe(
			"2026-11-08 02:00 (Europe/Paris)",
		);
		expect(dateText(null)).toBe("—");
	});

	it("show when a run ran, without a start it never had", () => {
		const zone = "Europe/Paris";
		expect(
			periodText("2026-11-08T13:31:00Z", "2026-11-08T13:32:00Z", zone),
		).toBe("2026-11-08 14:31 → 14:32");
		expect(
			periodText("2026-11-08T22:50:00Z", "2026-11-09T00:10:00Z", zone),
		).toBe("2026-11-08 23:50 → 2026-11-09 01:10");
		expect(periodText("2026-11-08T13:31:00Z", null, zone)).toBe(
			"2026-11-08 14:31",
		);
		// A run cancelled before it started.
		expect(periodText(null, "2026-11-08T13:40:00Z", zone)).toBe("—");
	});

	it("warn while a window is open: changes start installs within a minute", () => {
		// Sunday 2026-11-08 03:00 in Paris.
		const sunday3am = new Date("2026-11-08T02:00:00Z");
		expect(openWindowWarning(sundayNights, "if-required", sunday3am)).toMatch(
			/open now, until 2026-11-08 05:00 \(Europe\/Paris\).*within a minute, and may reboot\.$/,
		);
		// The reboot setting is said as it is, never "may reboot" for never.
		expect(openWindowWarning(sundayNights, "never", sunday3am)).toMatch(
			/within a minute \(no reboot\)\.$/,
		);
		expect(openWindowWarning(sundayNights, "always", sunday3am)).toMatch(
			/within a minute, then reboot\.$/,
		);
		expect(
			openWindowWarning(
				sundayNights,
				"if-required",
				new Date("2026-11-08T05:00:00Z"),
			),
		).toBeNull();
		expect(
			openWindowWarning(
				{ ...sundayNights, weekdays: [] },
				"if-required",
				new Date(),
			),
		).toBeNull();
	});

	it("say what cancelling a run costs its server", () => {
		expect(
			cancelRunText({
				trigger: "schedule",
				machineName: "web-1",
				configurationName: "Weekly security",
			}),
		).toBe(
			"web-1 installs nothing in this window: it waits for the next window of Weekly security, or for Install now. This cannot be undone.",
		);
		expect(
			cancelRunText({
				trigger: "manual",
				machineName: "web-1",
				configurationName: null,
			}),
		).toMatch(/does not install the updates of this Install now/);
	});

	it("say what giving a Mac back costs", () => {
		expect(
			cancelRunText({
				trigger: "manual",
				kind: "handoff",
				machineName: "m6",
				configurationName: null,
			}),
		).toMatch(
			/^m6 takes jobs again at once, whether or not its owner updated macOS/,
		);
	});

	it("label every reboot setting", () => {
		expect(Object.keys(REBOOT_LABELS).sort()).toEqual([
			"always",
			"if-required",
			"never",
		]);
		expect(REBOOT_LABELS["if-required"]).toBe(
			"Reboot if an update asks for it",
		);
	});
});
