import type {
	GithubRunnerUpdatePolicy,
	GithubRunnerUpdateWindow,
} from "@dokploy/server/db/schema";
import { isTimeZone } from "@dokploy/server/utils/github-runners/updates";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { Toggle } from "@/components/ui/toggle";

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

const browserTimeZone = () => {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	} catch {
		return "UTC";
	}
};

/** Every night of the week, 02:00 to 05:00 in the browser's time zone. */
const defaultUpdateWindow = (): GithubRunnerUpdateWindow => ({
	days: [0, 1, 2, 3, 4, 5, 6],
	start: "02:00",
	end: "05:00",
	timeZone: browserTimeZone(),
});

const timeZones = (() => {
	try {
		return Intl.supportedValuesOf("timeZone");
	} catch {
		return [];
	}
})();

const WindowFields = ({
	id,
	value,
	onChange,
}: {
	id: string;
	value: GithubRunnerUpdateWindow;
	onChange: (value: GithubRunnerUpdateWindow) => void;
}) => {
	const set = (patch: Partial<GithubRunnerUpdateWindow>) =>
		onChange({ ...value, ...patch });
	const toggleDay = (day: number, pressed: boolean) =>
		set({
			days: pressed
				? [...value.days, day]
				: value.days.filter((item) => item !== day),
		});
	const validZone = isTimeZone(value.timeZone);
	return (
		<div className="grid gap-3 rounded-lg border p-3">
			<fieldset className="space-y-2">
				<legend className="text-sm font-medium leading-none">Days</legend>
				<div className="flex flex-wrap gap-1">
					{DAYS.map((day) => (
						<Toggle
							key={day.value}
							variant="outline"
							size="sm"
							pressed={value.days.includes(day.value)}
							onPressedChange={(pressed) => toggleDay(day.value, pressed)}
						>
							{day.label}
						</Toggle>
					))}
				</div>
				{value.days.length === 0 && (
					<p className="text-xs text-destructive">Pick at least one day.</p>
				)}
			</fieldset>
			<div className="grid gap-3 sm:grid-cols-3">
				<div className="space-y-2">
					<Label htmlFor={`${id}-start`}>From</Label>
					<Input
						id={`${id}-start`}
						type="time"
						value={value.start}
						onChange={(event) => set({ start: event.target.value })}
					/>
				</div>
				<div className="space-y-2">
					<Label htmlFor={`${id}-end`}>To</Label>
					<Input
						id={`${id}-end`}
						type="time"
						value={value.end}
						onChange={(event) => set({ end: event.target.value })}
					/>
				</div>
				<div className="space-y-2">
					<Label htmlFor={`${id}-zone`}>Time zone</Label>
					<Input
						id={`${id}-zone`}
						list={`${id}-zones`}
						value={value.timeZone}
						aria-invalid={!validZone}
						onChange={(event) => set({ timeZone: event.target.value.trim() })}
					/>
					<datalist id={`${id}-zones`}>
						{timeZones.map((zone) => (
							<option key={zone} value={zone} />
						))}
					</datalist>
				</div>
			</div>
			{!validZone && (
				<p className="text-xs text-destructive">
					Unknown time zone: pick one such as Europe/Paris.
				</p>
			)}
			{value.start === value.end && (
				<p className="text-xs text-destructive">
					The window must end at another time than it starts.
				</p>
			)}
			<p className="text-xs text-muted-foreground">
				An end before the start runs past midnight: 23:00 to 02:00 on Friday
				ends on Saturday.
			</p>
		</div>
	);
};

/**
 * When Dokploy updates the actions/runner release and its runtime by itself.
 * The OS is never touched: Dokploy only reports its updates.
 */
export const UpdatePolicyFields = ({
	id,
	value,
	onChange,
}: {
	id: string;
	value: GithubRunnerUpdatePolicy;
	onChange: (value: GithubRunnerUpdatePolicy) => void;
}) => (
	<div className="grid gap-3">
		<div className="flex items-start justify-between gap-4">
			<Label htmlFor={`${id}-auto`} className="block font-normal">
				Update the runner and the Dokploy runtime automatically
				<span className="block text-xs text-muted-foreground">
					Installed between jobs: a running job is never interrupted.
				</span>
			</Label>
			<Switch
				id={`${id}-auto`}
				checked={value.auto}
				onCheckedChange={(auto) => onChange({ ...value, auto })}
			/>
		</div>
		{value.auto && (
			<RadioGroup
				value={value.window ? "window" : "any"}
				onValueChange={(choice) =>
					onChange({
						...value,
						window:
							choice === "window"
								? (value.window ?? defaultUpdateWindow())
								: null,
					})
				}
			>
				<Label className="flex items-center gap-3 font-normal">
					<RadioGroupItem value="any" />
					Any time
				</Label>
				<Label className="flex items-center gap-3 font-normal">
					<RadioGroupItem value="window" />
					Only during an update window
				</Label>
			</RadioGroup>
		)}
		{value.auto && value.window && (
			<WindowFields
				id={id}
				value={value.window}
				onChange={(window) => onChange({ ...value, window })}
			/>
		)}
		<p className="text-xs text-muted-foreground">
			Whatever this setting, Dokploy installs a runtime this Dokploy requires,
			and updates the runner 3 days before GitHub stops sending it jobs. "Update
			now" in a machine's menu applies everything at once.
		</p>
	</div>
);
