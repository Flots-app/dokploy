import {
	autoMaxRunners,
	budgetWarnings,
	effectiveBudget,
	formatCpuList,
	formatCpus,
	sliceLimits,
	vmSize,
} from "@dokploy/server/utils/github-runners/budget";
import { AlertBlock } from "@/components/shared/alert-block";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { BudgetValues } from "./budget-values";
import { formatBytes } from "./format";
import { BudgetSlider } from "./shared";

/** Disk reserve, cleanup threshold and, on a Mac, the VM disk. */
const DiskFields = ({
	platform,
	value,
	set,
}: {
	platform: "linux" | "macos";
	value: BudgetValues;
	set: (patch: Partial<BudgetValues>) => void;
}) => (
	<>
		<div className="space-y-2">
			<Label htmlFor="runner-disk-reserve">Disk reserve (GiB)</Label>
			<Input
				id="runner-disk-reserve"
				type="number"
				min={0}
				value={value.diskReserveGb}
				onChange={(event) =>
					set({
						diskReserveGb: Math.max(0, Number(event.target.value) || 0),
					})
				}
			/>
			<p className="text-xs text-muted-foreground">
				No new job starts below this free space on the{" "}
				{platform === "macos" ? "Mac" : "machine"}.
			</p>
		</div>
		<div className="space-y-2">
			<Label htmlFor="runner-disk-cleanup">Clean caches below (GiB)</Label>
			<Input
				id="runner-disk-cleanup"
				type="number"
				min={1}
				value={value.diskCleanupGb}
				onChange={(event) =>
					set({
						diskCleanupGb: Math.max(1, Number(event.target.value) || 1),
					})
				}
			/>
			<p className="text-xs text-muted-foreground">
				Below this free space{platform === "macos" ? " on the Mac" : ""}, or
				when the jobs are about to get there, the least recently used Docker
				images, build cache, tools and package caches
				{platform === "macos" ? " of the VM" : ""} are removed. Caches a running
				job uses are kept.
			</p>
		</div>
		{platform === "macos" && (
			<div className="space-y-2">
				<Label htmlFor="runner-vm-disk">VM disk (GiB)</Label>
				<Input
					id="runner-vm-disk"
					type="number"
					min={20}
					value={value.vmDiskGb}
					onChange={(event) =>
						set({
							vmDiskGb: Math.max(20, Number(event.target.value) || 20),
						})
					}
				/>
				<p className="text-xs text-muted-foreground">
					Sparse: it only uses what the caches hold. It can grow, never shrink.
				</p>
			</div>
		)}
		{value.diskCleanupGb <= value.diskReserveGb && (
			<p className="text-xs text-destructive sm:col-span-2">
				Caches must be cleaned before the disk reaches the reserve: set the
				cleanup threshold above it.
			</p>
		)}
	</>
);

/** Budget editor shared by "Add machine" and "Edit resources". */
export const BudgetFields = ({
	platform,
	host,
	value,
	onChange,
}: {
	platform: "linux" | "macos";
	host: { cpus: number; memoryBytes: number } | null;
	value: BudgetValues;
	onChange: (value: BudgetValues) => void;
}) => {
	const set = (patch: Partial<BudgetValues>) =>
		onChange({ ...value, ...patch });
	const effective = host ? effectiveBudget(platform, host, value) : null;
	const auto = effective ? autoMaxRunners(effective) : null;
	const cpuDetail = host
		? platform === "macos"
			? `${vmSize(host, value).cpus} of ${formatCpus(host.cpus)} (VM)`
			: (() => {
					const limits = sliceLimits(host, value);
					return `${limits.cpus} of ${formatCpus(host.cpus)}${limits.allowedCpus ? ` on ${formatCpuList(limits.allowedCpus)}` : ""}`;
				})()
		: "";
	const memoryDetail =
		host && effective
			? `${formatBytes(effective.memoryBytes)} of ${formatBytes(host.memoryBytes)}`
			: "";
	const warnings = host ? budgetWarnings(platform, host, value) : [];

	return (
		<div className="grid gap-5">
			<BudgetSlider
				label="CPU"
				value={value.cpuPercent}
				onChange={(cpuPercent) => set({ cpuPercent })}
				detail={cpuDetail}
			/>
			<BudgetSlider
				label="Memory"
				value={value.memoryPercent}
				onChange={(memoryPercent) => set({ memoryPercent })}
				detail={memoryDetail}
			/>
			<p className="text-xs text-muted-foreground -mt-2">
				{platform === "macos"
					? "The runners run in a Lima VM of exactly this size: macOS keeps the rest, whatever the jobs do. Changing it restarts the VM."
					: "A systemd slice caps the runners and every container their jobs start; changes apply live. Jobs share the whole budget, so a lone job runs at full speed."}
			</p>
			<div className="grid gap-4 sm:grid-cols-2">
				<div className="space-y-2">
					<div className="flex items-center justify-between">
						<Label htmlFor="runner-concurrency">Concurrent jobs</Label>
						<div className="flex items-center gap-2 text-xs text-muted-foreground">
							Auto
							<Switch
								checked={value.maxRunners === 0}
								onCheckedChange={(checked) =>
									set({ maxRunners: checked ? 0 : (auto ?? 2) })
								}
								aria-label="Automatic concurrency"
							/>
						</div>
					</div>
					<Input
						id="runner-concurrency"
						type="number"
						min={1}
						max={32}
						disabled={value.maxRunners === 0}
						value={value.maxRunners === 0 ? (auto ?? "") : value.maxRunners}
						onChange={(event) =>
							set({
								maxRunners: Math.min(
									32,
									Math.max(1, Number(event.target.value) || 1),
								),
							})
						}
					/>
					<p className="text-xs text-muted-foreground">
						Auto fits as many jobs as the budget holds at 2 CPUs and 3 GiB each
						{auto ? ` (${auto} here)` : ""}.
					</p>
				</div>
				<DiskFields platform={platform} value={value} set={set} />
				<div className="space-y-2">
					<Label htmlFor="runner-extra-labels">Machine labels</Label>
					<Input
						id="runner-extra-labels"
						placeholder="m6, fast"
						value={value.extraLabels}
						onChange={(event) => set({ extraLabels: event.target.value })}
					/>
					<p className="text-xs text-muted-foreground">
						Added to the pool labels for this machine only.
					</p>
				</div>
			</div>
			{warnings.length > 0 && (
				<AlertBlock type="warning">
					<ul className="list-disc pl-4">
						{warnings.map((warning) => (
							<li key={warning}>{warning}</li>
						))}
					</ul>
				</AlertBlock>
			)}
		</div>
	);
};
