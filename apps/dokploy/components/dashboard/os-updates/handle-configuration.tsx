import {
	DEFAULT_OS_UPDATE_SETTINGS,
	type OsUpdateSettings,
} from "@dokploy/server/utils/os-updates/filters";
import {
	isTimeZone,
	MAX_WINDOW_MINUTES,
	MIN_WINDOW_MINUTES,
	nextWindow,
	type OsUpdateSchedule,
	osUpdateScheduleSchema,
} from "@dokploy/server/utils/os-updates/schedule";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Toggle } from "@/components/ui/toggle";
import { api } from "@/utils/api";
import { errorText } from "../github-runners/format";
import {
	dateText,
	invalidPatterns,
	type OsUpdateConfigurationRow,
	type OsUpdateServerRow,
} from "./format";
import { SettingsFields } from "./settings-fields";

/** Monday first, as most people read a week. */
const DAYS = [
	{ value: 1, label: "Mon" },
	{ value: 2, label: "Tue" },
	{ value: 3, label: "Wed" },
	{ value: 4, label: "Thu" },
	{ value: 5, label: "Fri" },
	{ value: 6, label: "Sat" },
	{ value: 0, label: "Sun" },
];
const WEEKDAY_NAMES = [
	"Sunday",
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday",
];
const WEEKS = [
	{ value: 1, label: "First" },
	{ value: 2, label: "Second" },
	{ value: 3, label: "Third" },
	{ value: 4, label: "Fourth" },
	{ value: -1, label: "Last" },
];

const browserTimeZone = () => {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	} catch {
		return "UTC";
	}
};

const timeZones = (() => {
	try {
		return Intl.supportedValuesOf("timeZone");
	} catch {
		return [];
	}
})();

interface Draft {
	name: string;
	description: string;
	enabled: boolean;
	schedule: OsUpdateSchedule;
	settings: OsUpdateSettings;
	notifyOnSuccess: boolean;
	serverIds: string[];
}

/** Sundays from 02:00 to 05:00 in the browser's time zone, security only. */
const emptyDraft = (): Draft => ({
	name: "",
	description: "",
	enabled: true,
	schedule: {
		recurrence: "weekly",
		startTime: "02:00",
		timeZone: browserTimeZone(),
		durationMinutes: 180,
		weekdays: [0],
		monthlyMode: "day",
		monthDay: 1,
		monthWeek: 1,
		monthWeekday: 0,
	},
	settings: DEFAULT_OS_UPDATE_SETTINGS,
	notifyOnSuccess: false,
	serverIds: [],
});

const fromConfiguration = (row: OsUpdateConfigurationRow): Draft => ({
	name: row.name,
	description: row.description ?? "",
	enabled: row.enabled,
	schedule: row.schedule,
	settings: {
		classification: row.classification,
		includePackages: row.includePackages,
		excludePackages: row.excludePackages,
		reboot: row.reboot,
		allowDockerUpdates: row.allowDockerUpdates,
	},
	notifyOnSuccess: row.notifyOnSuccess,
	serverIds: row.servers.map((server) => server.serverId),
});

/** The next `count` windows of a schedule. */
const nextWindows = (schedule: OsUpdateSchedule, count: number) => {
	const windows = [];
	let after = new Date();
	for (let index = 0; index < count; index++) {
		const window = nextWindow(schedule, after);
		if (!window) break;
		windows.push(window);
		after = window.start;
	}
	return windows;
};

const ScheduleFields = ({
	value,
	onChange,
}: {
	value: OsUpdateSchedule;
	onChange: (value: OsUpdateSchedule) => void;
}) => {
	const set = (patch: Partial<OsUpdateSchedule>) =>
		onChange({ ...value, ...patch });
	const parsed = osUpdateScheduleSchema.safeParse(value);
	const upcoming = parsed.success ? nextWindows(parsed.data, 3) : [];
	return (
		<div className="grid gap-3 rounded-lg border p-3">
			<div className="grid gap-3 sm:grid-cols-3">
				<div className="grid gap-2">
					<Label htmlFor="os-schedule-recurrence">Repeat</Label>
					<Select
						value={value.recurrence}
						onValueChange={(recurrence) =>
							set({ recurrence: recurrence as OsUpdateSchedule["recurrence"] })
						}
					>
						<SelectTrigger id="os-schedule-recurrence">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="daily">Every day</SelectItem>
							<SelectItem value="weekly">On some days of the week</SelectItem>
							<SelectItem value="monthly">Once a month</SelectItem>
						</SelectContent>
					</Select>
				</div>
				<div className="grid gap-2">
					<Label htmlFor="os-schedule-start">Starts at</Label>
					<Input
						id="os-schedule-start"
						type="time"
						value={value.startTime}
						onChange={(event) => set({ startTime: event.target.value })}
					/>
				</div>
				<div className="grid gap-2">
					<Label htmlFor="os-schedule-duration">Lasts (hours)</Label>
					<Input
						id="os-schedule-duration"
						type="number"
						min={MIN_WINDOW_MINUTES / 60}
						max={MAX_WINDOW_MINUTES / 60}
						step={0.5}
						value={value.durationMinutes / 60}
						onChange={(event) =>
							set({
								durationMinutes: Math.round(Number(event.target.value) * 60),
							})
						}
					/>
				</div>
			</div>
			{value.recurrence === "weekly" && (
				<div className="flex flex-wrap gap-1">
					{DAYS.map((day) => (
						<Toggle
							key={day.value}
							variant="outline"
							size="sm"
							pressed={value.weekdays.includes(day.value)}
							onPressedChange={(pressed) =>
								set({
									weekdays: pressed
										? [...value.weekdays, day.value]
										: value.weekdays.filter((item) => item !== day.value),
								})
							}
						>
							{day.label}
						</Toggle>
					))}
				</div>
			)}
			{value.recurrence === "monthly" && (
				<div className="grid gap-3 sm:grid-cols-3">
					<div className="grid gap-2">
						<Label htmlFor="os-schedule-monthly">On</Label>
						<Select
							value={value.monthlyMode}
							onValueChange={(monthlyMode) =>
								set({
									monthlyMode: monthlyMode as OsUpdateSchedule["monthlyMode"],
								})
							}
						>
							<SelectTrigger id="os-schedule-monthly">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="day">A day of the month</SelectItem>
								<SelectItem value="weekday">A weekday of the month</SelectItem>
							</SelectContent>
						</Select>
					</div>
					{value.monthlyMode === "day" ? (
						<div className="grid gap-2">
							<Label htmlFor="os-schedule-day">Day</Label>
							<Select
								value={String(value.monthDay)}
								onValueChange={(day) => set({ monthDay: Number(day) })}
							>
								<SelectTrigger id="os-schedule-day">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{Array.from({ length: 31 }, (_, index) => index + 1).map(
										(day) => (
											<SelectItem key={day} value={String(day)}>
												{day}
											</SelectItem>
										),
									)}
									<SelectItem value="-1">Last day</SelectItem>
								</SelectContent>
							</Select>
						</div>
					) : (
						<>
							<div className="grid gap-2">
								<Label htmlFor="os-schedule-week">Week</Label>
								<Select
									value={String(value.monthWeek)}
									onValueChange={(week) => set({ monthWeek: Number(week) })}
								>
									<SelectTrigger id="os-schedule-week">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{WEEKS.map((week) => (
											<SelectItem key={week.value} value={String(week.value)}>
												{week.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
							<div className="grid gap-2">
								<Label htmlFor="os-schedule-weekday">Weekday</Label>
								<Select
									value={String(value.monthWeekday)}
									onValueChange={(weekday) =>
										set({ monthWeekday: Number(weekday) })
									}
								>
									<SelectTrigger id="os-schedule-weekday">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{WEEKDAY_NAMES.map((name, index) => (
											<SelectItem key={name} value={String(index)}>
												{name}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
						</>
					)}
				</div>
			)}
			{value.recurrence === "monthly" &&
				value.monthlyMode === "day" &&
				value.monthDay > 28 && (
					<p className="text-xs text-muted-foreground">
						A month without day {value.monthDay} has no window: pick "Last day"
						to update every month.
					</p>
				)}
			<div className="grid gap-2">
				<Label htmlFor="os-schedule-zone">Time zone</Label>
				<Input
					id="os-schedule-zone"
					list="os-schedule-zones"
					value={value.timeZone}
					aria-invalid={!isTimeZone(value.timeZone)}
					onChange={(event) => set({ timeZone: event.target.value.trim() })}
				/>
				<datalist id="os-schedule-zones">
					{timeZones.map((zone) => (
						<option key={zone} value={zone} />
					))}
				</datalist>
			</div>
			{parsed.success ? (
				<p className="text-xs text-muted-foreground">
					Next windows (your time):{" "}
					{upcoming
						.map((window) => `${dateText(window.start.toISOString())}`)
						.join(", ") || "none within a year"}
					. A start time skipped by a daylight saving change moves forward by
					the change; no install starts in the last 15 minutes of a window.
				</p>
			) : (
				<p className="text-xs text-destructive">
					{parsed.error.issues.map((issue) => issue.message).join(". ")}
				</p>
			)}
		</div>
	);
};

/** The servers a configuration applies to. */
const ServerChoices = ({
	servers,
	configurationId,
	value,
	onChange,
}: {
	servers: OsUpdateServerRow[];
	configurationId: string | null;
	value: string[];
	onChange: (value: string[]) => void;
}) => {
	if (servers.length === 0) {
		return (
			<p className="text-sm text-muted-foreground">No remote server yet.</p>
		);
	}
	const selected = new Set(value);
	return (
		<div className="grid gap-2 sm:grid-cols-2">
			{servers.map((server) => {
				const elsewhere =
					server.configuration &&
					server.configuration.osUpdateConfigurationId !== configurationId
						? server.configuration.name
						: null;
				const id = `os-configuration-server-${server.serverId}`;
				return (
					<div key={server.serverId} className="flex items-start gap-2">
						<Checkbox
							id={id}
							checked={selected.has(server.serverId)}
							onCheckedChange={(checked) =>
								onChange(
									checked
										? [...value, server.serverId]
										: value.filter((item) => item !== server.serverId),
								)
							}
						/>
						<Label htmlFor={id} className="block font-normal">
							{server.name}
							<span className="block text-xs text-muted-foreground">
								{server.ipAddress}
								{elsewhere ? ` · leaves ${elsewhere}` : ""}
							</span>
						</Label>
					</div>
				);
			})}
		</div>
	);
};

const ConfigurationForm = ({
	configuration,
	servers,
	onDone,
}: {
	configuration: OsUpdateConfigurationRow | null;
	servers: OsUpdateServerRow[];
	onDone: () => void;
}) => {
	const utils = api.useUtils();
	const create = api.osUpdate.createConfiguration.useMutation();
	const update = api.osUpdate.updateConfiguration.useMutation();
	const [draft, setDraft] = useState<Draft>(() =>
		configuration ? fromConfiguration(configuration) : emptyDraft(),
	);
	const set = (patch: Partial<Draft>) =>
		setDraft((current) => ({ ...current, ...patch }));
	const pending = create.isPending || update.isPending;
	const invalid =
		!draft.name.trim() ||
		!osUpdateScheduleSchema.safeParse(draft.schedule).success ||
		invalidPatterns([
			...draft.settings.includePackages,
			...draft.settings.excludePackages,
		]).length > 0;

	const save = async () => {
		const input = {
			name: draft.name.trim(),
			description: draft.description.trim() || null,
			enabled: draft.enabled,
			schedule: draft.schedule,
			...draft.settings,
			notifyOnSuccess: draft.notifyOnSuccess,
			serverIds: draft.serverIds,
		};
		try {
			if (configuration) {
				await update.mutateAsync({
					...input,
					osUpdateConfigurationId: configuration.osUpdateConfigurationId,
				});
			} else {
				await create.mutateAsync(input);
			}
			await utils.osUpdate.overview.invalidate();
			toast.success(
				configuration
					? `${input.name} saved`
					: `${input.name} created: its servers update in its windows`,
			);
			onDone();
		} catch (error) {
			toast.error(errorText(error, "The configuration could not be saved"));
		}
	};

	return (
		<>
			<div className="grid max-h-[65vh] gap-4 overflow-y-auto pr-1">
				<div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
					<div className="grid gap-2">
						<Label htmlFor="os-configuration-name">Name</Label>
						<Input
							id="os-configuration-name"
							value={draft.name}
							maxLength={64}
							placeholder="Weekly security updates"
							onChange={(event) => set({ name: event.target.value })}
						/>
					</div>
					<div className="flex items-center gap-2 pb-2">
						<Switch
							id="os-configuration-enabled"
							checked={draft.enabled}
							onCheckedChange={(enabled) => set({ enabled })}
						/>
						<Label htmlFor="os-configuration-enabled" className="font-normal">
							Enabled
						</Label>
					</div>
				</div>
				<div className="grid gap-2">
					<Label htmlFor="os-configuration-description">Description</Label>
					<Textarea
						id="os-configuration-description"
						rows={2}
						maxLength={500}
						value={draft.description}
						onChange={(event) => set({ description: event.target.value })}
					/>
				</div>
				<div className="grid gap-2">
					<span className="text-sm font-medium">Maintenance window</span>
					<ScheduleFields
						value={draft.schedule}
						onChange={(schedule) => set({ schedule })}
					/>
				</div>
				<SettingsFields
					id="os-configuration"
					value={draft.settings}
					onChange={(settings) => set({ settings })}
				/>
				<div className="flex items-start justify-between gap-4 rounded-lg border p-3">
					<Label
						htmlFor="os-configuration-notify"
						className="block font-normal"
					>
						Notify successful runs too
						<span className="block text-xs text-muted-foreground">
							Failures and missed windows are always notified, through the
							notifications with "OS Updates" on.
						</span>
					</Label>
					<Switch
						id="os-configuration-notify"
						checked={draft.notifyOnSuccess}
						onCheckedChange={(notifyOnSuccess) => set({ notifyOnSuccess })}
					/>
				</div>
				<fieldset className="grid gap-2">
					<legend className="mb-2 text-sm font-medium">Servers</legend>
					<ServerChoices
						servers={servers}
						configurationId={configuration?.osUpdateConfigurationId ?? null}
						value={draft.serverIds}
						onChange={(serverIds) => set({ serverIds })}
					/>
					<p className="text-xs text-muted-foreground">
						The servers of a configuration update one at a time, Swarm managers
						last. The Dokploy server itself is not listed: rebooting it would
						stop Dokploy during the run.
					</p>
				</fieldset>
			</div>
			<DialogFooter>
				<Button variant="outline" onClick={onDone}>
					Cancel
				</Button>
				<Button onClick={save} disabled={invalid || pending}>
					{pending && <Loader2 className="size-4 animate-spin" />}
					{configuration ? "Save" : "Create"}
				</Button>
			</DialogFooter>
		</>
	);
};

export const HandleConfiguration = ({
	configuration,
	servers,
	open,
	onOpenChange,
}: {
	configuration: OsUpdateConfigurationRow | null;
	servers: OsUpdateServerRow[];
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) => (
	<Dialog open={open} onOpenChange={onOpenChange}>
		<DialogContent className="sm:max-w-3xl">
			<DialogHeader>
				<DialogTitle>
					{configuration
						? `Edit ${configuration.name}`
						: "New maintenance configuration"}
				</DialogTitle>
				<DialogDescription>
					When its servers may install their OS updates, which ones, and whether
					they reboot.
				</DialogDescription>
			</DialogHeader>
			{open && (
				<ConfigurationForm
					configuration={configuration}
					servers={servers}
					onDone={() => onOpenChange(false)}
				/>
			)}
		</DialogContent>
	</Dialog>
);
