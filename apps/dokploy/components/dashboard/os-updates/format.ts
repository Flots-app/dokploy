import {
	openWindow,
	osUpdateScheduleSchema,
} from "@dokploy/server/utils/os-updates/schedule";
import type { RouterOutputs } from "@/utils/api";

export type OsUpdateOverview = RouterOutputs["osUpdate"]["overview"];
export type OsUpdateServerRow = OsUpdateOverview["servers"][number];
export type OsUpdateConfigurationRow =
	OsUpdateOverview["configurations"][number];
export type OsUpdateRunRow = RouterOutputs["osUpdate"]["runs"][number];
export type OsUpdateRunStatus = OsUpdateRunRow["status"];

export const RUN_STATUS: Record<
	OsUpdateRunStatus,
	{ label: string; variant: "blue" | "green" | "red" | "yellow" | "blank" }
> = {
	pending: { label: "waiting", variant: "blank" },
	running: { label: "running", variant: "blue" },
	succeeded: { label: "succeeded", variant: "green" },
	failed: { label: "failed", variant: "red" },
	skipped: { label: "skipped", variant: "yellow" },
	missed: { label: "missed", variant: "yellow" },
	cancelled: { label: "cancelled", variant: "blank" },
};

export const REBOOT_LABELS = {
	"if-required": "Reboot if an update asks for it",
	never: "Never reboot",
	always: "Always reboot",
} as const;

export const CLASSIFICATION_LABELS = {
	security: "Security updates only",
	all: "All updates",
} as const;

/** The browser's time zone, which run times are shown in. */
export const browserTimeZone = () => {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	} catch {
		return "UTC";
	}
};

/**
 * "2026-11-07 02:00" in a time zone: a schedule's own for its windows, the
 * browser's for what happened. Labels say which (zoneText).
 */
export const dateText = (
	iso: string | null | undefined,
	timeZone = browserTimeZone(),
) => {
	if (!iso) return "—";
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).formatToParts(new Date(iso));
	const part = (type: string) =>
		parts.find((item) => item.type === type)?.value ?? "";
	return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}`;
};

/** A date and the zone it is shown in: "2026-11-08 02:00 (Europe/Paris)". */
export const zonedDateText = (
	iso: string | null | undefined,
	timeZone = browserTimeZone(),
) => (iso ? `${dateText(iso, timeZone)} (${timeZone})` : "—");

/**
 * Said before a change that makes servers install while a window of the
 * schedule is open: they start within a minute, not at the next window.
 * Null when no window is open (or the schedule is not valid yet).
 */
export const openWindowWarning = (schedule: unknown, now = new Date()) => {
	const parsed = osUpdateScheduleSchema.safeParse(schedule);
	if (!parsed.success) return null;
	const open = openWindow(parsed.data, now);
	return open
		? `Its maintenance window is open now, until ${zonedDateText(open.end.toISOString(), parsed.data.timeZone)}: the servers start installing their updates within a minute, and may reboot.`
		: null;
};

/** What cancelling a run that has not started means for its server. */
export const cancelRunText = (run: {
	trigger: "schedule" | "manual";
	serverName: string | null;
	configurationName: string | null;
}) => {
	const server = run.serverName ?? "The server";
	return run.trigger === "schedule"
		? `${server} installs nothing in this window: it waits for the next window${run.configurationName ? ` of ${run.configurationName}` : ""}, or for Install now. This cannot be undone.`
		: `${server} does not install the updates of this Install now. You can start another one.`;
};

/** One package name or pattern per line (or separated by commas or spaces). */
export const parsePatterns = (text: string) =>
	text
		.split(/[\s,]+/)
		.map((item) => item.trim())
		.filter(Boolean);

const PATTERN = /^[a-z0-9*?][a-z0-9+.:*?-]*$/;

/** Invalid patterns of a list, to show next to it. */
export const invalidPatterns = (patterns: string[]) =>
	patterns.filter((pattern) => !PATTERN.test(pattern));
