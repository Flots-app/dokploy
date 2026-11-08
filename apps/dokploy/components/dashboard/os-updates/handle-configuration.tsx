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
import { AlertBlock } from "@/components/shared/alert-block";
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
	machineDetail,
	type OsUpdateConfigurationRow,
	type OsUpdateMachineRow,
	openWindowWarning,
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
	runnerNodeIds: string[];
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
	runnerNodeIds: [],
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
	runnerNodeIds: row.runnerNodes.map((node) => node.githubRunnerNodeId),
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
							// The days picked read at a glance, not as a hover shade.
							className="data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:hover:bg-primary/90 data-[state=on]:hover:text-primary-foreground"
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
					Next windows ({parsed.data.timeZone}):{" "}
					{upcoming
						.map((window) =>
							dateText(window.start.toISOString(), parsed.data.timeZone),
						)
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

/** The machines a configuration applies to: servers, then runner machines. */
const MachineChoices = ({
	machines,
	configurationId,
	value,
	onChange,
}: {
	machines: OsUpdateMachineRow[];
	configurationId: string | null;
	value: { serverIds: string[]; runnerNodeIds: string[] };
	onChange: (value: { serverIds: string[]; runnerNodeIds: string[] }) => void;
}) => {
	if (machines.length === 0) {
		return (
			<p className="text-sm text-muted-foreground">No remote server yet.</p>
		);
	}
	const selected = new Set([
		...value.serverIds.map((id) => `server:${id}`),
		...value.runnerNodeIds.map((id) => `runner:${id}`),
	]);
	const toggle = (machine: OsUpdateMachineRow, checked: boolean) => {
		const list =
			machine.kind === "server" ? value.serverIds : value.runnerNodeIds;
		const id =
			machine.kind === "server" ? machine.serverId : machine.githubRunnerNodeId;
		const next = checked ? [...list, id] : list.filter((item) => item !== id);
		onChange(
			machine.kind === "server"
				? { ...value, serverIds: next }
				: { ...value, runnerNodeIds: next },
		);
	};
	return (
		<div className="grid gap-2 sm:grid-cols-2">
			{machines.map((machine) => {
				const elsewhere =
					machine.configuration &&
					machine.configuration.osUpdateConfigurationId !== configurationId
						? machine.configuration.name
						: null;
				const id = `os-configuration-${machine.key.replace(":", "-")}`;
				return (
					<div key={machine.key} className="flex items-start gap-2">
						<Checkbox
							id={id}
							checked={selected.has(machine.key)}
							onCheckedChange={(checked) => toggle(machine, checked === true)}
						/>
						<Label htmlFor={id} className="block font-normal">
							{machine.name}
							<span className="block text-xs text-muted-foreground">
								{machineDetail(machine)}
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
	servers: OsUpdateMachineRow[];
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
	// Saving starts installs at once when its window is open.
	const warning =
		draft.enabled &&
		(draft.serverIds.length + draft.runnerNodeIds.length > 0 ||
			(configuration?.hiddenMachines ?? 0) > 0)
			? openWindowWarning(draft.schedule, draft.settings.reboot)
			: null;

	const save = async () => {
		const input = {
			name: draft.name.trim(),
			description: draft.description.trim() || null,
			enabled: draft.enabled,
			schedule: draft.schedule,
			...draft.settings,
			notifyOnSuccess: draft.notifyOnSuccess,
			serverIds: draft.serverIds,
			runnerNodeIds: draft.runnerNodeIds,
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
					: `${input.name} created: its machines update in its windows`,
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
					<legend className="mb-2 text-sm font-medium">Machines</legend>
					<MachineChoices
						machines={servers}
						configurationId={configuration?.osUpdateConfigurationId ?? null}
						value={{
							serverIds: draft.serverIds,
							runnerNodeIds: draft.runnerNodeIds,
						}}
						onChange={set}
					/>
					<p className="text-xs text-muted-foreground">
						The machines of a configuration update one at a time, Swarm managers
						last. A GitHub runner machine stops taking jobs when its turn comes
						and installs once its running jobs end (never interrupted): a long
						job delays the machines after it, and jobs still running at the end
						of the window leave it as it was. The Dokploy server itself is not
						listed: rebooting it would stop Dokploy during the run.
					</p>
				</fieldset>
			</div>
			{warning && <AlertBlock type="warning">{warning}</AlertBlock>}
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
	servers: OsUpdateMachineRow[];
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
					When its machines may install their OS updates, which ones, and
					whether they reboot.
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
