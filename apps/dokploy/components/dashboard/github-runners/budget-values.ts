export interface BudgetValues {
	cpuPercent: number;
	memoryPercent: number;
	maxRunners: number;
	diskReserveGb: number;
	diskCleanupGb: number;
	vmDiskGb: number;
	extraLabels: string;
}

export const defaultBudget: BudgetValues = {
	cpuPercent: 70,
	memoryPercent: 70,
	maxRunners: 0,
	diskReserveGb: 15,
	diskCleanupGb: 30,
	vmDiskGb: 60,
	extraLabels: "",
};

export const parseLabels = (value: string) =>
	value
		.split(/[\s,]+/)
		.map((label) => label.trim())
		.filter(Boolean);
