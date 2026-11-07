import { Loader2, RotateCcw, ShieldAlert, X } from "lucide-react";
import { useState } from "react";
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
import { api, type RouterOutputs } from "@/utils/api";
import { errorText } from "../github-runners/format";
import { dateText, type OsUpdateRunRow, RUN_STATUS } from "./format";

type RunDetail = RouterOutputs["osUpdate"]["run"];

const RunSummary = ({ run }: { run: RunDetail }) => {
	const status = RUN_STATUS[run.status];
	const origin =
		run.trigger === "manual"
			? `Install now${run.requestedBy ? ` by ${run.requestedBy}` : ""}`
			: `Window of ${dateText(run.windowStart)}${run.configuration ? ` (${run.configuration.name})` : ""}`;
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
					<dt className="text-muted-foreground">Started</dt>
					<dd>{dateText(run.startedAt)}</dd>
				</div>
				<div>
					<dt className="text-muted-foreground">Ended</dt>
					<dd>{dateText(run.finishedAt)}</dd>
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
					<dd>{run.settings.reboot}</dd>
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
							<TableCell className="font-mono text-xs">
								{item.from ?? "new"}
							</TableCell>
							<TableCell className="font-mono text-xs">
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
			<pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded bg-muted p-3 font-mono text-xs">
				{data.log || "No log yet."}
			</pre>
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
				<DialogTitle>OS updates of {run?.serverName ?? "a server"}</DialogTitle>
				<DialogDescription>
					What the run installed, whether it rebooted, and its log.
				</DialogDescription>
			</DialogHeader>
			{run && <RunDetails runId={run.osUpdateRunId} />}
		</DialogContent>
	</Dialog>
);

const CancelButton = ({ run }: { run: OsUpdateRunRow }) => {
	const utils = api.useUtils();
	const cancel = api.osUpdate.cancelRun.useMutation();
	return (
		<Button
			size="icon"
			variant="ghost"
			className="size-7"
			aria-label="Cancel this run"
			disabled={cancel.isPending}
			onClick={async (event) => {
				event.stopPropagation();
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
			<X className="size-3.5" />
		</Button>
	);
};

export const RunHistory = ({ canRun }: { canRun: boolean }) => {
	const { data, isPending, error } = api.osUpdate.runs.useQuery(
		{ limit: 100 },
		{ refetchInterval: 5000 },
	);
	const [shown, setShown] = useState<OsUpdateRunRow | null>(null);
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
							<TableHead>Server</TableHead>
							<TableHead>Status</TableHead>
							<TableHead>Trigger</TableHead>
							<TableHead>Started</TableHead>
							<TableHead>Ended</TableHead>
							<TableHead>Packages</TableHead>
							<TableHead>Outcome</TableHead>
							<TableHead />
						</TableRow>
					</TableHeader>
					<TableBody>
						{data.map((run) => {
							const status = RUN_STATUS[run.status];
							return (
								<TableRow
									key={run.osUpdateRunId}
									className="cursor-pointer"
									onClick={() => setShown(run)}
								>
									<TableCell className="font-medium">
										{run.serverName ?? run.serverId}
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
										{run.trigger === "manual"
											? "Install now"
											: (run.configurationName ?? "Schedule")}
									</TableCell>
									<TableCell className="text-xs">
										{dateText(run.startedAt ?? run.windowStart)}
									</TableCell>
									<TableCell className="text-xs">
										{dateText(run.finishedAt)}
									</TableCell>
									<TableCell className="text-xs">
										{run.packages.length || "—"}
									</TableCell>
									<TableCell className="max-w-80 truncate text-xs text-muted-foreground">
										{run.message ?? ""}
									</TableCell>
									<TableCell>
										{canRun && run.status === "pending" && (
											<CancelButton run={run} />
										)}
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
