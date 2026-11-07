/**
 * Maintenance windows of OS updates: a start time in a time zone, a
 * recurrence (every day, some weekdays, or once a month) and a duration.
 * Pure date math, in the zone's wall clock:
 * - a start time that does not exist (the clocks jump forward over it) moves
 *   forward by the jump, 02:30 becoming 03:30; one that happens twice (the
 *   clocks go back) is the first;
 * - the duration is elapsed time, so a window lasts as long on those days;
 * - a monthly day the month does not have (the 31st in April) gives no window
 *   that month: "last day" is there for that.
 */
import { z } from "zod";

export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ORDINALS: Record<number, string> = {
	1: "first",
	2: "second",
	3: "third",
	4: "fourth",
	[-1]: "last",
};

/** A window shorter than this leaves little time once the lists refreshed. */
export const MIN_WINDOW_MINUTES = 60;
export const MAX_WINDOW_MINUTES = 12 * 60;

export const isTimeZone = (timeZone: string) => {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone });
		return true;
	} catch {
		return false;
	}
};

export const osUpdateScheduleSchema = z
	.object({
		recurrence: z.enum(["daily", "weekly", "monthly"]),
		startTime: z
			.string()
			.regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a 24-hour time such as 02:00"),
		timeZone: z.string().min(1).max(64).refine(isTimeZone, "Unknown time zone"),
		durationMinutes: z
			.number()
			.int()
			.min(MIN_WINDOW_MINUTES, "A window lasts at least an hour")
			.max(MAX_WINDOW_MINUTES, "A window lasts at most 12 hours"),
		/** weekly: days of the week, 0 for Sunday. */
		weekdays: z
			.array(z.number().int().min(0).max(6))
			.max(7)
			.refine((days) => new Set(days).size === days.length, "Each day once")
			.default([]),
		/** monthly: on a day of the month, or on the nth weekday. */
		monthlyMode: z.enum(["day", "weekday"]).default("day"),
		/** 1 to 31, or -1 for the last day of the month. */
		monthDay: z
			.number()
			.int()
			.refine((day) => day === -1 || (day >= 1 && day <= 31))
			.default(1),
		/** 1 to 4, or -1 for the last one of the month. */
		monthWeek: z
			.number()
			.int()
			.refine((week) => week === -1 || (week >= 1 && week <= 4))
			.default(1),
		monthWeekday: z.number().int().min(0).max(6).default(0),
	})
	.refine(
		(schedule) => schedule.recurrence !== "weekly" || schedule.weekdays.length,
		{ path: ["weekdays"], message: "Pick at least one day" },
	);

export type OsUpdateSchedule = z.infer<typeof osUpdateScheduleSchema>;

export interface MaintenanceWindow {
	start: Date;
	end: Date;
}

const DAY_MS = 24 * 60 * 60_000;

const formatters = new Map<string, Intl.DateTimeFormat>();
const formatter = (timeZone: string) => {
	let format = formatters.get(timeZone);
	if (!format) {
		format = new Intl.DateTimeFormat("en-US", {
			timeZone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hourCycle: "h23",
		});
		formatters.set(timeZone, format);
	}
	return format;
};

/** The wall clock of a zone at an instant, as if it were UTC (ms). */
const wallClock = (instant: number, timeZone: string) => {
	const parts = formatter(timeZone).formatToParts(new Date(instant));
	const part = (type: string) =>
		Number(parts.find((item) => item.type === type)?.value ?? 0);
	return Date.UTC(
		part("year"),
		part("month") - 1,
		part("day"),
		part("hour"),
		part("minute"),
		part("second"),
	);
};

/** How far the zone is ahead of UTC at an instant (ms). */
const offsetAt = (instant: number, timeZone: string) =>
	wallClock(instant - (instant % 1000), timeZone) -
	(instant - (instant % 1000));

/**
 * The instant a wall-clock time of a zone happens. Skipped by a jump
 * forward: moved forward by the jump. Repeated by a jump back: the first.
 */
export const zonedTime = (
	date: { year: number; month: number; day: number },
	minutes: number,
	timeZone: string,
) => {
	const wall = Date.UTC(date.year, date.month - 1, date.day) + minutes * 60_000;
	const before = offsetAt(wall - DAY_MS, timeZone);
	const after = offsetAt(wall + DAY_MS, timeZone);
	const valid = [wall - before, wall - after].filter(
		(instant) => instant + offsetAt(instant, timeZone) === wall,
	);
	if (valid.length) return Math.min(...valid);
	return wall - before;
};

interface LocalDate {
	year: number;
	month: number;
	day: number;
	/** 0 for Sunday. */
	weekday: number;
}

const dateOf = (utcMidnight: number): LocalDate => {
	const date = new Date(utcMidnight);
	return {
		year: date.getUTCFullYear(),
		month: date.getUTCMonth() + 1,
		day: date.getUTCDate(),
		weekday: date.getUTCDay(),
	};
};

/** The calendar day of an instant in a zone, as a UTC midnight (ms). */
const localMidnight = (instant: number, timeZone: string) => {
	const wall = wallClock(instant, timeZone);
	return wall - (((wall % DAY_MS) + DAY_MS) % DAY_MS);
};

const daysInMonth = (year: number, month: number) =>
	new Date(Date.UTC(year, month, 0)).getUTCDate();

/** Whether the schedule has a window starting on that calendar day. */
export const occursOn = (schedule: OsUpdateSchedule, date: LocalDate) => {
	switch (schedule.recurrence) {
		case "daily":
			return true;
		case "weekly":
			return schedule.weekdays.includes(date.weekday);
		case "monthly": {
			const last = daysInMonth(date.year, date.month);
			if (schedule.monthlyMode === "day") {
				return schedule.monthDay === -1
					? date.day === last
					: date.day === schedule.monthDay;
			}
			if (date.weekday !== schedule.monthWeekday) return false;
			return schedule.monthWeek === -1
				? date.day > last - 7
				: Math.ceil(date.day / 7) === schedule.monthWeek;
		}
	}
};

const startMinutes = (schedule: OsUpdateSchedule) => {
	const [hours = 0, minutes = 0] = schedule.startTime.split(":").map(Number);
	return hours * 60 + minutes;
};

/** The window starting on a calendar day (given as a UTC midnight). */
const windowOn = (
	schedule: OsUpdateSchedule,
	utcMidnight: number,
): MaintenanceWindow | null => {
	const date = dateOf(utcMidnight);
	if (!occursOn(schedule, date)) return null;
	const start = zonedTime(date, startMinutes(schedule), schedule.timeZone);
	return {
		start: new Date(start),
		end: new Date(start + schedule.durationMinutes * 60_000),
	};
};

/** Longer than any gap between two windows (a monthly one missing a month). */
const SEARCH_DAYS = 400;

/** The window open at `now`, if any. */
export const openWindow = (
	schedule: OsUpdateSchedule,
	now: Date,
): MaintenanceWindow | null => {
	const today = localMidnight(now.getTime(), schedule.timeZone);
	// A window lasts at most 12 hours: it started today or yesterday.
	for (const day of [today, today - DAY_MS]) {
		const window = windowOn(schedule, day);
		if (
			window &&
			window.start.getTime() <= now.getTime() &&
			now.getTime() < window.end.getTime()
		) {
			return window;
		}
	}
	return null;
};

/** The first window starting after `now`. */
export const nextWindow = (
	schedule: OsUpdateSchedule,
	now: Date,
): MaintenanceWindow | null => {
	const today = localMidnight(now.getTime(), schedule.timeZone);
	for (let offset = 0; offset <= SEARCH_DAYS; offset++) {
		const window = windowOn(schedule, today + offset * DAY_MS);
		if (window && window.start.getTime() > now.getTime()) return window;
	}
	return null;
};

/** The last window that ended at or before `now`. */
export const previousWindow = (
	schedule: OsUpdateSchedule,
	now: Date,
): MaintenanceWindow | null => {
	const today = localMidnight(now.getTime(), schedule.timeZone);
	for (let offset = 0; offset <= SEARCH_DAYS; offset++) {
		const window = windowOn(schedule, today - offset * DAY_MS);
		if (window && window.end.getTime() <= now.getTime()) return window;
	}
	return null;
};

const durationText = (minutes: number) => {
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	if (!hours) return `${rest} min`;
	return rest ? `${hours} h ${rest} min` : `${hours} h`;
};

/** "Mon, Wed at 02:00 for 3 h (Europe/Paris)". */
export const describeSchedule = (schedule: OsUpdateSchedule) => {
	let days: string;
	switch (schedule.recurrence) {
		case "daily":
			days = "Every day";
			break;
		case "weekly": {
			const sorted = [...schedule.weekdays].sort((a, b) => a - b);
			days =
				sorted.length === 7
					? "Every day"
					: `Every ${sorted.map((day) => WEEKDAYS[day]).join(", ")}`;
			break;
		}
		case "monthly":
			days =
				schedule.monthlyMode === "day"
					? schedule.monthDay === -1
						? "On the last day of the month"
						: `On day ${schedule.monthDay} of the month`
					: `On the ${ORDINALS[schedule.monthWeek]} ${WEEKDAYS[schedule.monthWeekday]} of the month`;
			break;
	}
	return `${days} at ${schedule.startTime} for ${durationText(schedule.durationMinutes)} (${schedule.timeZone})`;
};
