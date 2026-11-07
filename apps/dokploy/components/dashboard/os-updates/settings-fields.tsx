import type { OsUpdateSettings } from "@dokploy/server/utils/os-updates/filters";
import { DOCKER_PACKAGE_PATTERNS } from "@dokploy/server/utils/os-updates/filters";
import { useState } from "react";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
	CLASSIFICATION_LABELS,
	invalidPatterns,
	parsePatterns,
	REBOOT_LABELS,
} from "./format";

const PatternList = ({
	id,
	label,
	help,
	value,
	onChange,
}: {
	id: string;
	label: string;
	help: string;
	value: string[];
	onChange: (value: string[]) => void;
}) => {
	// The text as typed; the list follows it.
	const [text, setText] = useState(() => value.join("\n"));
	const invalid = invalidPatterns(value);
	return (
		<div className="grid gap-2">
			<Label htmlFor={id}>{label}</Label>
			<Textarea
				id={id}
				rows={3}
				placeholder="nginx*"
				className="font-mono text-xs"
				value={text}
				aria-invalid={invalid.length > 0}
				onChange={(event) => {
					setText(event.target.value);
					onChange(parsePatterns(event.target.value));
				}}
			/>
			<p className="text-xs text-muted-foreground">{help}</p>
			{invalid.length > 0 && (
				<p className="text-xs text-destructive">
					Not a package name: {invalid.join(", ")}. Use lowercase letters,
					digits, + - . : and the wildcards * and ?.
				</p>
			)}
		</div>
	);
};

/** What a run installs, and whether it reboots: shared by both forms. */
export const SettingsFields = ({
	id,
	value,
	onChange,
}: {
	id: string;
	value: OsUpdateSettings;
	onChange: (value: OsUpdateSettings) => void;
}) => {
	const set = (patch: Partial<OsUpdateSettings>) =>
		onChange({ ...value, ...patch });
	return (
		<div className="grid gap-4">
			<fieldset className="grid gap-2">
				<legend className="mb-2 text-sm font-medium">Updates</legend>
				<RadioGroup
					value={value.classification}
					onValueChange={(classification) =>
						set({
							classification:
								classification as OsUpdateSettings["classification"],
						})
					}
				>
					{(["security", "all"] as const).map((item) => (
						<div key={item} className="flex items-center gap-2">
							<RadioGroupItem value={item} id={`${id}-class-${item}`} />
							<Label htmlFor={`${id}-class-${item}`} className="font-normal">
								{CLASSIFICATION_LABELS[item]}
							</Label>
						</div>
					))}
				</RadioGroup>
				<p className="text-xs text-muted-foreground">
					A security update comes from the distribution's security pocket
					(noble-security, bookworm-security…).
				</p>
			</fieldset>
			<div className="grid gap-4 sm:grid-cols-2">
				<PatternList
					id={`${id}-include`}
					label="Only these packages"
					help="Empty: every update of the kind above. Wildcards: * and ?."
					value={value.includePackages}
					onChange={(includePackages) => set({ includePackages })}
				/>
				<PatternList
					id={`${id}-exclude`}
					label="Never these packages"
					help="Wins over the list on the left. Held at their installed version."
					value={value.excludePackages}
					onChange={(excludePackages) => set({ excludePackages })}
				/>
			</div>
			<div className="flex items-start justify-between gap-4 rounded-lg border p-3">
				<Label htmlFor={`${id}-docker`} className="block font-normal">
					Update Docker too
					<span className="block text-xs text-muted-foreground">
						Upgrading {DOCKER_PACKAGE_PATTERNS.join(", ")} restarts the Docker
						daemon and every container of the server. Off: they are held at
						their version.
					</span>
				</Label>
				<Switch
					id={`${id}-docker`}
					checked={value.allowDockerUpdates}
					onCheckedChange={(allowDockerUpdates) => set({ allowDockerUpdates })}
				/>
			</div>
			<div className="grid gap-2">
				<Label htmlFor={`${id}-reboot`}>Reboot</Label>
				<Select
					value={value.reboot}
					onValueChange={(reboot) =>
						set({ reboot: reboot as OsUpdateSettings["reboot"] })
					}
				>
					<SelectTrigger id={`${id}-reboot`}>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{(["if-required", "never", "always"] as const).map((item) => (
							<SelectItem key={item} value={item}>
								{REBOOT_LABELS[item]}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<p className="text-xs text-muted-foreground">
					An update asks for a reboot through /var/run/reboot-required (a new
					kernel, libc…). No reboot starts once the window closed, and a Swarm
					manager reboots only while the other managers are reachable.
				</p>
			</div>
		</div>
	);
};
