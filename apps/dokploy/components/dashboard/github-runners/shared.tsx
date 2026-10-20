import copy from "copy-to-clipboard";
import { CopyIcon } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import type { RunnerMachine } from "./format";

const PHASES: Record<
	string,
	{
		label: string;
		variant: "green" | "yellow" | "red" | "blank" | "blue" | "orange";
	}
> = {
	enrolling: { label: "Setup pending", variant: "yellow" },
	new: { label: "New", variant: "blank" },
	provisioning: { label: "Provisioning", variant: "blue" },
	ready: { label: "Active", variant: "green" },
	draining: { label: "Draining", variant: "orange" },
	stopped: { label: "Disabled", variant: "blank" },
	error: { label: "Error", variant: "red" },
};

export const PhaseBadge = ({ machine }: { machine: RunnerMachine }) => {
	const unreachable =
		machine.observed &&
		!machine.observed.reachable &&
		machine.phase !== "stopped";
	if (unreachable) return <Badge variant="red">Unreachable</Badge>;
	const phase = PHASES[machine.phase] ?? {
		label: machine.phase,
		variant: "blank" as const,
	};
	return <Badge variant={phase.variant}>{phase.label}</Badge>;
};

/** A labelled percentage slider showing what the share is worth on the machine. */
export const BudgetSlider = ({
	label,
	value,
	onChange,
	detail,
	min = 10,
	disabled,
}: {
	label: string;
	value: number;
	onChange: (value: number) => void;
	detail: string;
	min?: number;
	disabled?: boolean;
}) => (
	<div className="space-y-2">
		<div className="flex items-baseline justify-between text-sm">
			<span className="font-medium">{label}</span>
			<span className="tabular-nums">
				<span className="font-semibold">{value}%</span>
				<span className="text-muted-foreground"> · {detail}</span>
			</span>
		</div>
		<Slider
			min={min}
			max={100}
			step={5}
			value={[value]}
			disabled={disabled}
			onValueChange={(values) => onChange(values[0] ?? value)}
			aria-label={label}
		/>
	</div>
);

/**
 * A usage bar. CPU at 100% of the budget is the goal, so only memory ("pressure")
 * turns orange then red as it fills up; disk passes its own level, set by the
 * reserve rather than by how full the volume is.
 */
export const UsageBar = ({
	label,
	value,
	ratio,
	tone = "pressure",
	level,
}: {
	label: string;
	value: string;
	ratio: number | null;
	tone?: "neutral" | "pressure";
	level?: "ok" | "warn" | "danger";
}) => {
	const percent = ratio === null ? 0 : Math.min(100, Math.round(ratio * 100));
	const resolved =
		level ?? (percent >= 90 ? "danger" : percent >= 75 ? "warn" : "ok");
	const color =
		tone === "neutral"
			? "bg-blue-500"
			: resolved === "danger"
				? "bg-red-500"
				: resolved === "warn"
					? "bg-orange-500"
					: "bg-emerald-500";
	return (
		<div className="grid grid-cols-[4.5rem_1fr_auto] items-center gap-3 text-xs">
			<span className="text-muted-foreground">{label}</span>
			<div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
				<div
					className={`h-full ${color} transition-all`}
					style={{ width: `${percent}%` }}
				/>
			</div>
			<span className="tabular-nums text-right">{value}</span>
		</div>
	);
};

/** A command or snippet to copy as is. */
export const CopyCode = ({ code }: { code: string }) => (
	<div className="flex items-start gap-2 rounded-md bg-muted px-3 py-2">
		<code className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-xs">
			{code}
		</code>
		<Button
			type="button"
			variant="ghost"
			size="icon"
			className="size-6 shrink-0"
			aria-label="Copy"
			onClick={() => {
				copy(code);
				toast.success("Copied");
			}}
		>
			<CopyIcon className="size-3.5" />
		</Button>
	</div>
);
