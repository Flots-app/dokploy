import {
	DEFAULT_OS_UPDATE_SETTINGS,
	type OsUpdateSettings,
} from "@dokploy/server/utils/os-updates/filters";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
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
import { api } from "@/utils/api";
import { errorText } from "../github-runners/format";
import {
	invalidPatterns,
	type OsUpdateConfigurationRow,
	type OsUpdateServerRow,
} from "./format";
import { SettingsFields } from "./settings-fields";

const InstallForm = ({
	server,
	configuration,
	onDone,
}: {
	server: OsUpdateServerRow;
	configuration: OsUpdateConfigurationRow | null;
	onDone: () => void;
}) => {
	const utils = api.useUtils();
	const install = api.osUpdate.installNow.useMutation();
	// The server's configuration, when it has one.
	const [settings, setSettings] = useState<OsUpdateSettings>(() =>
		configuration
			? {
					classification: configuration.classification,
					includePackages: configuration.includePackages,
					excludePackages: configuration.excludePackages,
					reboot: configuration.reboot,
					allowDockerUpdates: configuration.allowDockerUpdates,
				}
			: DEFAULT_OS_UPDATE_SETTINGS,
	);
	const [hours, setHours] = useState(2);
	const invalid =
		invalidPatterns([...settings.includePackages, ...settings.excludePackages])
			.length > 0 || !(hours >= 0.5 && hours <= 12);

	const submit = async () => {
		try {
			await install.mutateAsync({
				serverId: server.serverId,
				...settings,
				maxDurationMinutes: Math.round(hours * 60),
			});
			await Promise.all([
				utils.osUpdate.overview.invalidate(),
				utils.osUpdate.runs.invalidate(),
			]);
			toast.success(`Installing the updates of ${server.name}: see History`);
			onDone();
		} catch (error) {
			toast.error(errorText(error, "The installation could not start"));
		}
	};

	return (
		<>
			<div className="grid max-h-[65vh] gap-4 overflow-y-auto pr-1">
				<SettingsFields
					id="os-install"
					value={settings}
					onChange={setSettings}
				/>
				<div className="grid gap-2">
					<Label htmlFor="os-install-hours">
						No install starts after (hours)
					</Label>
					<Input
						id="os-install-hours"
						type="number"
						min={0.5}
						max={12}
						step={0.5}
						value={hours}
						onChange={(event) => setHours(Number(event.target.value))}
					/>
					<p className="text-xs text-muted-foreground">
						Like the end of a maintenance window: the run gives up instead of
						starting the install or the reboot later than this.
					</p>
				</div>
			</div>
			<DialogFooter>
				<Button variant="outline" onClick={onDone}>
					Cancel
				</Button>
				<Button onClick={submit} disabled={invalid || install.isPending}>
					{install.isPending && <Loader2 className="size-4 animate-spin" />}
					Install now
				</Button>
			</DialogFooter>
		</>
	);
};

/** A one-time installation outside the schedule. */
export const InstallNowDialog = ({
	server,
	configuration,
	open,
	onOpenChange,
}: {
	server: OsUpdateServerRow;
	configuration: OsUpdateConfigurationRow | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) => (
	<Dialog open={open} onOpenChange={onOpenChange}>
		<DialogContent className="sm:max-w-2xl">
			<DialogHeader>
				<DialogTitle>Install the updates of {server.name} now</DialogTitle>
				<DialogDescription>
					Runs once, outside any window: it refreshes the package lists,
					installs the updates you pick, then reboots if you allow it.
				</DialogDescription>
			</DialogHeader>
			{open && (
				<InstallForm
					server={server}
					configuration={configuration}
					onDone={() => onOpenChange(false)}
				/>
			)}
		</DialogContent>
	</Dialog>
);
