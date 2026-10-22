import { formatDistanceToNow } from "date-fns";
import {
	Activity,
	Apple,
	Download,
	KeyRound,
	KeySquare,
	ListChecks,
	Loader2,
	MoreHorizontal,
	Pencil,
	Play,
	Power,
	PowerOff,
	RotateCw,
	Server,
	Trash2,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { AlertBlock } from "@/components/shared/alert-block";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { api } from "@/utils/api";
import { EditMachineDialog } from "./edit-machine";
import {
	elapsed,
	errorText,
	formatBytes,
	formatCpus,
	formatDuration,
	percentText,
	type RunnerMachine,
	type RunnerSlot,
	runUrl,
} from "./format";
import { HostKeyDialog } from "./host-key-dialog";
import { DisableMachineDialog, RemoveMachineDialog } from "./machine-actions";
import { ContinueEnrollmentDialog } from "./machine-enrollment";
import { MachineMonitoringDialog } from "./machine-monitoring";
import { MachineOperationsDialog } from "./machine-operations";
import { PhaseBadge, UsageBar } from "./shared";
import { useNow } from "./use-now";

type DialogName =
	| "disable"
	| "edit"
	| "monitoring"
	| "operations"
	| "remove"
	| "hostkey"
	| "enroll";

const GiB = 1024 ** 3;

const SLOT_STYLE: Record<string, string> = {
	busy: "border-blue-500/40 bg-blue-500/10",
	idle: "border-emerald-500/40 bg-emerald-500/10",
	starting: "border-yellow-500/40 bg-yellow-500/10",
	stopping: "border-orange-500/40 bg-orange-500/10",
	exited: "border-muted bg-muted/40",
	free: "border-dashed border-muted-foreground/30",
};

const SlotTile = ({
	number,
	slot,
	now,
}: {
	number: number;
	slot?: RunnerSlot;
	now: number;
}) => {
	const state = slot?.state ?? "free";
	const content = (
		<div
			className={`flex h-14 min-w-0 flex-col justify-center rounded-md border px-2 text-xs ${SLOT_STYLE[state]}`}
		>
			<span className="flex items-center justify-between gap-1">
				<span className="font-medium">#{number}</span>
				<span className="text-muted-foreground">
					{state === "free" ? "empty" : state}
				</span>
			</span>
			<span className="truncate text-muted-foreground">
				{slot?.job && state === "busy"
					? `${slot.job.job} · ${formatDuration(elapsed(slot.job.startedAt, now))}`
					: (slot?.runnerName ?? " ")}
			</span>
		</div>
	);
	if (!slot?.job) return content;
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<a href={runUrl(slot.job)} target="_blank" rel="noreferrer">
					{content}
				</a>
			</TooltipTrigger>
			<TooltipContent>
				{slot.job.repository} · {slot.job.workflow} · {slot.job.job} (run{" "}
				{slot.job.runId}
				{slot.job.runAttempt && slot.job.runAttempt !== "1"
					? `, attempt ${slot.job.runAttempt}`
					: ""}
				)
			</TooltipContent>
		</Tooltip>
	);
};

const SlotGrid = ({ machine }: { machine: RunnerMachine }) => {
	const now = useNow();
	const slots = machine.observed?.slots ?? [];
	const bySlot = new Map(slots.map((slot) => [slot.slot, slot]));
	const count = Math.max(
		machine.resolvedMaxRunners,
		...slots.map((slot) => slot.slot),
	);
	return (
		<TooltipProvider delayDuration={200}>
			<div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
				{Array.from({ length: count }, (_, index) => (
					<SlotTile
						key={index + 1}
						number={index + 1}
						slot={bySlot.get(index + 1)}
						now={now}
					/>
				))}
			</div>
		</TooltipProvider>
	);
};

const diskLevel = (machine: RunnerMachine) => {
	const host = machine.observed?.host;
	if (!host) return "ok" as const;
	if (host.diskFreeBytes < machine.diskReserveGb * GiB)
		return "danger" as const;
	return host.diskFreeBytes < machine.diskCleanupGb * GiB
		? ("warn" as const)
		: ("ok" as const);
};

/** Measured speed of the budget: per core relative to the slowest machine of the pool. */
const SpeedLine = ({
	machine,
	speedRef,
	isNext,
}: {
	machine: RunnerMachine;
	speedRef: number | null;
	isNext: boolean;
}) => {
	const benchmark = machine.benchmark;
	if (!benchmark) {
		return (
			<p className="text-xs text-muted-foreground">
				Speed measured once the machine is idle
			</p>
		);
	}
	const ratio = speedRef ? benchmark.single / speedRef : 1;
	return (
		<p className="text-xs text-muted-foreground">
			Speed{" "}
			<span className="font-medium text-foreground">
				×{ratio.toFixed(2)} per core · about{" "}
				{(benchmark.multi / benchmark.single).toFixed(1)} cores for jobs
			</span>
			{isNext && (
				<span className="text-emerald-600 dark:text-emerald-500">
					{" "}
					· next job lands here
				</span>
			)}
		</p>
	);
};

const MachineUsage = ({
	machine,
	speedRef,
	isNext,
}: {
	machine: RunnerMachine;
	speedRef: number | null;
	isNext: boolean;
}) => {
	const usage = machine.observed?.usage;
	const host = machine.observed?.host;
	const memoryLimit = usage?.memoryLimitBytes ?? machine.budget?.memoryBytes;
	return (
		<div className="grid gap-2">
			<p className="text-xs text-muted-foreground">
				Budget{" "}
				<span className="font-medium text-foreground">
					{machine.budget
						? `${formatCpus(machine.budget.cpus)} · ${formatBytes(machine.budget.memoryBytes)}`
						: "—"}
				</span>{" "}
				({machine.cpuPercent}% CPU, {machine.memoryPercent}% memory
				{machine.platform === "macos" ? ", VM" : ""})
			</p>
			<SpeedLine machine={machine} speedRef={speedRef} isNext={isNext} />
			<UsageBar
				label="CPU"
				tone="neutral"
				value={percentText(usage?.cpuPercent)}
				ratio={
					typeof usage?.cpuPercent === "number" ? usage.cpuPercent / 100 : null
				}
			/>
			<UsageBar
				label="Memory"
				value={`${formatBytes(usage?.memoryBytes)} / ${formatBytes(memoryLimit)}`}
				ratio={
					usage?.memoryBytes && memoryLimit
						? usage.memoryBytes / memoryLimit
						: null
				}
			/>
			<UsageBar
				label="Disk free"
				value={
					host
						? `${formatBytes(host.diskFreeBytes)} · cleans < ${machine.diskCleanupGb} GiB`
						: "—"
				}
				ratio={
					host?.diskTotalBytes
						? 1 - host.diskFreeBytes / host.diskTotalBytes
						: null
				}
				level={diskLevel(machine)}
			/>
		</div>
	);
};

const drainMessage = (machine: RunnerMachine, busy: number) => {
	const drain = machine.drain;
	if (!drain) return null;
	const action =
		drain.reason === "apply"
			? "Applying a new VM size"
			: drain.reason === "remove"
				? "Removing"
				: "Disabling";
	if (drain.mode === "kill") return `${action}: interrupting the running jobs.`;
	if (!busy) return `${action}: finishing.`;
	const deadline = drain.deadline
		? ` (interrupted ${formatDistanceToNow(new Date(drain.deadline), { addSuffix: true })})`
		: "";
	return `${action}: no new job, waiting for ${busy} running job${busy > 1 ? "s" : ""}${deadline}.`;
};

/** Machines left behind are flagged; the latest release shows no badge. */
const RUNNER_BADGE = {
	pending: { variant: "blue", label: "update pending" },
	outdated: { variant: "orange", label: "outdated" },
	unsupported: { variant: "red", label: "no longer supported" },
} as const;

const RunnerVersion = ({ machine }: { machine: RunnerMachine }) => {
	const status = machine.runnerUpdate;
	if (!status.installed) return null;
	const badge =
		status.state === "current" || status.state === "unknown"
			? null
			: RUNNER_BADGE[status.state];
	return (
		<span className="flex items-center gap-1.5">
			runner {status.installed}
			{badge && (
				<Badge variant={badge.variant} title={status.message}>
					{badge.label}
				</Badge>
			)}
		</span>
	);
};

const OS_BADGE = {
	updates: { variant: "blue", label: "updates" },
	outdated: { variant: "orange", label: "updates needed" },
	unsupported: { variant: "red", label: "unsupported" },
} as const;

type OsStatusView = RunnerMachine["os"]["host"];

const OsName = ({
	prefix,
	status,
}: {
	prefix: string;
	status: OsStatusView;
}) => {
	if (!status.label) return null;
	const badge =
		status.state === "current" || status.state === "unknown"
			? null
			: OS_BADGE[status.state];
	return (
		<span className="flex items-center gap-1.5">
			{prefix}
			{status.label}
			{badge && (
				<Badge variant={badge.variant} title={status.message}>
					{badge.label}
				</Badge>
			)}
		</span>
	);
};

/** The OS of the machine, and of its VM on a Mac, with when it was read. */
const OsLine = ({
	machine,
	canUpdate,
}: {
	machine: RunnerMachine;
	canUpdate: boolean;
}) => {
	const check = api.githubRunner.checkMachineOs.useMutation();
	const { host, guest, checkedAt } = machine.os;
	if (!host.label && !checkedAt) return null;
	return (
		<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
			<OsName prefix="" status={host} />
			{guest && <OsName prefix="VM " status={guest} />}
			{checkedAt && (
				<span>
					checked{" "}
					{formatDistanceToNow(new Date(checkedAt), { addSuffix: true })}
				</span>
			)}
			{canUpdate && (
				<Button
					variant="link"
					className="h-auto p-0 text-xs"
					disabled={check.isPending || check.isSuccess}
					onClick={() =>
						check
							.mutateAsync({ githubRunnerNodeId: machine.githubRunnerNodeId })
							.then(() => toast.success(`${machine.name}: OS check started`))
							.catch((error) => toast.error(errorText(error)))
					}
				>
					{check.isSuccess ? "Checking…" : "Check now"}
				</Button>
			)}
		</div>
	);
};

const MachineAlerts = ({
	machine,
	busy,
	canUpdate,
	onReviewHostKey,
}: {
	machine: RunnerMachine;
	busy: number;
	canUpdate: boolean;
	onReviewHostKey: () => void;
}) => {
	const drain = drainMessage(machine, busy);
	const admission = machine.observed?.admission;
	const runner = machine.runnerUpdate;
	const os = [machine.os.host, machine.os.guest].flatMap((status, index) =>
		status && (status.state === "outdated" || status.state === "unsupported")
			? [{ key: index === 0 ? "host" : "vm", vm: index === 1, status }]
			: [],
	);
	return (
		<>
			{drain && <AlertBlock type="warning">{drain}</AlertBlock>}
			{os.map(({ key, vm, status }) => (
				<AlertBlock
					key={key}
					type={status.state === "unsupported" ? "error" : "warning"}
				>
					{vm ? `VM: ${status.message}` : status.message}
				</AlertBlock>
			))}
			{(runner.state === "outdated" || runner.state === "unsupported") && (
				<AlertBlock type={runner.state === "unsupported" ? "error" : "warning"}>
					{runner.message}
				</AlertBlock>
			)}
			{machine.lastError && !drain && (
				<AlertBlock type={machine.phase === "error" ? "error" : "warning"}>
					{machine.lastError}
					{machine.lastError.includes("host key") && canUpdate && (
						<Button
							variant="link"
							className="h-auto px-1"
							onClick={onReviewHostKey}
						>
							Review the host key
						</Button>
					)}
				</AlertBlock>
			)}
			{admission && !admission.ok && (
				<AlertBlock type="warning">
					New jobs paused: {admission.reason}
				</AlertBlock>
			)}
		</>
	);
};

/** "Update now", shown while the runner or the runtime has an update. */
const UpdateNowItem = ({ machine }: { machine: RunnerMachine }) => {
	const utils = api.useUtils();
	const updateNow = api.githubRunner.updateMachineNow.useMutation();
	const ready = machine.phase === "ready" || machine.phase === "draining";
	const behind =
		machine.runtimeUpdatePending ||
		["pending", "outdated", "unsupported"].includes(machine.runnerUpdate.state);
	if (!ready || !behind) return null;
	const onSelect = async () => {
		try {
			await updateNow.mutateAsync({
				githubRunnerNodeId: machine.githubRunnerNodeId,
			});
			await utils.githubRunner.overview.invalidate();
			toast.success(`${machine.name}: update started, between jobs`);
		} catch (error) {
			toast.error(errorText(error, "Unable to start the update"));
		}
	};
	return (
		<DropdownMenuItem
			disabled={updateNow.isPending || Boolean(machine.updates.requestedAt)}
			onSelect={() => void onSelect()}
		>
			<Download className="size-4" /> Update now
		</DropdownMenuItem>
	);
};

const MachineActions = ({
	machine,
	canCreate,
	canUpdate,
	canDelete,
	onOpen,
}: {
	machine: RunnerMachine;
	canCreate: boolean;
	canUpdate: boolean;
	canDelete: boolean;
	onOpen: (dialog: DialogName) => void;
}) => {
	const utils = api.useUtils();
	const enable = api.githubRunner.enableMachine.useMutation();
	const provision = api.githubRunner.provisionMachine.useMutation();
	const rotate = api.githubRunner.rotateKey.useMutation();

	const working =
		machine.phase === "provisioning" || Boolean(machine.operation);
	const enrolling = machine.phase === "enrolling";

	const run = async (action: () => Promise<unknown>, success: string) => {
		try {
			await action();
			await utils.githubRunner.overview.invalidate();
			toast.success(success);
		} catch (error) {
			toast.error(errorText(error, "Action failed"));
		}
	};
	const id = { githubRunnerNodeId: machine.githubRunnerNodeId };

	return (
		<div className="flex shrink-0 items-center gap-1">
			{canCreate && enrolling && (
				<Button size="sm" onClick={() => onOpen("enroll")}>
					<Play className="size-4" />
					Continue setup
				</Button>
			)}
			{canUpdate &&
				!enrolling &&
				(machine.enabled ? (
					<Button
						size="sm"
						variant="outline"
						onClick={() => onOpen("disable")}
						disabled={machine.phase === "provisioning"}
					>
						<PowerOff className="size-4" />
						Disable
					</Button>
				) : (
					<Button
						size="sm"
						onClick={() =>
							run(() => enable.mutateAsync(id), `${machine.name} enabled`)
						}
						disabled={enable.isPending}
					>
						{enable.isPending ? (
							<Loader2 className="size-4 animate-spin" />
						) : (
							<Power className="size-4" />
						)}
						Enable
					</Button>
				))}
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button size="icon" variant="ghost" aria-label="Machine actions">
						<MoreHorizontal className="size-4" />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					{!enrolling && (
						<DropdownMenuItem onSelect={() => onOpen("monitoring")}>
							<Activity className="size-4" /> Monitoring
						</DropdownMenuItem>
					)}
					<DropdownMenuItem onSelect={() => onOpen("operations")}>
						<ListChecks className="size-4" /> Operations
					</DropdownMenuItem>
					{canUpdate && !enrolling && (
						<>
							<DropdownMenuItem onSelect={() => onOpen("edit")}>
								<Pencil className="size-4" /> Resources
							</DropdownMenuItem>
							<DropdownMenuItem
								disabled={provision.isPending || working}
								onSelect={() =>
									run(() => provision.mutateAsync(id), "Provisioning started")
								}
							>
								<RotateCw className="size-4" /> Reinstall runtime
							</DropdownMenuItem>
							<UpdateNowItem machine={machine} />
							<DropdownMenuItem onSelect={() => onOpen("hostkey")}>
								<KeyRound className="size-4" /> SSH host key
							</DropdownMenuItem>
							{machine.hasOwnKey && (
								<DropdownMenuItem
									disabled={rotate.isPending || working}
									onSelect={() =>
										run(
											() => rotate.mutateAsync(id),
											`New SSH key installed on ${machine.name}, the old one removed`,
										)
									}
								>
									<KeySquare className="size-4" /> Rotate SSH key
								</DropdownMenuItem>
							)}
						</>
					)}
					{canDelete && (
						<>
							<DropdownMenuSeparator />
							<DropdownMenuItem
								className="text-destructive"
								onSelect={() => onOpen("remove")}
							>
								<Trash2 className="size-4" /> Remove
							</DropdownMenuItem>
						</>
					)}
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
};

const MachineTitle = ({ machine }: { machine: RunnerMachine }) => {
	const host = machine.observed?.host;
	const working =
		machine.phase === "provisioning" || Boolean(machine.operation);
	return (
		<div className="min-w-0 space-y-1">
			<div className="flex flex-wrap items-center gap-2">
				{machine.platform === "macos" ? (
					<Apple className="size-4 text-muted-foreground" />
				) : (
					<Server className="size-4 text-muted-foreground" />
				)}
				<span className="text-base font-semibold">{machine.name}</span>
				<PhaseBadge machine={machine} />
				{working && (
					<Loader2 className="size-3.5 animate-spin text-muted-foreground" />
				)}
			</div>
			<p className="truncate text-xs text-muted-foreground">
				{machine.host
					? `${machine.username}@${machine.host}`
					: "Waiting for its setup script to run"}
				{machine.platform === "macos" ? ` · VM ${machine.vmName}` : ""}
				{host
					? ` · ${host.os} · ${formatCpus(host.cpus)} · ${formatBytes(host.memoryBytes)}`
					: ""}
			</p>
			{machine.description && (
				<p className="text-xs text-muted-foreground">{machine.description}</p>
			)}
		</div>
	);
};

/** How the machine gets updates, when it is not "automatic, any time". */
const UpdateSetting = ({ machine }: { machine: RunnerMachine }) => {
	const { updates } = machine;
	const text = updates.requestedAt
		? "update requested"
		: !updates.auto
			? "auto-updates off"
			: updates.window
				? `updates ${updates.description}${updates.open ? " (open now)" : ""}`
				: null;
	return text ? <span>{text}</span> : null;
};

const MachineFooter = ({
	machine,
	busy,
}: {
	machine: RunnerMachine;
	busy: number;
}) => (
	<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
		<span>
			{busy}/{machine.resolvedMaxRunners} busy
			{machine.maxRunners === 0 ? " (auto)" : ""}
		</span>
		<RunnerVersion machine={machine} />
		{machine.runtimeUpdatePending && <span>runtime update pending</span>}
		<UpdateSetting machine={machine} />
		{machine.extraLabels.map((label) => (
			<Badge key={label} variant="outline">
				{label}
			</Badge>
		))}
		{machine.lastSeenAt && (
			<span>
				seen{" "}
				{formatDistanceToNow(new Date(machine.lastSeenAt), { addSuffix: true })}
			</span>
		)}
	</div>
);

export const MachineCard = ({
	machine,
	canCreate,
	canUpdate,
	canDelete,
	rerunInterruptedJobs,
	speedRef,
	isNext,
}: {
	machine: RunnerMachine;
	/** Finishing the setup of a machine is part of adding it. */
	canCreate: boolean;
	canUpdate: boolean;
	canDelete: boolean;
	rerunInterruptedJobs: boolean;
	/** Per-core score of the slowest measured machine of the pool. */
	speedRef: number | null;
	isNext: boolean;
}) => {
	const [dialog, setDialog] = useState<DialogName | null>(null);
	const busy = (machine.observed?.slots ?? []).filter(
		(slot) => slot.state === "busy",
	).length;
	const enrolling = machine.phase === "enrolling";
	const installed =
		!enrolling && machine.phase !== "new" && machine.phase !== "provisioning";
	const dialogProps = (name: DialogName) => ({
		machine,
		open: dialog === name,
		onOpenChange: (open: boolean) => setDialog(open ? name : null),
	});

	return (
		<div className="flex flex-col gap-4 rounded-xl border bg-background p-4">
			<div className="flex items-start justify-between gap-3">
				<MachineTitle machine={machine} />
				<MachineActions
					machine={machine}
					canCreate={canCreate}
					canUpdate={canUpdate}
					canDelete={canDelete}
					onOpen={setDialog}
				/>
			</div>
			<OsLine machine={machine} canUpdate={canUpdate} />
			<MachineAlerts
				machine={machine}
				busy={busy}
				canUpdate={canUpdate}
				onReviewHostKey={() => setDialog("hostkey")}
			/>
			{installed && (
				<MachineUsage machine={machine} speedRef={speedRef} isNext={isNext} />
			)}
			{installed && <SlotGrid machine={machine} />}
			{!enrolling && <MachineFooter machine={machine} busy={busy} />}

			<DisableMachineDialog
				{...dialogProps("disable")}
				rerun={rerunInterruptedJobs}
			/>
			<RemoveMachineDialog
				{...dialogProps("remove")}
				rerun={rerunInterruptedJobs}
			/>
			<EditMachineDialog {...dialogProps("edit")} />
			<MachineMonitoringDialog {...dialogProps("monitoring")} />
			<MachineOperationsDialog {...dialogProps("operations")} />
			<HostKeyDialog {...dialogProps("hostkey")} />
			<ContinueEnrollmentDialog {...dialogProps("enroll")} />
		</div>
	);
};
