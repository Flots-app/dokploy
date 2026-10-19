import { fallbackRunsOn } from "@dokploy/server/utils/github-runners/routing";
import { format } from "date-fns";
import { type UseFormReturn, useWatch } from "react-hook-form";
import { Badge } from "@/components/ui/badge";
import {
	FormControl,
	FormDescription,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { RunnerPool } from "./format";
import type { PoolFormValues } from "./pool-form";

/** Step 3: where jobs go while no runner of the pool is ON. */
export const RoutingFields = ({
	form,
}: {
	form: UseFormReturn<PoolFormValues>;
}) => {
	const [enabled, scope] = useWatch({
		control: form.control,
		name: ["routingEnabled", "scope"],
	});
	return (
		<div className="grid gap-3 rounded-lg border p-3">
			<FormField
				control={form.control}
				name="routingEnabled"
				render={({ field }) => (
					<FormItem className="flex items-start justify-between gap-4">
						<div className="space-y-1">
							<FormLabel>Fall back to GitHub-hosted runners</FormLabel>
							<FormDescription>
								While at least one runner of this pool is ON, jobs come to these
								machines; otherwise they go to GitHub-hosted runners. Dokploy
								keeps a GitHub Actions variable up to date, and moves the jobs
								left waiting by machines that went off.
							</FormDescription>
						</div>
						<FormControl>
							<Switch checked={field.value} onCheckedChange={field.onChange} />
						</FormControl>
					</FormItem>
				)}
			/>
			{enabled && (
				<div className="grid gap-4 sm:grid-cols-2">
					<FormField
						control={form.control}
						name="routingVariable"
						render={({ field }) => (
							<FormItem>
								<FormLabel>Variable</FormLabel>
								<FormControl>
									<Input className="font-mono" {...field} />
								</FormControl>
								<FormDescription>
									{scope === "organization"
										? "An organization variable, visible to its private repositories."
										: "A variable of the repository."}
								</FormDescription>
								<FormMessage />
							</FormItem>
						)}
					/>
					<FormField
						control={form.control}
						name="fallbackLabels"
						render={({ field }) => (
							<FormItem>
								<FormLabel>Fallback runner</FormLabel>
								<FormControl>
									<Input placeholder="ubuntu-24.04" {...field} />
								</FormControl>
								<FormDescription>
									A GitHub-hosted image, e.g. ubuntu-24.04 or ubuntu-24.04-arm.
								</FormDescription>
								<FormMessage />
							</FormItem>
						)}
					/>
				</div>
			)}
		</div>
	);
};

const time = (iso: string) => format(new Date(iso), "HH:mm");

const REROUTE = {
	cancelling: { label: "cancelling", variant: "blank" },
	requested: { label: "re-run asked", variant: "blue" },
	rerouted: { label: "moved", variant: "green" },
	failed: { label: "not moved", variant: "red" },
} as const;

const Reroutes = ({ pool }: { pool: RunnerPool }) =>
	pool.reroutes.length ? (
		<ul className="grid gap-1">
			{pool.reroutes.map((row) => (
				<li
					key={row.githubRunnerRerouteId}
					className="flex flex-wrap items-center gap-2"
				>
					<Badge variant={REROUTE[row.status].variant}>
						{REROUTE[row.status].label}
					</Badge>
					<a
						href={`https://github.com/${row.repository}/actions/runs/${row.runId}`}
						target="_blank"
						rel="noreferrer"
						className="text-foreground underline underline-offset-4"
					>
						{row.repository} · {row.workflow}
					</a>
					<span>{time(row.createdAt)}</span>
					{row.status === "failed" && row.note && <span>{row.note}</span>}
				</li>
			))}
		</ul>
	) : null;

/** Where the jobs of the pool go right now, and the runs moved to the fallback. */
export const RoutingStatus = ({ pool }: { pool: RunnerPool }) => {
	if (!pool.routingVariable) return null;
	const routing = pool.routing;
	const fallback = fallbackRunsOn(pool.fallbackLabels);
	let line: { tone: string; text: string };
	if (!routing) {
		line = {
			tone: "bg-muted-foreground",
			text: `Publishing ${pool.routingVariable}…`,
		};
	} else if (routing.error) {
		line = {
			tone: "bg-red-500",
			text: `Cannot update ${pool.routingVariable}: ${routing.error}`,
		};
	} else if (routing.target === "pool") {
		line = {
			tone: "bg-emerald-500",
			text: routing.unavailableSince
				? `No runner ON since ${time(routing.unavailableSince)}: jobs move to ${fallback} in two minutes unless one comes back`
				: "Jobs go to these machines",
		};
	} else {
		line = {
			tone: "bg-orange-500",
			text: `No runner ON since ${time(routing.since)}: jobs go to ${fallback} (GitHub-hosted)`,
		};
	}
	return (
		<div className="grid gap-2 text-xs text-muted-foreground">
			<span className="flex items-start gap-2 text-sm text-foreground">
				<span className={`mt-1.5 size-2 shrink-0 rounded-full ${line.tone}`} />
				{line.text}
			</span>
			<Reroutes pool={pool} />
		</div>
	);
};
