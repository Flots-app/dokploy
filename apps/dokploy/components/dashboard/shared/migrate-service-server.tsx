import {
	ArrowLeftRight,
	CheckCircle2,
	CircleMinus,
	Loader2,
	TriangleAlert,
	XCircle,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AlertBlock } from "@/components/shared/alert-block";
import { DateTooltip } from "@/components/shared/date-tooltip";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { api, type RouterOutputs } from "@/utils/api";

export type MigratableService =
	| "application"
	| "compose"
	| "postgres"
	| "mysql"
	| "mariadb"
	| "mongo"
	| "redis"
	| "libsql";

type Analysis = RouterOutputs["serviceMigration"]["analyze"];
type Check = Analysis["checks"][number];
type PlanItem = Analysis["plan"][number];
type Migration = RouterOutputs["serviceMigration"]["one"];
type Targets = RouterOutputs["serviceMigration"]["targets"];
type History = RouterOutputs["serviceMigration"]["history"];

interface MigrationOptions {
	removeSourceData: boolean;
	replaceTargetData: boolean;
	zeroDowntime: boolean;
	keepSourceRunning: boolean;
}

const DOKPLOY_SERVER = "dokploy";

const formatBytes = (bytes?: number | null) => {
	if (bytes === null || bytes === undefined) return "";
	const units = ["B", "KB", "MB", "GB", "TB"];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
};

const checkIcons: Record<Check["status"], React.ReactNode> = {
	pass: <CheckCircle2 className="size-4 text-emerald-500" />,
	warn: <TriangleAlert className="size-4 text-amber-500" />,
	fail: <XCircle className="size-4 text-red-500" />,
	skip: <CircleMinus className="size-4 text-muted-foreground" />,
};

const categories: Array<{ id: PlanItem["category"]; label: string }> = [
	{ id: "runtime", label: "Runtime" },
	{ id: "data", label: "Data" },
	{ id: "configuration", label: "Configuration" },
	{ id: "routing", label: "Domains & routing" },
	{ id: "automation", label: "Backups & schedules" },
	{ id: "history", label: "History & source server" },
];

const actions: Record<
	PlanItem["action"],
	{ label: string; variant: "blue" | "green" | "yellow" | "red" | "blank" }
> = {
	copy: { label: "Copied", variant: "blue" },
	recreate: { label: "Recreated", variant: "green" },
	pull: { label: "Pulled", variant: "green" },
	follow: { label: "Follows", variant: "blank" },
	remove: { label: "Removed", variant: "red" },
	skip: { label: "Not copied", variant: "yellow" },
};

const migrationStatus: Record<
	Migration["status"],
	{ label: string; variant: "blue" | "green" | "yellow" | "red" }
> = {
	running: { label: "Running", variant: "blue" },
	done: { label: "Migrated", variant: "green" },
	rolled_back: { label: "Rolled back", variant: "yellow" },
	error: { label: "Failed", variant: "red" },
};

const errorMessage = (error: unknown, fallback: string) =>
	error instanceof Error ? error.message : fallback;

const ChecksList = ({ checks }: { checks: Check[] }) => (
	<div className="flex flex-col divide-y rounded-lg border">
		{checks.map((check) => (
			<div key={check.id} className="flex items-start gap-3 p-3">
				<div className="mt-0.5 shrink-0">{checkIcons[check.status]}</div>
				<div className="flex min-w-0 flex-col gap-0.5">
					<span className="text-sm font-medium">{check.label}</span>
					<span className="text-sm text-muted-foreground wrap-break-word">
						{check.message}
					</span>
				</div>
			</div>
		))}
	</div>
);

const PlanRow = ({ item }: { item: PlanItem }) => (
	<div className="flex items-start justify-between gap-3 p-3">
		<div className="flex min-w-0 flex-col gap-0.5">
			<div className="flex flex-wrap items-center gap-2">
				<Badge variant={actions[item.action].variant}>
					{actions[item.action].label}
				</Badge>
				<span className="text-sm font-medium break-all">{item.label}</span>
			</div>
			{item.detail && (
				<span className="text-sm text-muted-foreground wrap-break-word">
					{item.detail}
				</span>
			)}
		</div>
		{item.sizeBytes !== undefined && (
			<span className="shrink-0 text-sm tabular-nums text-muted-foreground">
				{formatBytes(item.sizeBytes)}
			</span>
		)}
	</div>
);

const MigrationPlan = ({ plan }: { plan: PlanItem[] }) => (
	<div className="flex flex-col gap-4">
		{categories.map((category) => {
			const items = plan.filter((item) => item.category === category.id);
			if (items.length === 0) return null;
			return (
				<div key={category.id} className="flex flex-col gap-2">
					<span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
						{category.label}
					</span>
					<div className="flex flex-col divide-y rounded-lg border">
						{items.map((item) => (
							<PlanRow
								key={`${item.action}:${item.label}:${item.detail ?? ""}`}
								item={item}
							/>
						))}
					</div>
				</div>
			);
		})}
	</div>
);

const AnalysisResult = ({ analysis }: { analysis: Analysis }) => {
	const count = (status: Check["status"]) =>
		analysis.checks.filter((check) => check.status === status).length;
	const warnings = count("warn");
	const failures = count("fail");
	return (
		<div className="flex flex-col gap-5">
			<div className="flex flex-wrap items-center gap-2 text-sm">
				<Badge variant="green">{count("pass")} passed</Badge>
				{warnings > 0 && <Badge variant="yellow">{warnings} warning(s)</Badge>}
				{failures > 0 && <Badge variant="red">{failures} failed</Badge>}
				<span className="text-muted-foreground">
					{analysis.source.name} → {analysis.target.name} ·{" "}
					{formatBytes(analysis.totalBytes)} to copy ·{" "}
					{analysis.requiresDowntime
						? "downtime during the copy"
						: "no downtime expected"}
				</span>
			</div>
			<div className="flex flex-col gap-2">
				<span className="text-sm font-semibold">Pre-flight checks</span>
				<ChecksList checks={analysis.checks} />
			</div>
			{analysis.plan.length > 0 && (
				<div className="flex flex-col gap-2">
					<span className="text-sm font-semibold">What will be migrated</span>
					<MigrationPlan plan={analysis.plan} />
				</div>
			)}
			{!analysis.canMigrate && (
				<AlertBlock type="error">
					Fix the failed checks, then run them again to enable the migration.
				</AlertBlock>
			)}
		</div>
	);
};

const KeptSourceNotice = ({ migration }: { migration: Migration }) => {
	const utils = api.useUtils();
	const finalize = api.serviceMigration.finalize.useMutation();
	const finishMigration = async () => {
		try {
			await finalize.mutateAsync({
				serviceMigrationId: migration.serviceMigrationId,
			});
			toast.success(
				"Migration finished, the source no longer runs the service",
			);
		} catch (error) {
			toast.error(errorMessage(error, "Unable to finish the migration"));
		} finally {
			await utils.serviceMigration.invalidate();
		}
	};
	return (
		<AlertBlock type="info">
			<div className="flex flex-col gap-2">
				<span>
					{migration.sourceServerName} still runs the previous copy so visitors
					resolving the old IP keep being served. Point the DNS records of the
					domains to {migration.targetServerName}, wait for the propagation,
					then finish the migration to remove it from{" "}
					{migration.sourceServerName}.
				</span>
				<div>
					<Button
						size="sm"
						onClick={finishMigration}
						isLoading={finalize.isPending}
					>
						Finish migration
					</Button>
				</div>
			</div>
		</AlertBlock>
	);
};

const MigrationProgress = ({
	serviceMigrationId,
}: {
	serviceMigrationId: string;
}) => {
	const utils = api.useUtils();
	const { data } = api.serviceMigration.one.useQuery(
		{ serviceMigrationId },
		{
			refetchInterval: (query) =>
				query.state.data?.status === "running" ? 1500 : false,
		},
	);
	const logRef = useRef<HTMLPreElement>(null);
	const status = data?.status;
	const startedRunning = useRef(false);

	useEffect(() => {
		if (logRef.current) {
			logRef.current.scrollTop = logRef.current.scrollHeight;
		}
	}, [data?.logs]);

	// Refresh the page (server badge, status) when a migration watched here ends.
	useEffect(() => {
		if (status === "running") {
			startedRunning.current = true;
			return;
		}
		if (!status || !startedRunning.current) return;
		startedRunning.current = false;
		void utils.invalidate();
		if (status === "done") toast.success("Migration completed");
		else if (status === "rolled_back") {
			toast.warning("Migration failed and was rolled back");
		} else toast.error("Migration failed");
	}, [status, utils]);

	if (!data) {
		return (
			<div className="flex justify-center py-10">
				<Loader2 className="size-6 animate-spin text-muted-foreground" />
			</div>
		);
	}
	const badge = migrationStatus[data.status];
	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-wrap items-center gap-2">
				<Badge variant={badge.variant}>{badge.label}</Badge>
				<span className="text-sm text-muted-foreground">
					{data.sourceServerName} → {data.targetServerName}
				</span>
				{data.status === "running" && (
					<Loader2 className="size-4 animate-spin text-muted-foreground" />
				)}
			</div>
			{data.status === "done" && data.pendingCleanup && (
				<KeptSourceNotice migration={data} />
			)}
			{data.errorMessage && data.status !== "running" && (
				<AlertBlock type={data.status === "rolled_back" ? "warning" : "error"}>
					{data.errorMessage}
				</AlertBlock>
			)}
			<pre
				ref={logRef}
				className="max-h-[45vh] overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all"
			>
				{data.logs || "Starting…"}
			</pre>
		</div>
	);
};

const TargetPicker = ({
	targets,
	loading,
	value,
	onChange,
}: {
	targets: Targets | undefined;
	loading: boolean;
	value: string;
	onChange: (value: string) => void;
}) => {
	const hasTargets =
		(targets?.servers.length ?? 0) > 0 || Boolean(targets?.allowDokployServer);
	const placeholder = loading
		? "Loading servers…"
		: hasTargets
			? "Select a server"
			: "No other Deploy Server available";
	return (
		<div className="flex flex-col gap-2">
			<Label>Target server</Label>
			<Select
				value={value}
				onValueChange={onChange}
				disabled={loading || !hasTargets}
			>
				<SelectTrigger>
					<SelectValue placeholder={placeholder} />
				</SelectTrigger>
				<SelectContent>
					{targets?.allowDokployServer && (
						<SelectItem value={DOKPLOY_SERVER}>Dokploy server</SelectItem>
					)}
					{targets?.servers.map((item) => (
						<SelectItem
							key={item.serverId}
							value={item.serverId}
							disabled={item.serverStatus !== "active"}
						>
							{item.name}{" "}
							<span className="text-muted-foreground">({item.ipAddress})</span>
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);
};

const OptionSwitch = ({
	id,
	label,
	description,
	checked,
	disabled,
	onChange,
}: {
	id: string;
	label: string;
	description: string;
	checked: boolean;
	disabled?: boolean;
	onChange: (checked: boolean) => void;
}) => (
	<div className="flex items-center justify-between gap-4">
		<div className="flex flex-col">
			<Label htmlFor={id}>{label}</Label>
			<span className="text-sm text-muted-foreground">{description}</span>
		</div>
		<Switch
			id={id}
			checked={checked}
			disabled={disabled}
			onCheckedChange={onChange}
		/>
	</div>
);

const OptionsPanel = ({
	options,
	supportsZeroDowntime,
	onChange,
}: {
	options: MigrationOptions;
	supportsZeroDowntime: boolean;
	onChange: (options: Partial<MigrationOptions>) => void;
}) => (
	<div className="flex flex-col gap-3 rounded-lg border p-3">
		<OptionSwitch
			id="migration-zero-downtime"
			label="Zero-downtime migration"
			description={
				supportsZeroDowntime
					? "The target starts and becomes healthy before the source stops. Volumes are then copied live."
					: "Only applications and Compose projects in zero-downtime Build Server mode can run on two servers at once: this service is stopped during the copy."
			}
			checked={options.zeroDowntime}
			disabled={!supportsZeroDowntime}
			onChange={(zeroDowntime) => onChange({ zeroDowntime })}
		/>
		{options.zeroDowntime && (
			<OptionSwitch
				id="migration-keep-source"
				label="Keep the source running until the DNS is switched"
				description="The source keeps serving visitors that still resolve its IP. Finish the migration once the DNS points to the target."
				checked={options.keepSourceRunning}
				onChange={(keepSourceRunning) => onChange({ keepSourceRunning })}
			/>
		)}
		<OptionSwitch
			id="migration-replace"
			label="Replace existing data on the target"
			description="Volumes with the same name on the target are wiped and refilled instead of blocking the migration."
			checked={options.replaceTargetData}
			onChange={(replaceTargetData) => onChange({ replaceTargetData })}
		/>
		<OptionSwitch
			id="migration-remove"
			label="Delete the data from the source afterwards"
			description="By default volumes and directories stay on the source as a backup."
			checked={options.removeSourceData}
			onChange={(removeSourceData) => onChange({ removeSourceData })}
		/>
	</div>
);

const MigrationHistory = ({
	history,
	onSelect,
}: {
	history: History;
	onSelect: (serviceMigrationId: string) => void;
}) => (
	<div className="flex flex-col gap-2">
		<span className="text-sm font-semibold">Recent migrations</span>
		<div className="flex flex-col divide-y rounded-lg border">
			{history.map((item) => (
				<div
					key={item.serviceMigrationId}
					className="flex items-center justify-between gap-3 p-3 text-sm"
				>
					<span className="min-w-0 truncate">
						{item.sourceServerName} → {item.targetServerName}
					</span>
					<span className="flex shrink-0 items-center gap-2">
						<DateTooltip date={item.createdAt} />
						{item.pendingCleanup && <Badge variant="blue">Source kept</Badge>}
						<Badge variant={migrationStatus[item.status].variant}>
							{migrationStatus[item.status].label}
						</Badge>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => onSelect(item.serviceMigrationId)}
						>
							Log
						</Button>
					</span>
				</div>
			))}
		</div>
	</div>
);

const ConfirmMigration = ({
	analysis,
	keepSourceRunning,
	open,
	onOpenChange,
	onConfirm,
}: {
	analysis: Analysis | null;
	keepSourceRunning: boolean;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onConfirm: () => void;
}) => {
	const source = analysis?.source.name;
	const target = analysis?.target.name;
	const flow = analysis?.requiresDowntime
		? `The service is stopped on ${source} while ${formatBytes(analysis.totalBytes)} are copied, then started on ${target}.`
		: keepSourceRunning
			? `The service starts on ${target} while ${source} keeps serving until you finish the migration.`
			: `The service starts on ${target} before it is removed from ${source}.`;
	return (
		<AlertDialog open={open} onOpenChange={onOpenChange}>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>Migrate to {target}?</AlertDialogTitle>
					<AlertDialogDescription>
						{flow} If anything fails before the target is healthy, the migration
						is rolled back. Remember to update the DNS records of the domains.
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<AlertDialogAction onClick={onConfirm}>
						Start migration
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
};

type OptionChoices = Omit<MigrationOptions, "zeroDowntime"> & {
	/** null until the user toggles it: overlap-safe services default to zero downtime. */
	zeroDowntime: boolean | null;
};

/** The previous target becomes the current server after a migration. */
const resolveTarget = (targets: Targets | undefined, value: string) => {
	const available =
		value === DOKPLOY_SERVER
			? Boolean(targets?.allowDokployServer)
			: Boolean(targets?.servers.some((item) => item.serverId === value));
	return available ? value : "";
};

const resolveOptions = (
	choices: OptionChoices,
	supportsZeroDowntime: boolean,
): MigrationOptions => {
	const zeroDowntime = supportsZeroDowntime && (choices.zeroDowntime ?? true);
	return {
		...choices,
		zeroDowntime,
		keepSourceRunning: zeroDowntime && choices.keepSourceRunning,
	};
};

const MigrationTrigger = () => (
	<TooltipProvider delayDuration={0}>
		<Tooltip>
			<TooltipTrigger asChild>
				<DialogTrigger asChild>
					<Button
						variant="ghost"
						size="icon"
						aria-label="Migrate to another server"
						className="group hover:bg-blue-500/10 focus-visible:ring-2 focus-visible:ring-offset-2"
					>
						<ArrowLeftRight className="size-3.5 text-primary group-hover:text-blue-500" />
					</Button>
				</DialogTrigger>
			</TooltipTrigger>
			<TooltipContent>Migrate to another server</TooltipContent>
		</Tooltip>
	</TooltipProvider>
);

const MigrationForm = ({
	serviceType,
	serviceId,
	targets,
	loadingTargets,
	history,
	onShowMigration,
}: {
	serviceType: MigratableService;
	serviceId: string;
	targets: Targets | undefined;
	loadingTargets: boolean;
	history: History | undefined;
	onShowMigration: (serviceMigrationId: string) => void;
}) => {
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [selectedTarget, setSelectedTarget] = useState("");
	const [choices, setChoices] = useState<OptionChoices>({
		removeSourceData: false,
		replaceTargetData: false,
		zeroDowntime: null,
		keepSourceRunning: false,
	});
	const [analysisState, setAnalysisState] = useState<{
		key: string;
		result: Analysis;
	} | null>(null);
	const analyze = api.serviceMigration.analyze.useMutation();
	const start = api.serviceMigration.start.useMutation();

	const supportsZeroDowntime = Boolean(targets?.supportsZeroDowntime);
	const targetServerId = resolveTarget(targets, selectedTarget);
	const options = resolveOptions(choices, supportsZeroDowntime);
	const request = {
		serviceType,
		serviceId,
		targetServerId: targetServerId === DOKPLOY_SERVER ? null : targetServerId,
		options,
	};
	const requestKey = JSON.stringify(request);
	// Checks only apply to the target and options they were run with.
	const analysis =
		analysisState?.key === requestKey ? analysisState.result : null;

	const runChecks = async () => {
		try {
			const result = await analyze.mutateAsync(request);
			setAnalysisState({ key: requestKey, result });
		} catch (error) {
			toast.error(errorMessage(error, "Unable to run the checks"));
		}
	};

	const startMigration = async () => {
		setConfirmOpen(false);
		try {
			const result = await start.mutateAsync(request);
			onShowMigration(result.serviceMigrationId);
		} catch (error) {
			toast.error(errorMessage(error, "Unable to start the migration"));
		}
	};

	return (
		<div className="flex flex-col gap-5">
			<div className="grid gap-4 md:grid-cols-[1fr_auto] md:items-end">
				<TargetPicker
					targets={targets}
					loading={loadingTargets}
					value={targetServerId}
					onChange={setSelectedTarget}
				/>
				<Button
					variant="outline"
					onClick={runChecks}
					disabled={!targetServerId}
					isLoading={analyze.isPending}
				>
					Run checks
				</Button>
			</div>
			<OptionsPanel
				options={options}
				supportsZeroDowntime={supportsZeroDowntime}
				onChange={(changes) =>
					setChoices((current) => ({ ...current, ...changes }))
				}
			/>
			{analysis && <AnalysisResult analysis={analysis} />}
			<div className="flex items-center justify-end gap-2">
				<Button
					onClick={() => setConfirmOpen(true)}
					disabled={!analysis?.canMigrate || start.isPending}
					isLoading={start.isPending}
				>
					Migrate
				</Button>
			</div>
			{history && history.length > 0 && (
				<MigrationHistory history={history} onSelect={onShowMigration} />
			)}
			<ConfirmMigration
				analysis={analysis}
				keepSourceRunning={options.keepSourceRunning}
				open={confirmOpen}
				onOpenChange={setConfirmOpen}
				onConfirm={startMigration}
			/>
		</div>
	);
};

interface Props {
	serviceType: MigratableService;
	serviceId: string;
	serviceName?: string;
	currentServerName?: string;
}

export const MigrateServiceServer = ({
	serviceType,
	serviceId,
	serviceName,
	currentServerName,
}: Props) => {
	const [open, setOpen] = useState(false);
	const [selectedMigrationId, setSelectedMigrationId] = useState<string | null>(
		null,
	);
	const { data: targets, isLoading: loadingTargets } =
		api.serviceMigration.targets.useQuery(
			{ serviceType, serviceId },
			{ enabled: open },
		);
	const { data: history } = api.serviceMigration.history.useQuery(
		{ serviceType, serviceId },
		{ enabled: open },
	);
	// A running migration is always shown, whoever started it.
	const runningMigrationId = history?.find(
		(migration) => migration.status === "running",
	)?.serviceMigrationId;
	const shownMigrationId = selectedMigrationId ?? runningMigrationId;

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<MigrationTrigger />
			<DialogContent className="sm:max-w-4xl max-h-[90vh] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>Migrate to another server</DialogTitle>
					<DialogDescription>
						Move {serviceName ? <strong>{serviceName}</strong> : "this service"}{" "}
						from {currentServerName || "its current server"} to another server.
						Checks only read both servers; nothing changes until you start the
						migration.
					</DialogDescription>
				</DialogHeader>
				{shownMigrationId ? (
					<div className="flex flex-col gap-4">
						<MigrationProgress
							key={shownMigrationId}
							serviceMigrationId={shownMigrationId}
						/>
						{shownMigrationId !== runningMigrationId && (
							<div className="flex justify-end">
								<Button
									variant="outline"
									onClick={() => setSelectedMigrationId(null)}
								>
									Back
								</Button>
							</div>
						)}
					</div>
				) : (
					<MigrationForm
						serviceType={serviceType}
						serviceId={serviceId}
						targets={targets}
						loadingTargets={loadingTargets}
						history={history}
						onShowMigration={setSelectedMigrationId}
					/>
				)}
			</DialogContent>
		</Dialog>
	);
};
