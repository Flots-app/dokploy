import { format } from "date-fns";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/utils/api";
import type { RunnerMachine } from "./format";

/** The log of one operation, refreshed while it runs. */
const OperationLog = ({
	operationId,
	running,
}: {
	operationId: string;
	running: boolean;
}) => {
	const { data, isPending, error } = api.githubRunner.operation.useQuery(
		{ githubRunnerOperationId: operationId },
		{ refetchInterval: running ? 2000 : false },
	);
	return (
		<pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded bg-muted p-3 font-mono text-xs">
			{error
				? `Unable to load the log: ${error.message}`
				: isPending
					? "Loading the log…"
					: data.logs || "No log yet."}
		</pre>
	);
};

const STATUS = {
	running: "blue",
	done: "green",
	error: "red",
	cancelled: "blank",
} as const;

export const MachineOperationsDialog = ({
	machine,
	open,
	onOpenChange,
}: {
	machine: RunnerMachine;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) => {
	const { data } = api.githubRunner.operations.useQuery(
		{ githubRunnerNodeId: machine.githubRunnerNodeId, limit: 30 },
		{ enabled: open, refetchInterval: open ? 2000 : false },
	);
	const [expanded, setExpanded] = useState<string | null>(null);
	const shown = expanded ?? data?.[0]?.githubRunnerOperationId ?? null;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>Operations on {machine.name}</DialogTitle>
					<DialogDescription>
						Provisioning, budget changes, disabling and removal, with their
						logs.
					</DialogDescription>
				</DialogHeader>
				{!data?.length && (
					<p className="text-sm text-muted-foreground">No operation yet.</p>
				)}
				<ul className="grid gap-2">
					{data?.map((operation) => (
						<li
							key={operation.githubRunnerOperationId}
							className="rounded-md border"
						>
							<button
								type="button"
								className="flex w-full items-center justify-between gap-3 p-3 text-left text-sm"
								onClick={() =>
									setExpanded(
										shown === operation.githubRunnerOperationId
											? ""
											: operation.githubRunnerOperationId,
									)
								}
							>
								<span className="min-w-0">
									<span className="block truncate font-medium">
										{operation.summary}
									</span>
									<span className="text-xs text-muted-foreground">
										{format(new Date(operation.createdAt), "PPpp")}
										{operation.user?.email ? ` · ${operation.user.email}` : ""}
									</span>
								</span>
								<Badge variant={STATUS[operation.status]}>
									{operation.status}
								</Badge>
							</button>
							{shown === operation.githubRunnerOperationId && (
								<div className="border-t p-3">
									{operation.errorMessage && (
										<p className="mb-2 text-sm text-destructive">
											{operation.errorMessage}
										</p>
									)}
									<OperationLog
										operationId={operation.githubRunnerOperationId}
										running={operation.status === "running"}
									/>
								</div>
							)}
						</li>
					))}
				</ul>
			</DialogContent>
		</Dialog>
	);
};
