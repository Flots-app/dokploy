import {
	ArrowLeftRight,
	CheckCircle2,
	CircleMinus,
	Loader2,
	TriangleAlert,
	XCircle,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AlertBlock } from "@/components/shared/alert-block";
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
import { cn } from "@/lib/utils";
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
						{items.map((item, index) => (
							<div
								key={`${item.label}-${index}`}
								className="flex items-start justify-between gap-3 p-3"
							>
								<div className="flex min-w-0 flex-col gap-0.5">
									<div className="flex flex-wrap items-center gap-2">
										<Badge variant={actions[item.action].variant}>
											{actions[item.action].label}
										</Badge>
										<span className="text-sm font-medium break-all">
											{item.label}
										</span>
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
						))}
					</div>
				</div>
			);
		})}
	</div>
);

const MigrationProgress = ({
	serviceMigrationId,
	onFinished,
}: {
	serviceMigrationId: string;
	onFinished: (migration: Migration) => void;
}) => {
	const { data } = api.serviceMigration.one.useQuery(
		{ serviceMigrationId },
		{
			refetchInterval: (query) =>
				query.state.data?.status === "running" ? 1500 : false,
		},
	);
	const utils = api.useUtils();
	const finalize = api.serviceMigration.finalize.useMutation();
	const logRef = useRef<HTMLPreElement>(null);
	const notified = useRef(false);

	const finishMigration = async () => {
		try {
			await finalize.mutateAsync({ serviceMigrationId });
			toast.success(
				"Migration finished, the source no longer runs the service",
			);
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "Unable to finish the migration",
			);
		} finally {
			await utils.serviceMigration.invalidate();
		}
	};

	useEffect(() => {
		if (logRef.current) {
			logRef.current.scrollTop = logRef.current.scrollHeight;
		}
	}, [data?.logs]);

	useEffect(() => {
		if (data && data.status !== "running" && !notified.current) {
			notified.current = true;
			onFinished(data);
		}
	}, [data, onFinished]);

	if (!data) {
		return (
			<div className="flex justify-center py-10">
				<Loader2 className="size-6 animate-spin text-muted-foreground" />
			</div>
		);
	}
	const status = migrationStatus[data.status];
	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-wrap items-center gap-2">
				<Badge variant={status.variant}>{status.label}</Badge>
				<span className="text-sm text-muted-foreground">
					{data.sourceServerName} → {data.targetServerName}
				</span>
				{data.status === "running" && (
					<Loader2 className="size-4 animate-spin text-muted-foreground" />
				)}
			</div>
			{data.status === "done" && data.pendingCleanup && (
				<AlertBlock type="info">
					<div className="flex flex-col gap-2">
						<span>
							{data.sourceServerName} still runs the previous copy so visitors
							resolving the old IP keep being served. Point the DNS records of
							the domains to {data.targetServerName}, wait for the propagation,
							then finish the migration to remove it from{" "}
							{data.sourceServerName}.
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
	const utils = api.useUtils();
	const [open, setOpen] = useState(false);
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [targetServerId, setTargetServerId] = useState<string>("");
	const [removeSourceData, setRemoveSourceData] = useState(false);
	const [replaceTargetData, setReplaceTargetData] = useState(false);
	const [zeroDowntime, setZeroDowntime] = useState(false);
	const [keepSourceRunning, setKeepSourceRunning] = useState(false);
	const [analysis, setAnalysis] = useState<Analysis | null>(null);
	const [activeMigrationId, setActiveMigrationId] = useState<string | null>(
		null,
	);

	const { data: targets, isLoading: loadingTargets } =
		api.serviceMigration.targets.useQuery(
			{ serviceType, serviceId },
			{ enabled: open },
		);
	const { data: history, refetch: refetchHistory } =
		api.serviceMigration.history.useQuery(
			{ serviceType, serviceId },
			{ enabled: open },
		);
	const analyze = api.serviceMigration.analyze.useMutation();
	const start = api.serviceMigration.start.useMutation();

	// After a migration the previous target becomes the current server.
	useEffect(() => {
		if (!targets || !targetServerId) return;
		const available =
			targetServerId === DOKPLOY_SERVER
				? targets.allowDokployServer
				: targets.servers.some((item) => item.serverId === targetServerId);
		if (!available) setTargetServerId("");
	}, [targets, targetServerId]);

	// Overlap-safe services migrate without downtime unless the user opts out.
	useEffect(() => {
		setZeroDowntime(Boolean(targets?.supportsZeroDowntime));
	}, [targets?.supportsZeroDowntime]);

	const running = history?.find((migration) => migration.status === "running");
	useEffect(() => {
		if (running && !activeMigrationId) {
			setActiveMigrationId(running.serviceMigrationId);
		}
	}, [running, activeMigrationId]);

	// Any change of target or options invalidates the previous checks.
	useEffect(() => {
		setAnalysis(null);
	}, [
		targetServerId,
		removeSourceData,
		replaceTargetData,
		zeroDowntime,
		keepSourceRunning,
	]);

	const request = useMemo(
		() => ({
			serviceType,
			serviceId,
			targetServerId: targetServerId === DOKPLOY_SERVER ? null : targetServerId,
			options: {
				removeSourceData,
				replaceTargetData,
				zeroDowntime,
				keepSourceRunning: zeroDowntime && keepSourceRunning,
			},
		}),
		[
			serviceType,
			serviceId,
			targetServerId,
			removeSourceData,
			replaceTargetData,
			zeroDowntime,
			keepSourceRunning,
		],
	);

	const counts = useMemo(() => {
		const checks = analysis?.checks ?? [];
		return {
			pass: checks.filter((check) => check.status === "pass").length,
			warn: checks.filter((check) => check.status === "warn").length,
			fail: checks.filter((check) => check.status === "fail").length,
		};
	}, [analysis]);

	const runChecks = async () => {
		try {
			setAnalysis(await analyze.mutateAsync(request));
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Unable to run the checks",
			);
		}
	};

	const startMigration = async () => {
		setConfirmOpen(false);
		try {
			const result = await start.mutateAsync(request);
			setActiveMigrationId(result.serviceMigrationId);
			await refetchHistory();
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "Unable to start the migration",
			);
		}
	};

	const onFinished = async (migration: Migration) => {
		await refetchHistory();
		await utils.invalidate();
		if (migration.status === "done") {
			toast.success(`Migrated to ${migration.targetServerName}`);
		} else if (migration.status === "rolled_back") {
			toast.warning("Migration failed and was rolled back");
		} else {
			toast.error("Migration failed");
		}
	};

	const reset = () => {
		setActiveMigrationId(null);
		setAnalysis(null);
	};

	const activeIsRunning =
		activeMigrationId !== null &&
		history?.find((item) => item.serviceMigrationId === activeMigrationId)
			?.status === "running";
	const hasTargets =
		(targets?.servers.length ?? 0) > 0 || targets?.allowDokployServer;

	return (
		<Dialog open={open} onOpenChange={setOpen}>
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

				{activeMigrationId ? (
					<div className="flex flex-col gap-4">
						<MigrationProgress
							key={activeMigrationId}
							serviceMigrationId={activeMigrationId}
							onFinished={onFinished}
						/>
						{!activeIsRunning && (
							<div className="flex justify-end">
								<Button variant="outline" onClick={reset}>
									Back
								</Button>
							</div>
						)}
					</div>
				) : (
					<div className="flex flex-col gap-5">
						<div className="grid gap-4 md:grid-cols-[1fr_auto] md:items-end">
							<div className="flex flex-col gap-2">
								<Label>Target server</Label>
								<Select
									value={targetServerId}
									onValueChange={setTargetServerId}
									disabled={loadingTargets || !hasTargets}
								>
									<SelectTrigger>
										<SelectValue
											placeholder={
												loadingTargets
													? "Loading servers…"
													: hasTargets
														? "Select a server"
														: "No other Deploy Server available"
											}
										/>
									</SelectTrigger>
									<SelectContent>
										{targets?.allowDokployServer && (
											<SelectItem value={DOKPLOY_SERVER}>
												Dokploy server
											</SelectItem>
										)}
										{targets?.servers.map((item) => (
											<SelectItem
												key={item.serverId}
												value={item.serverId}
												disabled={item.serverStatus !== "active"}
											>
												{item.name}{" "}
												<span className="text-muted-foreground">
													({item.ipAddress})
												</span>
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
							<Button
								variant="outline"
								onClick={runChecks}
								disabled={!targetServerId}
								isLoading={analyze.isPending}
							>
								Run checks
							</Button>
						</div>

						<div className="flex flex-col gap-3 rounded-lg border p-3">
							<div className="flex items-center justify-between gap-4">
								<div className="flex flex-col">
									<Label htmlFor="migration-zero-downtime">
										Zero-downtime migration
									</Label>
									<span className="text-sm text-muted-foreground">
										{targets?.supportsZeroDowntime
											? "The target starts and becomes healthy before the source stops. Volumes are then copied live."
											: "Only applications and Compose projects in zero-downtime Build Server mode can run on two servers at once: this service is stopped during the copy."}
									</span>
								</div>
								<Switch
									id="migration-zero-downtime"
									checked={zeroDowntime}
									disabled={!targets?.supportsZeroDowntime}
									onCheckedChange={setZeroDowntime}
								/>
							</div>
							{zeroDowntime && (
								<div className="flex items-center justify-between gap-4">
									<div className="flex flex-col">
										<Label htmlFor="migration-keep-source">
											Keep the source running until the DNS is switched
										</Label>
										<span className="text-sm text-muted-foreground">
											The source keeps serving visitors that still resolve its
											IP. Finish the migration once the DNS points to the
											target.
										</span>
									</div>
									<Switch
										id="migration-keep-source"
										checked={keepSourceRunning}
										onCheckedChange={setKeepSourceRunning}
									/>
								</div>
							)}
							<div className="flex items-center justify-between gap-4">
								<div className="flex flex-col">
									<Label htmlFor="migration-replace">
										Replace existing data on the target
									</Label>
									<span className="text-sm text-muted-foreground">
										Volumes with the same name on the target are wiped and
										refilled instead of blocking the migration.
									</span>
								</div>
								<Switch
									id="migration-replace"
									checked={replaceTargetData}
									onCheckedChange={setReplaceTargetData}
								/>
							</div>
							<div className="flex items-center justify-between gap-4">
								<div className="flex flex-col">
									<Label htmlFor="migration-remove">
										Delete the data from the source afterwards
									</Label>
									<span className="text-sm text-muted-foreground">
										By default volumes and directories stay on the source as a
										backup.
									</span>
								</div>
								<Switch
									id="migration-remove"
									checked={removeSourceData}
									onCheckedChange={setRemoveSourceData}
								/>
							</div>
						</div>

						{analysis && (
							<div className="flex flex-col gap-5">
								<div className="flex flex-wrap items-center gap-2 text-sm">
									<Badge variant="green">{counts.pass} passed</Badge>
									{counts.warn > 0 && (
										<Badge variant="yellow">{counts.warn} warning(s)</Badge>
									)}
									{counts.fail > 0 && (
										<Badge variant="red">{counts.fail} failed</Badge>
									)}
									<span className="text-muted-foreground">
										{analysis.source.name} → {analysis.target.name} ·{" "}
										{formatBytes(analysis.totalBytes)} to copy ·{" "}
										{analysis.requiresDowntime
											? "downtime during the copy"
											: "no downtime expected"}
									</span>
								</div>
								<div className="flex flex-col gap-2">
									<span className="text-sm font-semibold">
										Pre-flight checks
									</span>
									<ChecksList checks={analysis.checks} />
								</div>
								{analysis.plan.length > 0 && (
									<div className="flex flex-col gap-2">
										<span className="text-sm font-semibold">
											What will be migrated
										</span>
										<MigrationPlan plan={analysis.plan} />
									</div>
								)}
								{!analysis.canMigrate && (
									<AlertBlock type="error">
										Fix the failed checks, then run them again to enable the
										migration.
									</AlertBlock>
								)}
							</div>
						)}

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
							<div className="flex flex-col gap-2">
								<span className="text-sm font-semibold">Recent migrations</span>
								<div className="flex flex-col divide-y rounded-lg border">
									{history.map((item) => (
										<button
											type="button"
											key={item.serviceMigrationId}
											onClick={() =>
												setActiveMigrationId(item.serviceMigrationId)
											}
											className={cn(
												"flex items-center justify-between gap-3 p-3 text-left text-sm hover:bg-muted/50",
											)}
										>
											<span className="min-w-0 truncate">
												{item.sourceServerName} → {item.targetServerName}
											</span>
											<span className="flex shrink-0 items-center gap-2">
												<span className="text-muted-foreground">
													{new Date(item.createdAt).toLocaleString()}
												</span>
												{item.pendingCleanup && (
													<Badge variant="blue">Source kept</Badge>
												)}
												<Badge variant={migrationStatus[item.status].variant}>
													{migrationStatus[item.status].label}
												</Badge>
											</span>
										</button>
									))}
								</div>
							</div>
						)}
					</div>
				)}

				<AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>
								Migrate to {analysis?.target.name}?
							</AlertDialogTitle>
							<AlertDialogDescription>
								{analysis?.requiresDowntime
									? `The service is stopped on ${analysis.source.name} while ${formatBytes(analysis.totalBytes)} are copied, then started on ${analysis.target.name}.`
									: keepSourceRunning
										? `The service starts on ${analysis?.target.name} while ${analysis?.source.name} keeps serving until you finish the migration.`
										: `The service starts on ${analysis?.target.name} before it is removed from ${analysis?.source.name}.`}{" "}
								If anything fails before the target is healthy, the migration is
								rolled back. Remember to update the DNS records of the domains.
							</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel>Cancel</AlertDialogCancel>
							<AlertDialogAction onClick={startMigration}>
								Start migration
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			</DialogContent>
		</Dialog>
	);
};
