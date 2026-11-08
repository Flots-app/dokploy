import { describe, expect, it } from "vitest";
import {
	cancelRunText,
	dateText,
	openWindowWarning,
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

	it("warn while a window is open: changes start installs within a minute", () => {
		// Sunday 2026-11-08 03:00 in Paris.
		const warning = openWindowWarning(
			sundayNights,
			new Date("2026-11-08T02:00:00Z"),
		);
		expect(warning).toMatch(
			/open now, until 2026-11-08 05:00 \(Europe\/Paris\).*within a minute, and may reboot/,
		);
		expect(
			openWindowWarning(sundayNights, new Date("2026-11-08T05:00:00Z")),
		).toBeNull();
		expect(
			openWindowWarning({ ...sundayNights, weekdays: [] }, new Date()),
		).toBeNull();
	});

	it("say what cancelling a run costs its server", () => {
		expect(
			cancelRunText({
				trigger: "schedule",
				serverName: "web-1",
				configurationName: "Weekly security",
			}),
		).toBe(
			"web-1 installs nothing in this window: it waits for the next window of Weekly security, or for Install now. This cannot be undone.",
		);
		expect(
			cancelRunText({
				trigger: "manual",
				serverName: "web-1",
				configurationName: null,
			}),
		).toMatch(/does not install the updates of this Install now/);
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
