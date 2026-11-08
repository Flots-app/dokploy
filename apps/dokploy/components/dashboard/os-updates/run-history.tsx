import { Loader2, RotateCcw, ShieldAlert, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { DialogAction } from "@/components/shared/dialog-action";
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
import { api, type RouterOutputs } from "@/utils/api";
import { errorText } from "../github-runners/format";
import {
	browserTimeZone,
	cancelRunText,
	dateText,
	type OsUpdateRunRow,
	periodText,
	REBOOT_LABELS,
	RUN_STATUS,
	zonedDateText,
} from "./format";

type RunDetail = RouterOutputs["osUpdate"]["run"];

const RunSummary = ({ run }: { run: RunDetail }) => {
	const status = RUN_STATUS[run.status];
	const zone = browserTimeZone();
	// A window in its schedule's zone, as the configuration reads.
	const origin =
		run.trigger === "manual"
			? `Install now${run.requestedBy ? ` by ${run.requestedBy}` : ""}`
			: `Window of ${zonedDateText(run.windowStart, run.configuration?.schedule.timeZone)}${run.configuration ? `, ${run.configuration.name}` : ""}`;
	return (
		<>
			<div className="flex flex-wrap items-center gap-2">
				<Badge variant={status.variant}>{status.label}</Badge>
				<span className="text-muted-foreground">{origin}</span>
				{run.rebooted && <Badge variant="blue">rebooted</Badge>}
				{!run.rebooted && run.rebootRequired && (
					<Badge variant="yellow">reboot pending</Badge>
				)}
			</div>
			{run.message && (
				<p
					className={
						run.status === "failed" ? "text-destructive" : "text-foreground"
					}
				>
					{run.message}
				</p>
			)}
			<dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
				<div>
					<dt className="text-muted-foreground">Started ({zone})</dt>
					<dd>{dateText(run.startedAt, zone)}</dd>
				</div>
				<div>
					<dt className="text-muted-foreground">Ended ({zone})</dt>
					<dd>{dateText(run.finishedAt, zone)}</dd>
				</div>
				<div>
					<dt className="text-muted-foreground">Updates</dt>
					<dd>
						{run.settings.classification === "security" ? "security" : "all"}
						{run.settings.allowDockerUpdates ? ", Docker included" : ""}
					</dd>
				</div>
				<div>
					<dt className="text-muted-foreground">Reboot</dt>
					<dd>{REBOOT_LABELS[run.settings.reboot]}</dd>
				</div>
			</dl>
		</>
	);
};

const ChangedPackages = ({ packages }: { packages: RunDetail["packages"] }) => (
	<div className="grid gap-2">
		<p className="font-medium">
			{packages.length} package{packages.length === 1 ? "" : "s"} changed
		</p>
		<div className="max-h-48 overflow-auto rounded border">
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>Package</TableHead>
						<TableHead>From</TableHead>
						<TableHead>To</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{packages.map((item) => (
						<TableRow key={item.name}>
							<TableCell className="font-mono text-xs">
								{item.name}
								{item.security && (
									<ShieldAlert
										className="ml-1 inline size-3 text-orange-500"
										aria-label="security update"
									/>
								)}
							</TableCell>
							{/* Long Debian versions wrap instead of being cut off. */}
							<TableCell className="font-mono text-xs whitespace-normal break-all">
								{item.from ?? "new"}
							</TableCell>
							<TableCell className="font-mono text-xs whitespace-normal break-all">
								{item.to ?? "removed"}
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	</div>
);

const RunDetails = ({ runId }: { runId: string }) => {
	const { data, isPending, error } = api.osUpdate.run.useQuery(
		{ osUpdateRunId: runId },
		{
			refetchInterval: (query) =>
				["pending", "running"].includes(query.state.data?.status ?? "")
					? 3000
					: false,
		},
	);
	if (isPending) {
		return (
			<Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />
		);
	}
	if (error) {
		return (
			<p className="text-sm text-destructive">
				Unable to load the run: {errorText(error)}
			</p>
		);
	}
	return (
		<div className="grid gap-4 text-sm">
			<RunSummary run={data} />
			{data.packages.length > 0 && <ChangedPackages packages={data.packages} />}
			<div className="grid gap-2">
				{/* The server writes the log: its times are UTC, not the zone above. */}
				<p className="font-medium">
					Log <span className="font-normal text-muted-foreground">(UTC)</span>
				</p>
				<pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded bg-muted p-3 font-mono text-xs">
					{data.log || "No log yet."}
				</pre>
			</div>
		</div>
	);
};

export const RunDetailsDialog = ({
	run,
	onOpenChange,
}: {
	run: OsUpdateRunRow | null;
	onOpenChange: (open: boolean) => void;
}) => (
	<Dialog open={run !== null} onOpenChange={onOpenChange}>
		<DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto">
			<DialogHeader>
				<DialogTitle>
					OS updates of {run?.machineName ?? "a server"}
				</DialogTitle>
				<DialogDescription>
					What the run installed, whether it rebooted, and its log.
				</DialogDescription>
			</DialogHeader>
			{run && <RunDetails runId={run.osUpdateRunId} />}
		</DialogContent>
	</Dialog>
);

/** Cancelling is final for the window: confirmed first. */
const CancelButton = ({ run }: { run: OsUpdateRunRow }) => {
	const utils = api.useUtils();
	const cancel = api.osUpdate.cancelRun.useMutation();
	const server = run.machineName ?? "this server";
	return (
		<DialogAction
			title={`Cancel the update of ${server}?`}
			description={cancelRunText(run)}
			type="destructive"
			onClick={async () => {
				try {
					await cancel.mutateAsync({ osUpdateRunId: run.osUpdateRunId });
					await Promise.all([
						utils.osUpdate.runs.invalidate(),
						utils.osUpdate.overview.invalidate(),
					]);
					toast.success("Run cancelled");
				} catch (error) {
					toast.error(errorText(error, "The run could not be cancelled"));
				}
			}}
		>
			<Button
				size="icon"
				variant="ghost"
				className="size-7"
				aria-label={`Cancel the update of ${server}`}
				disabled={cancel.isPending}
			>
				<X className="size-3.5" />
			</Button>
		</DialogAction>
	);
};

export const RunHistory = ({ canRun }: { canRun: boolean }) => {
	const { data, isPending, error } = api.osUpdate.runs.useQuery(
		{ limit: 100 },
		{ refetchInterval: 5000 },
	);
	const [shown, setShown] = useState<OsUpdateRunRow | null>(null);
	const zone = browserTimeZone();
	if (isPending) {
		return (
			<div className="flex items-center gap-2 text-sm text-muted-foreground">
				<Loader2 className="size-4 animate-spin" /> Loading
			</div>
		);
	}
	if (error) {
		return (
			<p className="text-sm text-destructive">
				Unable to load the history: {errorText(error)}
			</p>
		);
	}
	if (!data.length) {
		return (
			<div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
				No run yet: they appear here once a window opens, or after Install now.
			</div>
		);
	}
	return (
		<>
			<div className="overflow-x-auto rounded-lg border">
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>Machine</TableHead>
							<TableHead>Status</TableHead>
							<TableHead>Trigger</TableHead>
							<TableHead>When ({zone})</TableHead>
							<TableHead>Packages</TableHead>
							<TableHead>Outcome</TableHead>
							<TableHead />
						</TableRow>
					</TableHeader>
					<TableBody>
						{data.map((run) => {
							const status = RUN_STATUS[run.status];
							return (
								<TableRow key={run.osUpdateRunId}>
									<TableCell className="font-medium">
										{run.machineName ?? run.serverId ?? run.githubRunnerNodeId}
									</TableCell>
									<TableCell>
										<span className="inline-flex items-center gap-1">
											<Badge variant={status.variant}>{status.label}</Badge>
											{run.rebooted && (
												<RotateCcw
													className="size-3 text-muted-foreground"
													aria-label="rebooted"
												/>
											)}
										</span>
									</TableCell>
									<TableCell className="text-xs text-muted-foreground">
										<span className="block max-w-36 whitespace-normal">
											{run.trigger === "manual"
												? "Install now"
												: (run.configurationName ?? "Schedule")}
										</span>
									</TableCell>
									<TableCell className="text-xs">
										{periodText(run.startedAt, run.finishedAt, zone)}
									</TableCell>
									<TableCell className="text-xs">
										{run.packages.length || "—"}
									</TableCell>
									<TableCell className="text-xs text-muted-foreground">
										<span
											className="line-clamp-2 block min-w-40 max-w-64 whitespace-normal"
											title={run.message ?? undefined}
										>
											{run.message ?? ""}
										</span>
									</TableCell>
									<TableCell>
										<span className="flex items-center gap-1">
											<Button
												size="sm"
												variant="ghost"
												aria-label={`Details of the update of ${run.machineName ?? run.serverId ?? run.githubRunnerNodeId}`}
												onClick={() => setShown(run)}
											>
												Details
											</Button>
											{canRun &&
												(run.status === "pending" ||
													// A runner machine still waiting for its jobs.
													(run.status === "running" &&
														run.githubRunnerNodeId !== null &&
														(run.progress?.step ?? "drain") === "drain")) && (
													<CancelButton run={run} />
												)}
										</span>
									</TableCell>
								</TableRow>
							);
						})}
					</TableBody>
				</Table>
			</div>
			<RunDetailsDialog
				run={shown}
				onOpenChange={(open) => {
					if (!open) setShown(null);
				}}
			/>
		</>
	);
};
