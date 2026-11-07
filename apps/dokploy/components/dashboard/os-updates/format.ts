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

/** "2026-11-07 02:00" in the browser's time zone. */
export const dateText = (iso: string | null | undefined) => {
	if (!iso) return "—";
	const date = new Date(iso);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
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
