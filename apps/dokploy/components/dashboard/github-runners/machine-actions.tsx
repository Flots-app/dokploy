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
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { api } from "@/utils/api";
import { elapsed, formatDuration, type RunnerMachine, runUrl } from "./format";
import { CopyCode, NumberInput } from "./shared";
import { useNow } from "./use-now";

type Mode = "wait" | "deadline" | "kill";

/** The jobs a machine runs now, as the operator should see them before stopping it. */
export const RunningJobs = ({ machine }: { machine: RunnerMachine }) => {
	const now = useNow();
	const busy = (machine.observed?.slots ?? []).filter(
		(slot) => slot.state === "busy",
	);
	if (!busy.length) {
		return (
			<p className="text-sm text-muted-foreground">
				No job is running on {machine.name}.
			</p>
		);
	}
	return (
		<div className="space-y-2">
			<p className="text-sm font-medium">
				{busy.length} job{busy.length > 1 ? "s" : ""} running
			</p>
			<ul className="grid gap-1 text-sm">
				{busy.map((slot) => (
					<li key={slot.slot} className="flex justify-between gap-2">
						<span className="truncate">
							{slot.job ? (
								<a
									href={runUrl(slot.job)}
									target="_blank"
									rel="noreferrer"
									className="text-primary hover:underline"
								>
									{slot.job.repository} · {slot.job.workflow} · {slot.job.job}
								</a>
							) : (
								`Slot ${slot.slot}`
							)}
						</span>
						<span className="tabular-nums text-muted-foreground">
							{formatDuration(elapsed(slot.job?.startedAt ?? slot.since, now))}
						</span>
					</li>
				))}
			</ul>
		</div>
	);
};

const ModeChoice = ({
	mode,
	setMode,
	minutes,
	rerun,
	setMinutes,
	waitLabel,
}: {
	mode: Mode;
	setMode: (mode: Mode) => void;
	minutes: number;
	setMinutes: (minutes: number) => void;
	waitLabel: string;
	rerun: boolean;
}) => (
	<RadioGroup
		value={mode}
		onValueChange={(value) => setMode(value as Mode)}
		className="gap-3"
	>
		<Label className="flex items-start gap-3 font-normal">
			<RadioGroupItem value="wait" className="mt-0.5" />
			<span>
				<span className="font-medium">Wait for the running jobs</span>
				<span className="block text-xs text-muted-foreground">{waitLabel}</span>
			</span>
		</Label>
		<Label className="flex items-start gap-3 font-normal">
			<RadioGroupItem value="deadline" className="mt-0.5" />
			<span className="flex flex-1 flex-col gap-1">
				<span className="font-medium">Wait at most</span>
				<span className="flex flex-wrap items-center gap-2">
					<NumberInput
						min={1}
						className="h-8 w-20"
						aria-label="Minutes to wait"
						value={minutes}
						onFocus={() => setMode("deadline")}
						onValueChange={setMinutes}
					/>
					<span className="text-xs text-muted-foreground">
						minutes, then interrupt what still runs
					</span>
				</span>
			</span>
		</Label>
		<Label className="flex items-start gap-3 font-normal">
			<RadioGroupItem value="kill" className="mt-0.5" />
			<span>
				<span className="font-medium text-destructive">
					Interrupt the jobs now
				</span>
				<span className="block text-xs text-muted-foreground">
					{rerun
						? "The jobs are cancelled, then re-run automatically on the other machines of the pool. The resources are freed within a minute."
						: "The jobs are cancelled (they fail on GitHub and can be re-run) and the resources are freed within a minute."}
				</span>
			</span>
		</Label>
	</RadioGroup>
);

interface MachineDialogProps {
	machine: RunnerMachine;
	rerun: boolean;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

/** Mounted only while its dialog is open, so each opening starts afresh. */
const DisableMachineForm = ({
	machine,
	rerun,
	onOpenChange,
}: Omit<MachineDialogProps, "open">) => {
	const utils = api.useUtils();
	const disable = api.githubRunner.disableMachine.useMutation();
	const [mode, setMode] = useState<Mode>("wait");
	const [minutes, setMinutes] = useState(30);

	const onConfirm = async () => {
		try {
			await disable.mutateAsync({
				githubRunnerNodeId: machine.githubRunnerNodeId,
				mode: mode === "kill" ? "kill" : "wait",
				timeoutMinutes: mode === "deadline" ? minutes : null,
			});
			await utils.githubRunner.overview.invalidate();
			toast.success(
				mode === "kill"
					? `${machine.name}: stopping now`
					: `${machine.name}: takes no new job, disabling once idle`,
			);
			onOpenChange(false);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Unable to disable");
		}
	};

	return (
		<>
			<DialogHeader>
				<DialogTitle>Disable {machine.name}</DialogTitle>
				<DialogDescription>
					It takes no new job right away. Once empty,{" "}
					{machine.platform === "macos"
						? "its VM shuts down and the Mac gets all its CPU and memory back."
						: "its runners stop and the machine gets its resources back."}
				</DialogDescription>
			</DialogHeader>
			<RunningJobs machine={machine} />
			<ModeChoice
				mode={mode}
				setMode={setMode}
				minutes={minutes}
				setMinutes={setMinutes}
				waitLabel="Nothing is interrupted; idle runners leave immediately."
				rerun={rerun}
			/>
			{disable.error && (
				<AlertBlock type="error">{disable.error.message}</AlertBlock>
			)}
			<DialogFooter>
				<Button variant="outline" onClick={() => onOpenChange(false)}>
					Cancel
				</Button>
				<Button
					variant={mode === "kill" ? "destructive" : "default"}
					onClick={onConfirm}
					disabled={disable.isPending}
				>
					{disable.isPending && <Loader2 className="size-4 animate-spin" />}
					{mode === "kill" ? "Interrupt and disable" : "Disable"}
				</Button>
			</DialogFooter>
		</>
	);
};

export const DisableMachineDialog = ({
	open,
	onOpenChange,
	...props
}: MachineDialogProps) => (
	<Dialog open={open} onOpenChange={onOpenChange}>
		<DialogContent className="sm:max-w-lg">
			<DisableMachineForm {...props} onOpenChange={onOpenChange} />
		</DialogContent>
	</Dialog>
);

const RemoveMachineForm = ({
	machine,
	rerun,
	onOpenChange,
}: Omit<MachineDialogProps, "open">) => {
	const utils = api.useUtils();
	const remove = api.githubRunner.removeMachine.useMutation();
	const [mode, setMode] = useState<Mode>("wait");
	const [minutes, setMinutes] = useState(30);
	const [uninstall, setUninstall] = useState(true);
	const [force, setForce] = useState(false);
	const unreachable = machine.observed ? !machine.observed.reachable : false;
	// Nothing is installed yet: the machine is only forgotten.
	const enrolling = machine.phase === "enrolling";

	const onConfirm = async () => {
		try {
			await remove.mutateAsync({
				githubRunnerNodeId: machine.githubRunnerNodeId,
				mode: mode === "kill" ? "kill" : "wait",
				timeoutMinutes: mode === "deadline" ? minutes : null,
				uninstall,
				force,
			});
			await utils.githubRunner.overview.invalidate();
			toast.success(`${machine.name}: removal started`);
			onOpenChange(false);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Unable to remove");
		}
	};

	return (
		<>
			<DialogHeader>
				<DialogTitle>Remove {machine.name}</DialogTitle>
				<DialogDescription>
					{enrolling
						? "Its setup never finished: Dokploy forgets it and its key."
						: "Its runners are unregistered from GitHub, then the machine leaves the pool."}
				</DialogDescription>
			</DialogHeader>
			{!enrolling && <RunningJobs machine={machine} />}
			{!force && !enrolling && (
				<ModeChoice
					mode={mode}
					setMode={setMode}
					minutes={minutes}
					setMinutes={setMinutes}
					waitLabel="The machine is removed once its jobs finish."
					rerun={rerun}
				/>
			)}
			{!enrolling && (
				<div className="grid gap-3">
					<div className="flex items-center justify-between gap-4 text-sm">
						<Label htmlFor="remove-uninstall" className="block font-normal">
							Uninstall the runtime
							<span className="block text-xs text-muted-foreground">
								{machine.platform === "macos"
									? machine.applied?.vmCreatedByDokploy
										? `Deletes the VM ${machine.vmName} and its caches.`
										: `Removes the runtime from ${machine.vmName}; this VM was not created by Dokploy and is kept.`
									: "Removes the runner account, services and caches."}
							</span>
						</Label>
						<Switch
							id="remove-uninstall"
							checked={uninstall}
							onCheckedChange={setUninstall}
							disabled={force}
						/>
					</div>
					<div className="flex items-center justify-between gap-4 text-sm">
						<Label htmlFor="remove-force" className="block font-normal">
							Forget without reaching the machine
							<span className="block text-xs text-muted-foreground">
								For a machine that is gone. Nothing is stopped or uninstalled on
								it.
							</span>
						</Label>
						<Switch
							id="remove-force"
							checked={force}
							onCheckedChange={setForce}
						/>
					</div>
				</div>
			)}
			{machine.hasOwnKey && (
				<div className="grid gap-1.5 text-sm text-muted-foreground">
					<span>
						{enrolling ? "If its setup script already ran, the" : "The"}{" "}
						dokploy-manager account it created stays on the machine. Once the
						machine is removed, delete it with any copy of that script:
					</span>
					<CopyCode
						code={`sudo bash dokploy-runner-setup-${machine.name}.sh --uninstall`}
					/>
				</div>
			)}
			{unreachable && !force && (
				<AlertBlock type="warning">
					{machine.name} is unreachable: the removal waits until it answers,
					unless you forget it.
				</AlertBlock>
			)}
			{remove.error && (
				<AlertBlock type="error">{remove.error.message}</AlertBlock>
			)}
			<DialogFooter>
				<Button variant="outline" onClick={() => onOpenChange(false)}>
					Cancel
				</Button>
				<Button
					variant="destructive"
					onClick={onConfirm}
					disabled={remove.isPending}
				>
					{remove.isPending && <Loader2 className="size-4 animate-spin" />}
					Remove
				</Button>
			</DialogFooter>
		</>
	);
};

export const RemoveMachineDialog = ({
	open,
	onOpenChange,
	...props
}: MachineDialogProps) => (
	<Dialog open={open} onOpenChange={onOpenChange}>
		<DialogContent className="sm:max-w-lg">
			<RemoveMachineForm {...props} onOpenChange={onOpenChange} />
		</DialogContent>
	</Dialog>
);
