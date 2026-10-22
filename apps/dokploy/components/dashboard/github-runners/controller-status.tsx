import { formatDistanceToNow } from "date-fns";
import { CircleAlert, ServerCog } from "lucide-react";
import { api } from "@/utils/api";

/** Which controller process leads, and how many stand by to take over. */
export const ControllerStatus = () => {
	const { data } = api.githubRunner.controllerStatus.useQuery(undefined, {
		refetchInterval: 15_000,
	});
	if (!data) return null;
	if (!data.leader) {
		return (
			<p className="flex items-center gap-2 text-xs text-destructive">
				<CircleAlert className="size-3.5" />
				No controller leads right now: machines arm themselves from their
				reserve until one does.
			</p>
		);
	}
	const instance = data.leader.instance;
	return (
		<p className="flex items-center gap-2 text-xs text-muted-foreground">
			<ServerCog className="size-3.5" />
			Controller:{" "}
			{instance
				? `${instance.kind === "standalone" ? "standalone controller" : "Dokploy"} on ${instance.host}`
				: data.leader.owner}
			, leading for {formatDistanceToNow(new Date(data.leader.since))}
			{data.standby.length
				? ` · ${data.standby.length} on standby`
				: " · no standby: machines run on their reserve if it stops"}
		</p>
	);
};
