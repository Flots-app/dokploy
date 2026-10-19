import { format } from "date-fns";
import { Eraser, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { DialogAction } from "@/components/shared/dialog-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { api } from "@/utils/api";
import { formatBytes, formatDuration, type RunnerMachine } from "./format";
import { UsageBar } from "./shared";

type Thresholds = NonNullable<RunnerMachine["diskThresholds"]["host"]>;
type Cleanup = RunnerMachine["cleanups"][number];

const level = (free: number, thresholds: Thresholds) =>
	free < thresholds.reserveBytes
		? ("danger" as const)
		: free < thresholds.cleanupBytes
			? ("warn" as const)
			: ("ok" as const);

const DiskLine = ({
	label,
	free,
	total,
	thresholds,
	note,
}: {
	label: string;
	free: number | null | undefined;
	total: number | null | undefined;
	thresholds: Thresholds | null;
	note: string;
}) => (
	<div className="grid gap-1">
		<UsageBar
			label={label}
			value={`${formatBytes(free)} free of ${formatBytes(total)}`}
			ratio={free != null && total ? 1 - free / total : null}
			level={free != null && thresholds ? level(free, thresholds) : undefined}
		/>
		{thresholds && (
			<p className="pl-[5.25rem] text-xs text-muted-foreground">
				Below {formatBytes(thresholds.cleanupBytes)} free, the least recently
				used caches go until {formatBytes(thresholds.targetBytes)} are free;{" "}
				{note} {formatBytes(thresholds.reserveBytes)}.
			</p>
		)}
	</div>
);

export const DiskStatus = ({ machine }: { machine: RunnerMachine }) => {
	const host = machine.observed?.host;
	const sandbox = machine.observed?.sandbox;
	const { diskThresholds } = machine;
	if (machine.platform === "macos") {
		return (
			<div className="grid gap-3">
				<DiskLine
					label="Mac"
					free={host?.diskFreeBytes}
					total={host?.diskTotalBytes}
					thresholds={diskThresholds.host}
					note="the VM caches shrink to give the space back, and no new job starts below"
				/>
				<DiskLine
					label="VM disk"
					free={sandbox?.diskFreeBytes}
					total={sandbox?.diskTotalBytes}
					thresholds={diskThresholds.vm}
					note="no new job starts below"
				/>
			</div>
		);
	}
	return (
		<DiskLine
			label="Disk"
			free={host?.diskFreeBytes}
			total={host?.diskTotalBytes}
			thresholds={diskThresholds.host}
			note="no new job starts below"
		/>
	);
};

const TRIGGER: Record<Cleanup["trigger"], string> = {
	"low-disk": "Low disk space",
	filling: "Disk filling up",
	routine: "Routine (waste only)",
	"manual-light": "Manual: waste",
	"manual-full": "Manual: every cache",
};

const KIND: Record<Cleanup["freed"][number]["kind"], string> = {
	containers: "containers",
	volumes: "volumes",
	images: "images",
	build_cache: "build cache",
	tool_cache: "tool cache",
	home: "home caches",
	workspaces: "workspaces",
	other: "other",
};

const freedTotal = (cleanup: Cleanup) =>
	cleanup.freed.reduce((sum, item) => sum + item.bytes, 0);

const Result = ({ cleanup }: { cleanup: Cleanup }) => {
	if (cleanup.error) {
		return (
			<Badge variant="red" title={cleanup.error}>
				failed
			</Badge>
		);
	}
	if (cleanup.idle === "skipped-jobs") {
		return (
			<Badge
				variant="orange"
				title="Caches used within the last day go only while no job runs: the next cleanup does it once the running jobs end."
			>
				waiting for jobs
			</Badge>
		);
	}
	if (
		cleanup.targetBytes !== null &&
		!cleanup.reached &&
		freedTotal(cleanup) < 1024 ** 2
	) {
		return (
			<Badge
				variant="orange"
				title="Every cache is gone already: something else fills the disk. Retried every 30 minutes while it stays low."
			>
				nothing left
			</Badge>
		);
	}
	if (cleanup.targetBytes !== null && !cleanup.reached) {
		return (
			<Badge
				variant="orange"
				title={`Target ${formatBytes(cleanup.targetBytes)} free`}
			>
				short of target
			</Badge>
		);
	}
	return <Badge variant="green">done</Badge>;
};

const CleanupHistory = ({ cleanups }: { cleanups: Cleanup[] }) => {
	if (!cleanups.length) {
		return (
			<p className="text-sm text-muted-foreground">
				No cleanup yet. Waste is removed every 6 hours while the machine is
				idle, and caches as soon as free space runs low.
			</p>
		);
	}
	return (
		<Table>
			<TableHeader>
				<TableRow>
					<TableHead>Cleanup</TableHead>
					<TableHead className="text-right">Freed</TableHead>
					<TableHead className="text-right">Free after</TableHead>
					<TableHead className="text-right">Result</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{cleanups.map((cleanup) => (
					<TableRow key={cleanup.at}>
						<TableCell>
							<span className="font-medium">{TRIGGER[cleanup.trigger]}</span>
							<span className="block text-xs text-muted-foreground">
								{format(new Date(cleanup.at), "MMM d, HH:mm")} ·{" "}
								{formatDuration(Math.round(cleanup.durationMs / 1000))}
								{cleanup.freed.length > 0 &&
									` · ${cleanup.freed
										.filter((item) => item.bytes > 0)
										.map(
											(item) =>
												`${KIND[item.kind]} ${formatBytes(item.bytes)}${item.count ? ` (${item.count})` : ""}`,
										)
										.join(", ")}`}
							</span>
						</TableCell>
						<TableCell className="text-right tabular-nums">
							{formatBytes(freedTotal(cleanup))}
						</TableCell>
						<TableCell className="text-right tabular-nums">
							{formatBytes(cleanup.freeAfterBytes)}
							{cleanup.hostFreeAfterBytes != null && (
								<span className="block text-xs text-muted-foreground">
									Mac {formatBytes(cleanup.hostFreeAfterBytes)}
								</span>
							)}
						</TableCell>
						<TableCell className="text-right">
							<Result cleanup={cleanup} />
						</TableCell>
					</TableRow>
				))}
			</TableBody>
		</Table>
	);
};

export const DiskCleanup = ({ machine }: { machine: RunnerMachine }) => {
	const utils = api.useUtils();
	const clean = api.githubRunner.cleanCaches.useMutation();
	const running = ["ready", "draining"].includes(machine.phase);
	const run = (mode: "light" | "full") =>
		clean
			.mutateAsync({ githubRunnerNodeId: machine.githubRunnerNodeId, mode })
			.then(() => {
				toast.success(
					mode === "full" ? "Clearing the caches" : "Removing waste",
				);
				setTimeout(() => void utils.githubRunner.overview.invalidate(), 5000);
			})
			.catch((error: Error) => toast.error(error.message));
	return (
		<div className="grid gap-4">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<p className="text-sm font-medium">Disk cleanup</p>
				<div className="flex gap-2">
					<Button
						size="sm"
						variant="outline"
						disabled={!running || clean.isPending}
						onClick={() => void run("light")}
					>
						<Eraser className="size-4" />
						Remove waste
					</Button>
					<DialogAction
						title="Clear every cache?"
						description="Docker images, build cache, tool cache and package caches are deleted: the next jobs download and build everything again. While jobs run, only the caches unused for a day go; jobs starting during the cleanup wait for it."
						onClick={() => void run("full")}
					>
						<Button
							size="sm"
							variant="outline"
							disabled={!running || clean.isPending}
						>
							<Trash2 className="size-4" />
							Clear all caches
						</Button>
					</DialogAction>
				</div>
			</div>
			<DiskStatus machine={machine} />
			<CleanupHistory cleanups={machine.cleanups} />
		</div>
	);
};
