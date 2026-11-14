import { PROVIDER_NAMES } from "@dokploy/server/utils/github-runners/providers";
import { fallbackRunsOn } from "@dokploy/server/utils/github-runners/routing";
import { x64Label } from "@dokploy/server/utils/github-runners/x64";
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
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { RunnerPool } from "./format";
import type { PoolFormValues } from "./pool-form";
import { ProvidersFields, ProvidersUsage } from "./pool-providers";
import { NumberInput } from "./shared";

/** Step 3: where jobs go while no runner of the pool is ON. */
export const RoutingFields = ({
	form,
	pool,
}: {
	form: UseFormReturn<PoolFormValues>;
	pool?: RunnerPool;
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
										? "An organization variable, visible to its private repositories. On GitHub Free they cannot read organization variables: use a repository pool there."
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
					<FormField
						control={form.control}
						name="x64FallbackLabels"
						render={({ field }) => (
							<FormItem className="sm:col-span-2">
								<FormLabel>Fallback runner of the x86_64 jobs</FormLabel>
								<FormControl>
									<Input placeholder="ubuntu-24.04" {...field} />
								</FormControl>
								<FormDescription>
									Jobs that need x86_64 read the variable suffixed with _X64:
									the x86_64 runners of the pool&apos;s Macs (Rosetta), or this
									GitHub-hosted image.
								</FormDescription>
								<FormMessage />
							</FormItem>
						)}
					/>
					<FailoverFields form={form} />
					<ProvidersFields form={form} pool={pool} />
				</div>
			)}
		</div>
	);
};

/** When a machine that keeps losing jobs is set aside (see health.ts). */
const FailoverFields = ({ form }: { form: UseFormReturn<PoolFormValues> }) => (
	<div className="grid gap-4 sm:col-span-2 sm:grid-cols-3">
		<FormField
			control={form.control}
			name="failover.mode"
			render={({ field }) => (
				<FormItem className="sm:col-span-3">
					<FormLabel>Failover</FormLabel>
					<Select value={field.value} onValueChange={field.onChange}>
						<FormControl>
							<SelectTrigger>
								<SelectValue />
							</SelectTrigger>
						</FormControl>
						<SelectContent>
							<SelectItem value="auto">
								Automatic: leave the machines that lose jobs (recommended)
							</SelectItem>
							<SelectItem value="pool">Keep the jobs on this pool</SelectItem>
							<SelectItem value="fallback">
								Send every job to the fallback
							</SelectItem>
						</SelectContent>
					</Select>
					<FormDescription>
						A machine whose runners stay online can still lose its jobs (out of
						memory, a VM that stops). Automatic: such a machine takes no new job
						for a while, and the jobs go to the fallback once no machine is
						left.
					</FormDescription>
				</FormItem>
			)}
		/>
		<FormField
			control={form.control}
			name="failover.interruptions"
			render={({ field }) => (
				<FormItem>
					<FormLabel>Lost jobs</FormLabel>
					<FormControl>
						<NumberInput
							value={field.value}
							onValueChange={field.onChange}
							onBlur={field.onBlur}
							min={0}
							max={20}
						/>
					</FormControl>
					<FormDescription>
						Interrupted, or killed for memory; 0 never sets a machine aside.
					</FormDescription>
				</FormItem>
			)}
		/>
		<FormField
			control={form.control}
			name="failover.windowMinutes"
			render={({ field }) => (
				<FormItem>
					<FormLabel>Within (minutes)</FormLabel>
					<FormControl>
						<NumberInput
							value={field.value}
							onValueChange={field.onChange}
							onBlur={field.onBlur}
							min={1}
							max={120}
						/>
					</FormControl>
				</FormItem>
			)}
		/>
		<FormField
			control={form.control}
			name="failover.cooldownMinutes"
			render={({ field }) => (
				<FormItem>
					<FormLabel>Set aside for (minutes)</FormLabel>
					<FormControl>
						<NumberInput
							value={field.value}
							onValueChange={field.onChange}
							onBlur={field.onBlur}
							min={1}
							max={24 * 60}
						/>
					</FormControl>
					<FormDescription>After its last lost job.</FormDescription>
				</FormItem>
			)}
		/>
	</div>
);

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
	const routing = pool.routing;
	// Routing turned off: shown only while GitHub still holds the variable.
	if (!pool.routingVariable && !routing?.error) return null;
	const fallback = fallbackRunsOn(pool.fallbackLabels);
	let line: { tone: string; text: string };
	if (!pool.routingVariable) {
		line = { tone: "bg-red-500", text: routing?.error ?? "" };
	} else if (!routing) {
		line = {
			tone: "bg-muted-foreground",
			text: `Publishing ${pool.routingVariable}…`,
		};
	} else if (routing.error) {
		line = {
			tone: "bg-red-500",
			text: `Cannot update ${pool.routingVariable}: ${routing.error}`,
		};
	} else if (pool.failover?.mode === "pool") {
		line = {
			tone: "bg-blue-500",
			text: "Failover off: jobs stay on these machines whatever happens",
		};
	} else if (pool.failover?.mode === "fallback") {
		line = {
			tone: "bg-orange-500",
			text: `Every job goes to ${fallback} (GitHub-hosted), as the pool settings ask`,
		};
	} else if (routing.target === "pool") {
		line = {
			tone: "bg-emerald-500",
			text: routing.unavailableSince
				? `No runner ON since ${time(routing.unavailableSince)}: jobs move to ${fallback} in two minutes unless one comes back`
				: "Jobs go to these machines",
		};
	} else {
		const aside = setAside(pool);
		line = {
			tone: "bg-orange-500",
			text: `No runner ON since ${time(routing.since)}: jobs go to ${routing.value} (${routing.provider ? PROVIDER_NAMES[routing.provider] : "GitHub-hosted"})${aside.length ? `. Set aside: ${aside.join("; ")}` : ""}`,
		};
	}
	return (
		<div className="grid gap-2 text-xs text-muted-foreground">
			<span className="flex items-start gap-2 text-sm text-foreground">
				<span className={`mt-1.5 size-2 shrink-0 rounded-full ${line.tone}`} />
				{line.text}
			</span>
			<X64RoutingLine pool={pool} />
			<ProvidersUsage pool={pool} />
			<Reroutes pool={pool} />
		</div>
	);
};

/** Machines set aside after losing jobs, with why and until when (see health.ts). */
const setAside = (pool: RunnerPool) =>
	pool.nodes.flatMap((node) =>
		node.health && Date.parse(node.health.degradedUntil) > Date.now()
			? [
					`${node.name} until ${time(node.health.degradedUntil)}, ${node.health.reason}`,
				]
			: [],
	);

/** Where the jobs that need x86_64 go: shown once a machine runs x86_64 runners. */
const X64RoutingLine = ({ pool }: { pool: RunnerPool }) => {
	const routing = pool.x64Routing;
	if (!pool.routingVariable || !routing) return null;
	if (!pool.nodes.some((node) => node.x64Runners > 0)) return null;
	const variable = `${pool.routingVariable}_X64`;
	const target = `[self-hosted, ${pool.labels.map(x64Label).join(", ")}]`;
	const line = routing.error
		? {
				tone: "bg-red-500",
				text: `Cannot update ${variable}: ${routing.error}`,
			}
		: routing.target === "pool"
			? {
					tone: "bg-emerald-500",
					text: `x86_64 jobs go to the x86_64 runners of these machines (${target})`,
				}
			: {
					tone: "bg-orange-500",
					text: `No x86_64 runner ON: x86_64 jobs go to ${routing.value} (${routing.provider ? PROVIDER_NAMES[routing.provider] : "GitHub-hosted"})`,
				};
	return (
		<span className="flex items-start gap-2 text-sm text-foreground">
			<span className={`mt-1.5 size-2 shrink-0 rounded-full ${line.tone}`} />
			{line.text}
		</span>
	);
};
