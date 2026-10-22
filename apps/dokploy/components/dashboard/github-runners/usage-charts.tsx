import { format } from "date-fns";
import { Loader2 } from "lucide-react";
import { useState } from "react";
// Already loaded on demand: the monitoring dialog imports this module with
// next/dynamic, and ui/chart imports recharts statically anyway.
// react-doctor-disable-next-line react-doctor/prefer-dynamic-import
import {
	Area,
	AreaChart,
	CartesianGrid,
	Line,
	LineChart,
	XAxis,
	YAxis,
} from "recharts";
import { Button } from "@/components/ui/button";
import {
	type ChartConfig,
	ChartContainer,
	ChartTooltip,
	ChartTooltipContent,
} from "@/components/ui/chart";
import { api } from "@/utils/api";
import { errorText, type RunnerMachine } from "./format";

const RANGES = [
	{ hours: 1, label: "1 h" },
	{ hours: 6, label: "6 h" },
	{ hours: 24, label: "24 h" },
	{ hours: 168, label: "7 d" },
];

const cpuConfig = {
	cpu: { label: "CPU (% of budget)", color: "hsl(var(--chart-1))" },
} satisfies ChartConfig;
const memoryConfig = {
	memory: { label: "Memory used", color: "hsl(var(--chart-2))" },
	limit: { label: "Budget", color: "hsl(var(--chart-5))" },
} satisfies ChartConfig;
const runnersConfig = {
	busy: { label: "Busy runners", color: "hsl(var(--chart-3))" },
	runners: { label: "Runners", color: "hsl(var(--chart-4))" },
} satisfies ChartConfig;

const tick = (hours: number) => (value: number) =>
	format(new Date(value), hours > 24 ? "MMM d" : "HH:mm");

interface Point {
	at: string;
	/** Epoch milliseconds: a time scale shows gaps where no sample was taken. */
	time: number;
	cpu: number | null;
	memory: number | null;
	limit: number | null;
	busy: number;
	runners: number;
}

const label = (_: unknown, payload: ReadonlyArray<{ payload?: unknown }>) => {
	const at = (payload?.[0]?.payload as { at?: string } | undefined)?.at;
	return at ? format(new Date(at), "PPpp") : "";
};

const Charts = ({ points, hours }: { points: Point[]; hours: number }) => {
	return (
		<>
			<div>
				<p className="mb-1 text-sm font-medium">CPU used by the runners</p>
				<ChartContainer config={cpuConfig} className="h-44 w-full">
					<AreaChart data={points} margin={{ left: 0, right: 8, top: 8 }}>
						<CartesianGrid vertical={false} />
						<XAxis
							dataKey="time"
							type="number"
							scale="time"
							domain={["dataMin", "dataMax"]}
							tickFormatter={tick(hours)}
							tickLine={false}
							axisLine={false}
							minTickGap={40}
						/>
						<YAxis
							domain={[0, 100]}
							tickFormatter={(value) => `${value}%`}
							tickLine={false}
							axisLine={false}
							width={40}
						/>
						<ChartTooltip
							content={<ChartTooltipContent labelFormatter={label} />}
						/>
						<Area
							dataKey="cpu"
							type="monotone"
							stroke="var(--color-cpu)"
							fill="var(--color-cpu)"
							fillOpacity={0.2}
							strokeWidth={2}
							connectNulls
						/>
					</AreaChart>
				</ChartContainer>
			</div>
			<div>
				<p className="mb-1 text-sm font-medium">Memory (GiB)</p>
				<ChartContainer config={memoryConfig} className="h-44 w-full">
					<LineChart data={points} margin={{ left: 0, right: 8, top: 8 }}>
						<CartesianGrid vertical={false} />
						<XAxis
							dataKey="time"
							type="number"
							scale="time"
							domain={["dataMin", "dataMax"]}
							tickFormatter={tick(hours)}
							tickLine={false}
							axisLine={false}
							minTickGap={40}
						/>
						<YAxis
							tickFormatter={(value) => `${Number(value).toFixed(1)}`}
							tickLine={false}
							axisLine={false}
							width={40}
						/>
						<ChartTooltip
							content={<ChartTooltipContent labelFormatter={label} />}
						/>
						<Line
							dataKey="memory"
							type="monotone"
							stroke="var(--color-memory)"
							strokeWidth={2}
							dot={false}
							connectNulls
						/>
						<Line
							dataKey="limit"
							type="stepAfter"
							stroke="var(--color-limit)"
							strokeDasharray="4 4"
							dot={false}
							connectNulls
						/>
					</LineChart>
				</ChartContainer>
			</div>
			<div>
				<p className="mb-1 text-sm font-medium">Runners</p>
				<ChartContainer config={runnersConfig} className="h-36 w-full">
					<AreaChart data={points} margin={{ left: 0, right: 8, top: 8 }}>
						<CartesianGrid vertical={false} />
						<XAxis
							dataKey="time"
							type="number"
							scale="time"
							domain={["dataMin", "dataMax"]}
							tickFormatter={tick(hours)}
							tickLine={false}
							axisLine={false}
							minTickGap={40}
						/>
						<YAxis
							allowDecimals={false}
							tickLine={false}
							axisLine={false}
							width={40}
						/>
						<ChartTooltip
							content={<ChartTooltipContent labelFormatter={label} />}
						/>
						<Area
							dataKey="runners"
							type="stepAfter"
							stroke="var(--color-runners)"
							fill="var(--color-runners)"
							fillOpacity={0.1}
						/>
						<Area
							dataKey="busy"
							type="stepAfter"
							stroke="var(--color-busy)"
							fill="var(--color-busy)"
							fillOpacity={0.3}
						/>
					</AreaChart>
				</ChartContainer>
			</div>
		</>
	);
};

export const UsageCharts = ({ machine }: { machine: RunnerMachine }) => {
	const [hours, setHours] = useState(6);
	const { data, isPending, error } = api.githubRunner.metrics.useQuery(
		{ githubRunnerNodeId: machine.githubRunnerNodeId, hours },
		{ refetchInterval: 30_000 },
	);
	const points: Point[] = (data ?? []).map((point) => ({
		at: point.at,
		time: Date.parse(point.at),
		cpu: point.cpuPercent === null ? null : Math.round(point.cpuPercent),
		memory: point.memoryBytes === null ? null : point.memoryBytes / 1024 ** 3,
		limit:
			point.memoryLimitBytes === null
				? null
				: point.memoryLimitBytes / 1024 ** 3,
		busy: point.busyRunners,
		runners: point.runners,
	}));
	return (
		<div className="grid gap-6">
			<div className="flex gap-1">
				{RANGES.map((range) => (
					<Button
						key={range.hours}
						size="sm"
						variant={range.hours === hours ? "secondary" : "ghost"}
						onClick={() => setHours(range.hours)}
					>
						{range.label}
					</Button>
				))}
			</div>
			{error ? (
				<p className="text-sm text-destructive">
					Unable to load the usage: {errorText(error)}
				</p>
			) : isPending ? (
				<Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />
			) : points.length < 2 ? (
				<p className="text-sm text-muted-foreground">
					Samples are taken every 30 seconds while the machine is reachable.
				</p>
			) : (
				<Charts points={points} hours={hours} />
			)}
		</div>
	);
};
