import { format } from "date-fns";
import { Loader2, RefreshCw } from "lucide-react";
import dynamic from "next/dynamic";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
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
import {
	elapsed,
	formatBytes,
	formatDuration,
	percentText,
	type RunnerMachine,
	runUrl,
} from "./format";
import { useNow } from "./use-now";

// recharts is only needed once the monitoring dialog is opened.
const UsageCharts = dynamic(
	() => import("./usage-charts").then((module) => module.UsageCharts),
	{
		ssr: false,
		loading: () => (
			<Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />
		),
	},
);

const Caches = ({ machine }: { machine: RunnerMachine }) => {
	const utils = api.useUtils();
	const refresh = api.githubRunner.refreshCaches.useMutation();
	const caches = machine.observed?.caches;
	const rows: [string, number | null | undefined, string][] = [
		[
			"Docker images",
			caches?.dockerImagesBytes,
			"Pulled and built images, kept between jobs",
		],
		[
			"BuildKit cache",
			caches?.dockerBuildCacheBytes,
			"Layer cache of docker build, pruned after 7 days",
		],
		["Docker volumes", caches?.dockerVolumesBytes, "Volumes of job containers"],
		[
			"Containers",
			caches?.dockerContainersBytes,
			"Writable layers of job containers",
		],
		[
			"Tool cache",
			caches?.toolCacheBytes,
			"setup-node, setup-python… shared by every runner",
		],
		[
			"Runner home",
			caches?.homeCacheBytes,
			"Package manager caches (npm, pnpm, Gradle…)",
		],
		[
			"Workspaces",
			caches?.workspacesBytes,
			"Checkouts of the running jobs, wiped between jobs",
		],
	];
	return (
		<div className="grid gap-4">
			<div className="flex items-center justify-between">
				<p className="text-sm text-muted-foreground">
					{caches
						? `Measured ${format(new Date(caches.at), "PPpp")}`
						: "Not measured yet: sizes are read every 10 minutes."}
				</p>
				<Button
					size="sm"
					variant="outline"
					disabled={refresh.isPending}
					onClick={async () => {
						const started = await refresh
							.mutateAsync({ githubRunnerNodeId: machine.githubRunnerNodeId })
							.catch(() => false);
						toast[started ? "success" : "error"](
							started
								? "Measuring the caches…"
								: "The machine is busy, try again shortly",
						);
						setTimeout(
							() => void utils.githubRunner.overview.invalidate(),
							8000,
						);
					}}
				>
					<RefreshCw className="size-4" />
					Measure now
				</Button>
			</div>
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>Cache</TableHead>
						<TableHead className="text-right">Size</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{rows.map(([name, bytes, hint]) => (
						<TableRow key={name}>
							<TableCell>
								<span className="font-medium">{name}</span>
								<span className="block text-xs text-muted-foreground">
									{hint}
								</span>
							</TableCell>
							<TableCell className="text-right tabular-nums">
								{formatBytes(bytes)}
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
			{caches?.dockerReclaimableBytes ? (
				<p className="text-xs text-muted-foreground">
					{formatBytes(caches.dockerReclaimableBytes)} of Docker data is
					reclaimable. Dokploy prunes it every 6 hours when idle, and
					aggressively below the disk reserve.
				</p>
			) : null}
		</div>
	);
};

const OUTCOME = {
	running: "blue",
	completed: "green",
	interrupted: "orange",
} as const;

const RERUN = {
	pending: "re-run pending",
	cancelling: "cancelling the run",
	requested: "re-run requested",
	skipped: "not re-run",
	failed: "re-run failed",
} as const;

export const JobsTable = ({
	poolId,
	machineId,
}: {
	poolId: string;
	machineId: string | null;
}) => {
	const now = useNow();
	const { data } = api.githubRunner.jobs.useQuery(
		{ githubRunnerPoolId: poolId, githubRunnerNodeId: machineId, limit: 50 },
		{ refetchInterval: 10_000 },
	);
	if (!data?.length) {
		return <p className="text-sm text-muted-foreground">No job yet.</p>;
	}
	return (
		<Table>
			<TableHeader>
				<TableRow>
					<TableHead>Job</TableHead>
					<TableHead>Started</TableHead>
					<TableHead className="text-right">Duration</TableHead>
					<TableHead className="text-right">Outcome</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{data.map((job) => (
					<TableRow key={job.githubRunnerJobId}>
						<TableCell className="max-w-xs">
							<a
								href={runUrl(job)}
								target="_blank"
								rel="noreferrer"
								className="block truncate text-primary hover:underline"
							>
								{job.workflow} · {job.job}
							</a>
							<span className="block truncate text-xs text-muted-foreground">
								{job.repository} · {job.runnerName}
							</span>
						</TableCell>
						<TableCell className="whitespace-nowrap text-xs">
							{format(new Date(job.startedAt), "MMM d, HH:mm")}
						</TableCell>
						<TableCell className="text-right tabular-nums">
							{formatDuration(
								job.durationSeconds ?? elapsed(job.startedAt, now),
							)}
						</TableCell>
						<TableCell className="text-right">
							<Badge variant={OUTCOME[job.outcome]}>{job.outcome}</Badge>
							{job.rerunStatus && (
								<span
									className="block text-xs text-muted-foreground"
									title={job.rerunNote ?? undefined}
								>
									{RERUN[job.rerunStatus]}
								</span>
							)}
						</TableCell>
					</TableRow>
				))}
			</TableBody>
		</Table>
	);
};

export const MachineMonitoringDialog = ({
	machine,
	open,
	onOpenChange,
}: {
	machine: RunnerMachine;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) => {
	const usage = machine.observed?.usage;
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-4xl max-h-[90vh] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>Monitoring · {machine.name}</DialogTitle>
					<DialogDescription>
						Runners now: CPU {percentText(usage?.cpuPercent)} of the budget,
						memory {formatBytes(usage?.memoryBytes)} of{" "}
						{formatBytes(usage?.memoryLimitBytes)}
						{usage?.hostMemoryFreePercent !== null &&
						usage?.hostMemoryFreePercent !== undefined
							? ` · host memory free ${Math.round(usage.hostMemoryFreePercent)}%`
							: ""}
						{usage?.hostLoad !== null && usage?.hostLoad !== undefined
							? ` · load ${usage.hostLoad}`
							: ""}
					</DialogDescription>
				</DialogHeader>
				{open && (
					<Tabs defaultValue="usage">
						<TabsList>
							<TabsTrigger value="usage">Usage</TabsTrigger>
							<TabsTrigger value="caches">Caches</TabsTrigger>
							<TabsTrigger value="jobs">Jobs</TabsTrigger>
							<TabsTrigger value="events">Events</TabsTrigger>
						</TabsList>
						<TabsContent value="usage" className="pt-4">
							<UsageCharts machine={machine} />
						</TabsContent>
						<TabsContent value="caches" className="pt-4">
							<Caches machine={machine} />
						</TabsContent>
						<TabsContent value="jobs" className="pt-4">
							<JobsTable
								poolId={machine.githubRunnerPoolId}
								machineId={machine.githubRunnerNodeId}
							/>
						</TabsContent>
						<TabsContent value="events" className="pt-4">
							{machine.observed?.events?.length ? (
								<ul className="grid gap-1 font-mono text-xs">
									{machine.observed.events.map((event) => (
										<li key={`${event.at}-${event.message}`}>
											<span className="text-muted-foreground">
												{format(new Date(event.at), "HH:mm:ss")}
											</span>{" "}
											{event.message}
										</li>
									))}
								</ul>
							) : (
								<p className="text-sm text-muted-foreground">No event yet.</p>
							)}
						</TabsContent>
					</Tabs>
				)}
			</DialogContent>
		</Dialog>
	);
};
