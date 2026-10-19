import { Github, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
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
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { api } from "@/utils/api";
import { AddMachine } from "./add-machine";
import { formatDuration, type RunnerPool } from "./format";
import { HandlePool } from "./handle-pool";
import { MachineCard } from "./machine-card";
import { JobsTable } from "./machine-monitoring";
import { RoutingStatus } from "./pool-routing";
import { GettingStarted, WorkflowSnippet } from "./pool-usage";

const PoolStats = ({ pool }: { pool: RunnerPool }) => {
	const { data: stats } = api.githubRunner.jobStats.useQuery(
		{ githubRunnerPoolId: pool.githubRunnerPoolId },
		{ refetchInterval: 30_000 },
	);
	const active = pool.nodes.filter(
		(node) => node.phase === "ready" && node.enabled,
	);
	const capacity = active.reduce(
		(sum, node) => sum + node.resolvedMaxRunners,
		0,
	);
	const busy = pool.nodes.reduce(
		(sum, node) =>
			sum +
			(node.observed?.slots ?? []).filter((slot) => slot.state === "busy")
				.length,
		0,
	);
	const cpus = active.reduce((sum, node) => sum + (node.budget?.cpus ?? 0), 0);
	const total = stats?.reduce((sum, entry) => sum + entry.total, 0) ?? 0;
	const interrupted =
		stats?.reduce((sum, entry) => sum + entry.interrupted, 0) ?? 0;
	const durations =
		stats?.filter((entry) => entry.averageSeconds !== null) ?? [];
	const average = durations.length
		? Math.round(
				durations.reduce(
					(sum, entry) => sum + (entry.averageSeconds ?? 0) * entry.completed,
					0,
				) /
					Math.max(
						1,
						durations.reduce((sum, entry) => sum + entry.completed, 0),
					),
			)
		: null;
	const items = [
		["Machines active", `${active.length}/${pool.nodes.length}`],
		["Jobs running", `${busy}/${capacity}`],
		["CPUs available", `${Math.round(cpus * 10) / 10}`],
		[
			"Jobs in 24 h",
			`${total}${interrupted ? ` (${interrupted} interrupted)` : ""}`,
		],
		["Average job", formatDuration(average)],
	];
	return (
		<div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
			{items.map(([label, value]) => (
				<div key={label} className="rounded-lg border p-3">
					<p className="text-xs text-muted-foreground">{label}</p>
					<p className="text-lg font-semibold tabular-nums">{value}</p>
				</div>
			))}
		</div>
	);
};

const PoolSection = ({
	pool,
	permissions,
}: {
	pool: RunnerPool;
	permissions: { create: boolean; update: boolean; delete: boolean };
}) => {
	const utils = api.useUtils();
	const remove = api.githubRunner.removePool.useMutation();
	const target =
		pool.scope === "organization"
			? `${pool.owner} · runner group ${pool.runnerGroup}`
			: `${pool.owner}/${pool.repository}`;
	return (
		<section className="grid gap-4 rounded-xl border p-4">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="space-y-1">
					<div className="flex items-center gap-2">
						<h2 className="text-lg font-semibold">{pool.name}</h2>
						<Badge variant="outline">
							{pool.authType === "token"
								? "Token"
								: pool.authType === "app"
									? "GitHub App"
									: "Dokploy provider"}
						</Badge>
					</div>
					<p className="text-sm text-muted-foreground">
						{pool.scope === "organization" ? "Organization" : "Repository"}{" "}
						{target}
						{pool.runnerVersion
							? ` · runner ${pool.runnerVersion}`
							: " · latest runner"}
					</p>
					<div className="flex flex-wrap gap-1">
						{["self-hosted", "Linux", ...pool.labels].map((label) => (
							<Badge key={label} variant="secondary">
								{label}
							</Badge>
						))}
					</div>
				</div>
				<div className="flex items-center gap-1">
					{permissions.create && (
						<AddMachine poolId={pool.githubRunnerPoolId} />
					)}
					{permissions.update && <HandlePool pool={pool} />}
					{permissions.delete && pool.nodes.length === 0 && (
						<DialogAction
							title={`Delete ${pool.name}?`}
							description="The pool has no machine; its settings and credentials are deleted."
							onClick={async () => {
								try {
									await remove.mutateAsync({
										githubRunnerPoolId: pool.githubRunnerPoolId,
									});
									await utils.githubRunner.overview.invalidate();
									toast.success("Pool deleted");
								} catch (error) {
									toast.error(
										error instanceof Error ? error.message : "Unable to delete",
									);
								}
							}}
						>
							<Button variant="ghost" size="icon" aria-label="Delete pool">
								<Trash2 className="size-4" />
							</Button>
						</DialogAction>
					)}
				</div>
			</div>
			<RoutingStatus pool={pool} />
			<WorkflowSnippet pool={pool} />
			<PoolStats pool={pool} />
			{pool.nodes.length === 0 ? (
				<div className="flex flex-col items-center gap-3 rounded-lg border border-dashed py-8 text-center">
					<p className="max-w-md text-sm text-muted-foreground">
						Next: add the machine that runs the jobs, a Mac or a Linux machine
						reachable over SSH. Dokploy installs everything on it.
					</p>
					{permissions.create && (
						<AddMachine poolId={pool.githubRunnerPoolId} />
					)}
				</div>
			) : (
				<div className="grid gap-4 lg:grid-cols-2">
					{pool.nodes.map((node) => (
						<MachineCard
							key={node.githubRunnerNodeId}
							machine={node}
							canUpdate={permissions.update}
							canDelete={permissions.delete}
							rerunInterruptedJobs={pool.rerunInterruptedJobs}
						/>
					))}
				</div>
			)}
			<Collapsible>
				<CollapsibleTrigger asChild>
					<Button variant="link" className="w-fit px-0">
						Recent jobs
					</Button>
				</CollapsibleTrigger>
				<CollapsibleContent>
					<JobsTable poolId={pool.githubRunnerPoolId} machineId={null} />
				</CollapsibleContent>
			</Collapsible>
		</section>
	);
};

export const ShowGithubRunners = () => {
	const { data: permissions } = api.user.getPermissions.useQuery();
	const { data, isPending, error } = api.githubRunner.overview.useQuery(
		undefined,
		{
			refetchInterval: 4000,
		},
	);
	const allowed = {
		create: Boolean(permissions?.githubRunner?.create),
		update: Boolean(permissions?.githubRunner?.update),
		delete: Boolean(permissions?.githubRunner?.delete),
	};

	return (
		<div className="w-full">
			<Card className="mx-auto h-full max-w-7xl rounded-xl p-2.5">
				<div className="rounded-xl bg-background shadow-md">
					<CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
						<div className="space-y-1.5">
							<CardTitle className="flex flex-row gap-2 text-xl">
								<Github className="size-6 self-center text-muted-foreground" />
								GitHub Runners
							</CardTitle>
							<CardDescription>
								Self-hosted runners on your Macs and Linux machines. Each
								machine gives the runners a share of its CPU and memory and can
								be taken out at any time, waiting for its jobs or interrupting
								them.
							</CardDescription>
						</div>
						{allowed.create && <HandlePool />}
					</CardHeader>
					<CardContent className="grid gap-6 border-t py-6">
						{isPending ? (
							<div className="flex min-h-[25vh] items-center justify-center gap-2 text-sm text-muted-foreground">
								Loading <Loader2 className="size-4 animate-spin" />
							</div>
						) : error ? (
							<p className="text-sm text-destructive">{error.message}</p>
						) : data?.length === 0 ? (
							<GettingStarted action={allowed.create && <HandlePool />} />
						) : (
							data?.map((pool) => (
								<PoolSection
									key={pool.githubRunnerPoolId}
									pool={pool}
									permissions={allowed}
								/>
							))
						)}
					</CardContent>
				</div>
			</Card>
		</div>
	);
};
