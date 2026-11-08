import { isDockerPackage } from "@dokploy/server/utils/os-updates/filters";
import { describeSchedule } from "@dokploy/server/utils/os-updates/schedule";
import { formatDistanceToNow } from "date-fns";
import {
	CalendarClock,
	Loader2,
	MoreHorizontal,
	Pencil,
	Plus,
	RefreshCw,
	Trash2,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { AlertBlock } from "@/components/shared/alert-block";
import { DialogAction } from "@/components/shared/dialog-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/utils/api";
import { errorText } from "../github-runners/format";
import { ConfirmChange } from "./confirm-change";
import {
	browserTimeZone,
	CLASSIFICATION_LABELS,
	dateText,
	machineActive,
	machineDetail,
	machineInput,
	machineRows,
	type OsUpdateConfigurationRow,
	type OsUpdateMachineRow,
	openWindowWarning,
	REBOOT_LABELS,
	RUN_STATUS,
	zonedDateText,
} from "./format";
import { HandleConfiguration } from "./handle-configuration";
import { InstallNowDialog } from "./install-now";
import { MacsTable } from "./macos-handoff";
import { RunHistory } from "./run-history";

const NONE = "none";

const PendingPackagesDialog = ({
	server,
	open,
	onOpenChange,
}: {
	server: OsUpdateMachineRow;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) => {
	// Security updates first: they are the ones a schedule installs by default.
	const packages = (server.assessment?.packages ?? [])
		.filter((item) => item.from !== null)
		.sort(
			(a, b) =>
				Number(b.security) - Number(a.security) || a.name.localeCompare(b.name),
		);
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>Pending updates of {server.name}</DialogTitle>
					<DialogDescription>
						As of the last assessment ({zonedDateText(server.assessedAt)}).
					</DialogDescription>
				</DialogHeader>
				{packages.length === 0 ? (
					<p className="text-sm text-muted-foreground">Nothing pending.</p>
				) : (
					<div className="overflow-auto rounded border">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Package</TableHead>
									<TableHead>Installed</TableHead>
									<TableHead>Available</TableHead>
									<TableHead>From</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{packages.map((item) => (
									<TableRow key={item.name}>
										<TableCell className="font-mono text-xs">
											{item.name}
											{item.security && (
												<Badge variant="orange" className="ml-2">
													security
												</Badge>
											)}
											{isDockerPackage(item.name) && (
												<Badge variant="blank" className="ml-2">
													Docker
												</Badge>
											)}
										</TableCell>
										{/* Long Debian versions wrap instead of pushing From out. */}
										<TableCell className="font-mono text-xs whitespace-normal break-all">
											{item.from}
										</TableCell>
										<TableCell className="font-mono text-xs whitespace-normal break-all">
											{item.to}
										</TableCell>
										<TableCell className="min-w-40 text-xs whitespace-normal text-muted-foreground">
											{item.origins}
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</div>
				)}
				{(server.assessment?.keptBack.length ?? 0) > 0 && (
					<p className="text-xs text-muted-foreground">
						Kept back by apt (phased updates, or needing a removal):{" "}
						{server.assessment?.keptBack.join(", ")}
					</p>
				)}
			</DialogContent>
		</Dialog>
	);
};

type Assessment = NonNullable<OsUpdateMachineRow["assessment"]>;

/** Pending updates, a pending reboot, dpkg and Swarm, as badges. */
const AssessmentBadges = ({ assessment }: { assessment: Assessment }) => {
	const pending = assessment.packages.filter((item) => item.from !== null);
	const security = pending.filter((item) => item.security).length;
	return (
		<span className="flex flex-wrap items-center gap-1">
			{pending.length === 0 ? (
				<Badge variant="green">up to date</Badge>
			) : (
				<Badge variant={security ? "orange" : "blank"}>
					{pending.length} pending
					{security ? `, ${security} security` : ""}
				</Badge>
			)}
			{assessment.rebootRequired && (
				<Badge variant="yellow">reboot pending</Badge>
			)}
			{assessment.dpkgInterrupted && (
				<Badge variant="red">dpkg interrupted</Badge>
			)}
			{assessment.swarm?.state === "active" && (
				<Badge variant="blank">
					Swarm {assessment.swarm.manager ? "manager" : "worker"}
				</Badge>
			)}
		</span>
	);
};

/** What the last assessment says, in a cell. */
const AssessmentCell = ({ server }: { server: OsUpdateMachineRow }) => {
	const assessment = server.assessment;
	if (server.assessmentRequested) {
		return (
			<span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
				<Loader2 className="size-3 animate-spin" /> Checking
				{server.assessmentError ? ` (${server.assessmentError})` : ""}
			</span>
		);
	}
	if (!assessment) {
		return server.assessmentError ? (
			<span
				className="line-clamp-3 text-xs text-destructive"
				title={server.assessmentError}
			>
				{server.assessmentError}
			</span>
		) : (
			<span className="text-xs text-muted-foreground">Not checked yet</span>
		);
	}
	const os = assessment.os.pretty || assessment.os.id;
	if (!assessment.supported) {
		return (
			<span className="text-xs text-muted-foreground">
				{os}: not apt-based, not supported
			</span>
		);
	}
	const checked = server.assessedAt
		? formatDistanceToNow(new Date(server.assessedAt), { addSuffix: true })
		: "never";
	return (
		<div className="grid gap-1 text-xs">
			<AssessmentBadges assessment={assessment} />
			<span className="text-muted-foreground">
				{os} · checked {checked}
			</span>
			{server.assessmentError && (
				<span className="text-destructive">{server.assessmentError}</span>
			)}
		</div>
	);
};

const MachineActions = ({
	server,
	configuration,
	canRun,
	canUpdate,
}: {
	server: OsUpdateMachineRow;
	configuration: OsUpdateConfigurationRow | null;
	canRun: boolean;
	canUpdate: boolean;
}) => {
	const utils = api.useUtils();
	const check = api.osUpdate.checkNow.useMutation();
	const periodic = api.osUpdate.setPeriodicAssessment.useMutation();
	const [dialog, setDialog] = useState<"install" | "packages" | null>(null);
	const active = machineActive(server);
	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						size="icon"
						variant="ghost"
						aria-label={`Actions for ${server.name}`}
					>
						<MoreHorizontal className="size-4" />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="w-52">
					{canRun && (
						<>
							<DropdownMenuItem
								disabled={!active || check.isPending}
								onSelect={async () => {
									try {
										await check.mutateAsync(machineInput(server));
										await utils.osUpdate.overview.invalidate();
										toast.success(`Checking the updates of ${server.name}`);
									} catch (error) {
										toast.error(errorText(error, "The check could not start"));
									}
								}}
							>
								Check now
							</DropdownMenuItem>
							<DropdownMenuItem
								disabled={!active || server.assessment?.supported === false}
								onSelect={() => setDialog("install")}
							>
								Install now…
							</DropdownMenuItem>
						</>
					)}
					<DropdownMenuItem
						disabled={!server.assessment}
						onSelect={() => setDialog("packages")}
					>
						Pending updates…
					</DropdownMenuItem>
					{canUpdate && (
						<>
							<DropdownMenuSeparator />
							<DropdownMenuCheckboxItem
								checked={server.periodicAssessment}
								disabled={periodic.isPending}
								onCheckedChange={async (checked) => {
									try {
										await periodic.mutateAsync({
											...machineInput(server),
											periodicAssessment: checked,
										});
										await utils.osUpdate.overview.invalidate();
									} catch (error) {
										toast.error(errorText(error, "The setting was not saved"));
									}
								}}
							>
								Check every 24 hours
							</DropdownMenuCheckboxItem>
						</>
					)}
				</DropdownMenuContent>
			</DropdownMenu>
			<InstallNowDialog
				server={server}
				configuration={configuration}
				open={dialog === "install"}
				onOpenChange={(open) => setDialog(open ? "install" : null)}
			/>
			<PendingPackagesDialog
				server={server}
				open={dialog === "packages"}
				onOpenChange={(open) => setDialog(open ? "packages" : null)}
			/>
		</>
	);
};

const AssignSelect = ({
	server,
	configurations,
	disabled,
}: {
	server: OsUpdateMachineRow;
	configurations: OsUpdateConfigurationRow[];
	disabled: boolean;
}) => {
	const utils = api.useUtils();
	const assign = api.osUpdate.assign.useMutation();
	// A configuration whose window is open: confirmed first.
	const [pending, setPending] = useState<{
		value: string;
		warning: string;
	} | null>(null);
	const save = async (value: string) => {
		try {
			await assign.mutateAsync({
				...machineInput(server),
				osUpdateConfigurationId: value === NONE ? null : value,
			});
			await utils.osUpdate.overview.invalidate();
		} catch (error) {
			toast.error(errorText(error, "The machine could not be assigned"));
		}
	};
	return (
		<>
			<Select
				value={server.configuration?.osUpdateConfigurationId ?? NONE}
				disabled={disabled || assign.isPending}
				onValueChange={(value) => {
					const target = configurations.find(
						(item) => item.osUpdateConfigurationId === value,
					);
					const warning = target?.enabled
						? openWindowWarning(target.schedule, target.reboot)
						: null;
					if (warning) setPending({ value, warning });
					else void save(value);
				}}
			>
				<SelectTrigger
					className="h-8 w-52"
					aria-label={`Schedule of ${server.name}`}
					title={server.configuration?.name}
				>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value={NONE}>No schedule</SelectItem>
					{configurations.map((configuration) => (
						<SelectItem
							key={configuration.osUpdateConfigurationId}
							value={configuration.osUpdateConfigurationId}
						>
							{configuration.name}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			<ConfirmChange
				message={
					pending
						? `${server.name} joins it now.${server.kind === "runner" ? " It stops taking jobs once its window opens, until its updates are installed." : ""} ${pending.warning}`
						: null
				}
				onConfirm={() => {
					if (pending) void save(pending.value);
				}}
				onCancel={() => setPending(null)}
			/>
		</>
	);
};

/**
 * In the schedule's own time zone, said. The date never breaks at its
 * hyphens: a narrow cell wraps between the words only.
 */
const WindowText = ({
	configuration,
}: {
	configuration: OsUpdateMachineRow["configuration"];
}) => {
	if (!configuration) return "—";
	if (!configuration.enabled) return "configuration disabled";
	const { window, timeZone } = configuration;
	const at = window.open ? window.open.end : window.next?.start;
	if (!at) return "—";
	return (
		<>
			{window.open && "open until "}
			<span className="whitespace-nowrap">{dateText(at, timeZone)}</span>{" "}
			<span className="text-muted-foreground">({timeZone})</span>
		</>
	);
};

const MachinesTable = ({
	servers,
	configurations,
	canRun,
	canUpdate,
}: {
	servers: OsUpdateMachineRow[];
	configurations: OsUpdateConfigurationRow[];
	canRun: boolean;
	canUpdate: boolean;
}) => {
	if (!servers.length) {
		return (
			<div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
				No remote server yet: add one in Remote Servers. GitHub runner machines
				show here too (the Linux VM of a Mac). The Dokploy server itself is not
				updated from here.
			</div>
		);
	}
	const zone = browserTimeZone();
	return (
		<div className="overflow-x-auto rounded-lg border">
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>Machine</TableHead>
						<TableHead>Updates</TableHead>
						<TableHead>Schedule</TableHead>
						<TableHead>Next window</TableHead>
						<TableHead>Last run ({zone})</TableHead>
						<TableHead />
					</TableRow>
				</TableHeader>
				<TableBody>
					{servers.map((server) => {
						const configuration =
							configurations.find(
								(item) =>
									item.osUpdateConfigurationId ===
									server.configuration?.osUpdateConfigurationId,
							) ?? null;
						const last = server.lastRun;
						return (
							<TableRow key={server.key}>
								<TableCell>
									<span className="block font-medium">{server.name}</span>
									<span className="block min-w-44 max-w-60 text-xs whitespace-normal text-muted-foreground">
										{machineDetail(server)}
									</span>
								</TableCell>
								<TableCell className="whitespace-normal">
									{/* Wide enough for its badges and an error on a few lines. */}
									<div className="min-w-60 max-w-96">
										<AssessmentCell server={server} />
									</div>
								</TableCell>
								<TableCell>
									<AssignSelect
										server={server}
										configurations={configurations}
										disabled={!canUpdate}
									/>
								</TableCell>
								<TableCell className="min-w-36 text-xs whitespace-normal">
									<WindowText configuration={server.configuration} />
								</TableCell>
								<TableCell>
									{last ? (
										<span className="grid gap-1 text-xs">
											<Badge variant={RUN_STATUS[last.status].variant}>
												{RUN_STATUS[last.status].label}
											</Badge>
											<span className="text-muted-foreground">
												{dateText(
													last.finishedAt ?? last.startedAt ?? last.createdAt,
													zone,
												)}
											</span>
										</span>
									) : (
										<span className="text-xs text-muted-foreground">—</span>
									)}
								</TableCell>
								<TableCell>
									<MachineActions
										server={server}
										configuration={configuration}
										canRun={canRun}
										canUpdate={canUpdate}
									/>
								</TableCell>
							</TableRow>
						);
					})}
				</TableBody>
			</Table>
		</div>
	);
};

const ConfigurationCard = ({
	configuration,
	servers,
	canUpdate,
	canDelete,
}: {
	configuration: OsUpdateConfigurationRow;
	servers: OsUpdateMachineRow[];
	canUpdate: boolean;
	canDelete: boolean;
}) => {
	const utils = api.useUtils();
	const setEnabled = api.osUpdate.setEnabled.useMutation();
	const remove = api.osUpdate.removeConfiguration.useMutation();
	const [editing, setEditing] = useState(false);
	// Enabling while its window is open starts installs: confirmed first.
	const [warning, setWarning] = useState<string | null>(null);
	const toggle = async (enabled: boolean) => {
		try {
			await setEnabled.mutateAsync({
				osUpdateConfigurationId: configuration.osUpdateConfigurationId,
				enabled,
			});
			await utils.osUpdate.overview.invalidate();
		} catch (error) {
			toast.error(errorText(error, "The configuration was not saved"));
		}
	};
	const zone = configuration.schedule.timeZone;
	const hasServers =
		configuration.servers.length +
			configuration.runnerNodes.length +
			configuration.hiddenMachines >
		0;
	const names = [
		...configuration.servers.map((server) => server.name),
		...configuration.runnerNodes.map((node) => `${node.name} (runner)`),
	];
	const filters = [
		configuration.includePackages.length
			? `only ${configuration.includePackages.join(", ")}`
			: null,
		configuration.excludePackages.length
			? `never ${configuration.excludePackages.join(", ")}`
			: null,
	].filter(Boolean);
	return (
		<Card className="bg-transparent">
			<CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
				<div className="space-y-1">
					<CardTitle className="flex items-center gap-2 text-lg">
						<CalendarClock className="size-4" />
						{configuration.name}
						{!configuration.enabled && <Badge variant="blank">disabled</Badge>}
					</CardTitle>
					<CardDescription>
						{describeSchedule(configuration.schedule)}
					</CardDescription>
					{configuration.description && (
						<CardDescription>{configuration.description}</CardDescription>
					)}
				</div>
				<div className="flex shrink-0 items-center gap-1">
					{canUpdate && (
						<>
							<Switch
								checked={configuration.enabled}
								disabled={setEnabled.isPending}
								aria-label={`${configuration.name} enabled`}
								onCheckedChange={(enabled) => {
									const open =
										enabled && hasServers
											? openWindowWarning(
													configuration.schedule,
													configuration.reboot,
												)
											: null;
									if (open) setWarning(open);
									else void toggle(enabled);
								}}
							/>
							<Button
								size="icon"
								variant="ghost"
								aria-label="Edit"
								onClick={() => setEditing(true)}
							>
								<Pencil className="size-4" />
							</Button>
						</>
					)}
					{canDelete && (
						<DialogAction
							title={`Delete ${configuration.name}?`}
							description="Its machines keep their history but have no schedule any more: they install nothing until you assign them again."
							type="destructive"
							onClick={async () => {
								try {
									await remove.mutateAsync({
										osUpdateConfigurationId:
											configuration.osUpdateConfigurationId,
									});
									await utils.osUpdate.overview.invalidate();
									toast.success(`${configuration.name} deleted`);
								} catch (error) {
									toast.error(
										errorText(error, "The configuration could not be deleted"),
									);
								}
							}}
						>
							<Button size="icon" variant="ghost" aria-label="Delete">
								<Trash2 className="size-4 text-destructive" />
							</Button>
						</DialogAction>
					)}
				</div>
			</CardHeader>
			<CardContent className="grid gap-2 text-sm">
				<div className="flex flex-wrap gap-2">
					<Badge variant="outline">
						{CLASSIFICATION_LABELS[configuration.classification]}
					</Badge>
					<Badge variant="outline">{REBOOT_LABELS[configuration.reboot]}</Badge>
					<Badge variant="outline">
						{configuration.allowDockerUpdates
							? "Docker updated (restarts containers)"
							: "Docker held"}
					</Badge>
					{filters.map((filter) => (
						<Badge key={filter} variant="outline">
							{filter}
						</Badge>
					))}
				</div>
				<p className="text-muted-foreground">
					{configuration.window.open
						? `Window open until ${zonedDateText(configuration.window.open.end, zone)}`
						: configuration.window.next
							? `Next window: ${dateText(configuration.window.next.start, zone)} to ${zonedDateText(configuration.window.next.end, zone)}`
							: "No upcoming window"}
					{" · "}
					{names.length ? names.join(", ") : "no machine"}
					{configuration.hiddenMachines > 0 &&
						`, and ${configuration.hiddenMachines} machine${configuration.hiddenMachines === 1 ? "" : "s"} you cannot access`}
				</p>
			</CardContent>
			<ConfirmChange
				message={warning}
				onConfirm={() => void toggle(true)}
				onCancel={() => setWarning(null)}
			/>
			<HandleConfiguration
				configuration={configuration}
				servers={servers}
				open={editing}
				onOpenChange={setEditing}
			/>
		</Card>
	);
};

export const ShowOsUpdates = () => {
	const { data: permissions } = api.user.getPermissions.useQuery();
	const { data, isPending, error } = api.osUpdate.overview.useQuery(undefined, {
		refetchInterval: 10_000,
	});
	const [creating, setCreating] = useState(false);
	const canCreate = Boolean(permissions?.osUpdate.create);
	const canUpdate = Boolean(permissions?.osUpdate.update);
	const canDelete = Boolean(permissions?.osUpdate.delete);
	const canRun = Boolean(permissions?.osUpdate.run);
	const servers = data ? machineRows(data) : [];
	const configurations = data?.configurations ?? [];

	return (
		<div className="w-full">
			<Card className="h-full bg-sidebar p-2.5 rounded-xl">
				<div className="rounded-xl bg-background shadow-md">
					<CardHeader className="flex flex-row items-start justify-between gap-4">
						<div className="space-y-1">
							<CardTitle className="flex items-center gap-2 text-xl">
								<RefreshCw className="size-5" />
								OS Updates
							</CardTitle>
							<CardDescription>
								Keep the remote servers and the GitHub runner machines patched:
								choose when they may install their updates (Ubuntu and Debian,
								through apt), and Dokploy installs them in that window, one
								machine at a time, rebooting when an update asks for it. A
								runner machine stops taking jobs first, and installs once its
								running jobs end; on a Mac, that is its Linux VM, and macOS is
								handed to its owner.
							</CardDescription>
						</div>
						{canCreate && (
							<Button onClick={() => setCreating(true)}>
								<Plus className="size-4" />
								New configuration
							</Button>
						)}
					</CardHeader>
					<CardContent className="grid grid-cols-1 gap-4">
						{error && (
							<AlertBlock type="error">
								{errorText(error, "The OS updates could not be loaded")}
							</AlertBlock>
						)}
						{isPending && (
							<div className="flex items-center gap-2 text-sm text-muted-foreground">
								<Loader2 className="size-4 animate-spin" /> Loading
							</div>
						)}
						{data && (
							<Tabs defaultValue="servers" className="min-w-0">
								<TabsList>
									<TabsTrigger value="servers">Machines</TabsTrigger>
									<TabsTrigger value="configurations">
										Configurations ({configurations.length})
									</TabsTrigger>
									<TabsTrigger value="history">History</TabsTrigger>
								</TabsList>
								<TabsContent
									value="servers"
									className="grid grid-cols-1 gap-3 pt-2"
								>
									{servers.some(
										(server) =>
											server.assessment?.packages.some(
												(item) => item.security && item.from !== null,
											) && !server.configuration,
									) && (
										<AlertBlock type="warning">
											Some machines wait for security updates and have no
											schedule.
										</AlertBlock>
									)}
									<MachinesTable
										servers={servers}
										configurations={configurations}
										canRun={canRun}
										canUpdate={canUpdate}
									/>
									{data.macs.length > 0 && (
										<MacsTable macs={data.macs} canRun={canRun} />
									)}
								</TabsContent>
								<TabsContent
									value="configurations"
									className="grid grid-cols-1 gap-3 pt-2"
								>
									{configurations.length === 0 ? (
										<div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
											No maintenance configuration yet. One says when its
											machines may install updates (a weekly night, say) and
											which ones.
										</div>
									) : (
										configurations.map((configuration) => (
											<ConfigurationCard
												key={configuration.osUpdateConfigurationId}
												configuration={configuration}
												servers={servers}
												canUpdate={canUpdate}
												canDelete={canDelete}
											/>
										))
									)}
								</TabsContent>
								<TabsContent value="history" className="min-w-0 pt-2">
									<RunHistory canRun={canRun} />
								</TabsContent>
							</Tabs>
						)}
					</CardContent>
				</div>
			</Card>
			<HandleConfiguration
				configuration={null}
				servers={servers}
				open={creating}
				onOpenChange={setCreating}
			/>
		</div>
	);
};
