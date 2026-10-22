/**
 * When Dokploy may update the actions/runner release and its runtime on a
 * machine by itself. A pool sets the policy, a machine may override it; an
 * operator can always update now, and some updates cannot wait.
 */
import type {
	GithubRunnerUpdatePolicy,
	GithubRunnerUpdateWindow,
} from "@dokploy/server/db/schema";
import { z } from "zod";

export const isTimeZone = (timeZone: string) => {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone });
		return true;
	} catch {
		return false;
	}
};

const clock = z
	.string()
	.regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a 24-hour time such as 02:00");

export const updateWindowSchema = z
	.object({
		days: z
			.array(z.number().int().min(0).max(6))
			.min(1, "Pick at least one day")
			.max(7)
			.refine((days) => new Set(days).size === days.length, "Each day once"),
		start: clock,
		end: clock,
		timeZone: z.string().min(1).max(64).refine(isTimeZone, "Unknown time zone"),
	})
	.refine((window) => window.start !== window.end, {
		path: ["end"],
		message: "The window must end at another time than it starts",
	});

export const updatePolicySchema = z.object({
	auto: z.boolean(),
	window: updateWindowSchema.nullable(),
	osPatches: z.boolean().optional(),
});

/**
 * Updated anyway this long before GitHub stops queuing jobs on the installed
 * release, whatever the policy: a machine out of reach of its jobs is worse
 * than an update outside its window.
 */
export const FORCE_BEFORE_DEADLINE_MS = 3 * 24 * 60 * 60_000;
/** A failed automatic update is tried again after this long. */
export const UPDATE_RETRY_MS = 30 * 60_000;

export const DEFAULT_UPDATE_POLICY: GithubRunnerUpdatePolicy = {
	auto: true,
	window: null,
};

const minutesOf = (clock: string) => {
	const [hours = 0, minutes = 0] = clock.split(":").map(Number);
	return hours * 60 + minutes;
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Day of the week (0 for Sunday) and minutes past midnight in a time zone. */
const localTime = (now: Date, timeZone: string) => {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		weekday: "short",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).formatToParts(now);
	const part = (type: string) =>
		parts.find((item) => item.type === type)?.value ?? "";
	return {
		day: WEEKDAYS.indexOf(part("weekday")),
		minutes: Number(part("hour")) * 60 + Number(part("minute")),
	};
};

/**
 * Whether the window is open. An end before the start runs past midnight:
 * "Fri 23:00–02:00" is open from Friday 23:00 to Saturday 02:00.
 */
export const inUpdateWindow = (
	window: GithubRunnerUpdateWindow | null,
	now: Date,
) => {
	if (!window) return true;
	const { day, minutes } = localTime(now, window.timeZone);
	const start = minutesOf(window.start);
	const end = minutesOf(window.end);
	if (start < end) {
		return window.days.includes(day) && minutes >= start && minutes < end;
	}
	const previous = (day + 6) % 7;
	return (
		(window.days.includes(day) && minutes >= start) ||
		(window.days.includes(previous) && minutes < end)
	);
};

/**
 * When the open window closes, to the minute; null when it is not open, or
 * when there is no window (any time).
 */
export const updateWindowEnd = (
	window: GithubRunnerUpdateWindow | null,
	now: Date,
) => {
	if (!window || !inUpdateWindow(window, now)) return null;
	const start = Math.floor(now.getTime() / 60_000) * 60_000;
	// A window lasts less than a day: the end is within the next 24 hours.
	for (let minute = 1; minute <= 24 * 60; minute++) {
		const at = new Date(start + minute * 60_000);
		if (!inUpdateWindow(window, at)) return at;
	}
	return null;
};

/** "Mon–Fri 02:00–05:00 (Europe/Paris)", or "any time". */
export const describeUpdateWindow = (
	window: GithubRunnerUpdateWindow | null,
) => {
	if (!window) return "any time";
	const days = [...window.days].sort((a, b) => a - b);
	const consecutive =
		days.length > 2 &&
		days.every(
			(day, index) => index === 0 || day === (days[index - 1] ?? 0) + 1,
		);
	const label =
		days.length === 7
			? "Every day"
			: consecutive
				? `${WEEKDAYS[days[0] ?? 0]}–${WEEKDAYS[days.at(-1) ?? 0]}`
				: days.map((day) => WEEKDAYS[day]).join(", ");
	return `${label} ${window.start}–${window.end} (${window.timeZone})`;
};

/** The policy a machine follows: its own, or its pool's. */
export const effectiveUpdatePolicy = (
	pool: { updatePolicy: GithubRunnerUpdatePolicy | null },
	node: { updatePolicy: GithubRunnerUpdatePolicy | null },
) => node.updatePolicy ?? pool.updatePolicy ?? DEFAULT_UPDATE_POLICY;

export type UpdateReason =
	| "requested"
	| "required"
	| "deadline"
	| "window"
	| "anytime";

/**
 * Whether an update may be installed now, and why. `required`: this Dokploy
 * cannot drive the runtime installed; `deadline`: GitHub stops queuing jobs
 * on the installed release within FORCE_BEFORE_DEADLINE_MS.
 */
export const updateDecision = (input: {
	policy: GithubRunnerUpdatePolicy;
	now: Date;
	requested: boolean;
	required?: boolean;
	/** When GitHub stops queuing jobs on the installed release. */
	deadline?: string | null;
	/** Last failed attempt: automatic retries wait UPDATE_RETRY_MS. */
	failedAt?: string | null;
}):
	| { allowed: true; reason: UpdateReason }
	| { allowed: false; reason: "off" | "outside-window" | "retry-later" } => {
	const { policy, now } = input;
	if (input.requested) return { allowed: true, reason: "requested" };
	const waiting =
		input.failedAt &&
		now.getTime() - Date.parse(input.failedAt) < UPDATE_RETRY_MS;
	if (waiting) return { allowed: false, reason: "retry-later" };
	if (input.required) return { allowed: true, reason: "required" };
	if (
		input.deadline &&
		Date.parse(input.deadline) - now.getTime() <= FORCE_BEFORE_DEADLINE_MS
	) {
		return { allowed: true, reason: "deadline" };
	}
	if (!policy.auto) return { allowed: false, reason: "off" };
	if (!policy.window) return { allowed: true, reason: "anytime" };
	return inUpdateWindow(policy.window, now)
		? { allowed: true, reason: "window" }
		: { allowed: false, reason: "outside-window" };
};
