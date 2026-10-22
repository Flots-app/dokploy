import { format } from "date-fns";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/utils/api";
import { errorText, type RunnerMachine } from "./format";

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
				? `Unable to load the log: ${errorText(error)}`
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
	const { data, isPending, error } = api.githubRunner.operations.useQuery(
		{ githubRunnerNodeId: machine.githubRunnerNodeId, limit: 30 },
		{ enabled: open, refetchInterval: open ? 2000 : false },
	);
	// The latest operation is open until the operator picks one ("" closes all).
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
				{isPending ? (
					<Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />
				) : error ? (
					<p className="text-sm text-destructive">
						Unable to load the operations: {errorText(error)}
					</p>
				) : !data.length ? (
					<p className="text-sm text-muted-foreground">No operation yet.</p>
				) : null}
				<ul className="grid gap-2">
					{data?.map((operation) => {
						const id = operation.githubRunnerOperationId;
						return (
							<Collapsible
								key={id}
								asChild
								open={shown === id}
								onOpenChange={(open) => setExpanded(open ? id : "")}
							>
								<li className="rounded-md border">
									<CollapsibleTrigger className="flex w-full items-center justify-between gap-3 p-3 text-left text-sm">
										<span className="min-w-0">
											<span className="block truncate font-medium">
												{operation.summary}
											</span>
											<span className="text-xs text-muted-foreground">
												{format(new Date(operation.createdAt), "PPpp")}
												{operation.user?.email
													? ` · ${operation.user.email}`
													: ""}
											</span>
										</span>
										<Badge variant={STATUS[operation.status]}>
											{operation.status}
										</Badge>
									</CollapsibleTrigger>
									<CollapsibleContent className="border-t p-3">
										{operation.errorMessage && (
											<p className="mb-2 text-sm text-destructive">
												{operation.errorMessage}
											</p>
										)}
										<OperationLog
											operationId={id}
											running={operation.status === "running"}
										/>
									</CollapsibleContent>
								</li>
							</Collapsible>
						);
					})}
				</ul>
			</DialogContent>
		</Dialog>
	);
};
