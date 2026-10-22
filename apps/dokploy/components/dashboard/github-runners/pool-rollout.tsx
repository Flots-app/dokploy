import { formatDistanceToNow } from "date-fns";
import { Loader2, PauseCircle, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api } from "@/utils/api";
import { errorText, type RunnerPool } from "./format";

const LABELS = { runner: "actions/runner", runtime: "the runtime v" } as const;

/** Releases being rolled out over the pool, canary first. */
export const RolloutStatus = ({
	pool,
	canUpdate,
}: {
	pool: RunnerPool;
	canUpdate: boolean;
}) => {
	const utils = api.useUtils();
	const resume = api.githubRunner.resumeRollout.useMutation();
	const name = (id: string) =>
		pool.nodes.find((node) => node.githubRunnerNodeId === id)?.name ??
		"a removed machine";
	const rollouts = (["runtime", "runner"] as const).flatMap((kind) => {
		const rollout = pool.rollouts?.[kind];
		return rollout && !rollout.passedAt ? [{ kind, rollout }] : [];
	});
	if (!rollouts.length) return null;
	return (
		<div className="grid gap-1 text-sm">
			{rollouts.map(({ kind, rollout }) => {
				const what = `${LABELS[kind]}${kind === "runner" ? " " : ""}${rollout.target}`;
				return rollout.failedAt ? (
					<div
						key={kind}
						className="flex flex-wrap items-center gap-2 text-destructive"
					>
						<PauseCircle className="size-4" />
						Rollout of {what} paused: it failed on {name(rollout.canaryNodeId)}
						{rollout.error ? ` (${rollout.error})` : ""}.
						{canUpdate && (
							<Button
								size="sm"
								variant="outline"
								disabled={resume.isPending}
								onClick={async () => {
									try {
										await resume.mutateAsync({
											githubRunnerPoolId: pool.githubRunnerPoolId,
											kind,
										});
										await utils.githubRunner.overview.invalidate();
										toast.success(
											"Rollout resumed: the next machine to update leads it",
										);
									} catch (error) {
										toast.error(errorText(error, "Unable to resume"));
									}
								}}
							>
								<RefreshCw className="size-3.5" />
								Resume
							</Button>
						)}
					</div>
				) : (
					<div
						key={kind}
						className="flex items-center gap-2 text-muted-foreground"
					>
						<Loader2 className="size-3.5 animate-spin" />
						Rolling out {what}: {name(rollout.canaryNodeId)} first, as the
						canary
						{rollout.installedAt
							? ` (running it since ${formatDistanceToNow(new Date(rollout.installedAt))})`
							: ""}
						; the other machines follow after 10 minutes without trouble.
					</div>
				);
			})}
		</div>
	);
};
