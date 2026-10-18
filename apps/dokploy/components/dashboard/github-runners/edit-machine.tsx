import { vmSize } from "@dokploy/server/utils/github-runners/budget";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { AlertBlock } from "@/components/shared/alert-block";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { api } from "@/utils/api";
import { BudgetFields } from "./budget-fields";
import { type BudgetValues, parseLabels } from "./budget-values";
import type { RunnerMachine } from "./format";
import { RunningJobs } from "./machine-actions";

type Mode = "wait" | "kill";

const fromMachine = (machine: RunnerMachine): BudgetValues => ({
	cpuPercent: machine.cpuPercent,
	memoryPercent: machine.memoryPercent,
	maxRunners: machine.maxRunners,
	diskReserveGb: machine.diskReserveGb,
	vmDiskGb: machine.vmDiskGb,
	extraLabels: machine.extraLabels.join(", "),
});

/** The VM size the budget needs, when it differs from the running VM. */
const vmRestartFor = (machine: RunnerMachine, budget: BudgetValues) => {
	const host = machine.observed?.host;
	const applied = machine.applied;
	if (
		machine.platform !== "macos" ||
		!host ||
		!applied ||
		machine.phase === "stopped"
	) {
		return null;
	}
	const size = vmSize(host, budget);
	const changed =
		size.cpus !== applied.cpus ||
		size.memoryBytes !== applied.memoryBytes ||
		budget.vmDiskGb > (applied.vmDiskGb ?? 0);
	return changed ? size : null;
};

const VmRestartChoice = ({
	machine,
	size,
	mode,
	onModeChange,
}: {
	machine: RunnerMachine;
	size: { cpus: number; memoryGiB: string };
	mode: Mode;
	onModeChange: (mode: Mode) => void;
}) => {
	const busy = (machine.observed?.slots ?? []).some(
		(slot) => slot.state === "busy",
	);
	return (
		<div className="grid gap-3 rounded-lg border p-4">
			<p className="text-sm">
				The new size needs a VM restart ({size.cpus} CPUs,{" "}
				{Number(size.memoryGiB)} GiB).
			</p>
			{busy && <RunningJobs machine={machine} />}
			<RadioGroup
				value={mode}
				onValueChange={(value) => onModeChange(value as Mode)}
			>
				<Label className="flex items-center gap-3 font-normal">
					<RadioGroupItem value="wait" />
					Restart once the running jobs finish (no new job meanwhile)
				</Label>
				<Label className="flex items-center gap-3 font-normal">
					<RadioGroupItem value="kill" />
					<span className="text-destructive">
						Interrupt the jobs and restart now
					</span>
				</Label>
			</RadioGroup>
		</div>
	);
};

/** Mounted only while the dialog is open, so it starts from the saved values. */
const EditMachineForm = ({
	machine,
	onDone,
}: {
	machine: RunnerMachine;
	onDone: () => void;
}) => {
	const utils = api.useUtils();
	const update = api.githubRunner.updateMachine.useMutation();
	const [budget, setBudget] = useState<BudgetValues>(() =>
		fromMachine(machine),
	);
	const [description, setDescription] = useState(machine.description ?? "");
	const [mode, setMode] = useState<Mode>("wait");
	const host = machine.observed?.host ?? null;
	const restart = vmRestartFor(machine, budget);

	const onSave = async () => {
		try {
			await update.mutateAsync({
				githubRunnerNodeId: machine.githubRunnerNodeId,
				description: description || null,
				cpuPercent: budget.cpuPercent,
				memoryPercent: budget.memoryPercent,
				maxRunners: budget.maxRunners,
				diskReserveGb: budget.diskReserveGb,
				vmDiskGb: Math.max(budget.vmDiskGb, machine.applied?.vmDiskGb ?? 0),
				extraLabels: parseLabels(budget.extraLabels),
				mode,
			});
			await utils.githubRunner.overview.invalidate();
			toast.success(
				!restart
					? `${machine.name}: resources updated`
					: mode === "kill"
						? `${machine.name}: restarting its VM with the new size`
						: `${machine.name}: the VM restarts with the new size once idle`,
			);
			onDone();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Unable to save");
		}
	};

	return (
		<>
			<div className="space-y-2">
				<Label htmlFor="machine-description">Description</Label>
				<Input
					id="machine-description"
					value={description}
					onChange={(event) => setDescription(event.target.value)}
				/>
			</div>
			{host ? (
				<BudgetFields
					platform={machine.platform}
					host={host}
					value={budget}
					onChange={setBudget}
				/>
			) : (
				<AlertBlock type="warning">
					The machine has not reported its capacity yet; the percentages apply
					once it does.
				</AlertBlock>
			)}
			{restart && (
				<VmRestartChoice
					machine={machine}
					size={restart}
					mode={mode}
					onModeChange={setMode}
				/>
			)}
			{update.error && (
				<AlertBlock type="error">{update.error.message}</AlertBlock>
			)}
			<DialogFooter>
				<Button variant="outline" onClick={onDone}>
					Cancel
				</Button>
				<Button onClick={onSave} disabled={update.isPending}>
					{update.isPending && <Loader2 className="size-4 animate-spin" />}
					Save
				</Button>
			</DialogFooter>
		</>
	);
};

export const EditMachineDialog = ({
	machine,
	open,
	onOpenChange,
}: {
	machine: RunnerMachine;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) => (
	<Dialog open={open} onOpenChange={onOpenChange}>
		<DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
			<DialogHeader>
				<DialogTitle>Resources of {machine.name}</DialogTitle>
				<DialogDescription>
					How much of the machine the runners may use. Within this budget every
					job runs at full speed.
				</DialogDescription>
			</DialogHeader>
			<EditMachineForm machine={machine} onDone={() => onOpenChange(false)} />
		</DialogContent>
	</Dialog>
);
