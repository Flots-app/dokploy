import {
	type AuditAction,
	type AuditResourceType,
	auditActions,
	auditResourceTypes,
} from "@dokploy/server/db/schema/audit-log-values";
import { keepPreviousData } from "@tanstack/react-query";
import { format } from "date-fns";
import { ClipboardList, Loader2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { api } from "@/utils/api";

const PAGE_SIZE = 50;
const ANY = "all";

interface Filters {
	userEmail: string;
	resourceName: string;
	action: AuditAction | typeof ANY;
	resourceType: AuditResourceType | typeof ANY;
	from: string;
	to: string;
}

const NO_FILTERS: Filters = {
	userEmail: "",
	resourceName: "",
	action: ANY,
	resourceType: ANY,
	from: "",
	to: "",
};

const actionVariant = (action: string) => {
	if (action === "delete") return "destructive";
	if (action === "create") return "default";
	return "secondary";
};

/** A `yyyy-MM-dd` field as the first or the last instant of that local day. */
const dayBoundary = (value: string, end: boolean) =>
	value ? new Date(`${value}T${end ? "23:59:59.999" : "00:00:00"}`) : undefined;

export const ShowAuditLogs = () => {
	const [draft, setDraft] = useState<Filters>(NO_FILTERS);
	const [applied, setApplied] = useState<Filters>(NO_FILTERS);
	const [page, setPage] = useState(0);

	const { data, isPending, isFetching, isError } = api.auditLog.all.useQuery(
		{
			userEmail: applied.userEmail || undefined,
			resourceName: applied.resourceName || undefined,
			action: applied.action === ANY ? undefined : applied.action,
			resourceType:
				applied.resourceType === ANY ? undefined : applied.resourceType,
			from: dayBoundary(applied.from, false),
			to: dayBoundary(applied.to, true),
			limit: PAGE_SIZE,
			offset: page * PAGE_SIZE,
		},
		{ placeholderData: keepPreviousData },
	);

	const total = data?.total ?? 0;
	const firstRow = total === 0 ? 0 : page * PAGE_SIZE + 1;
	const lastRow = Math.min((page + 1) * PAGE_SIZE, total);

	const update = <K extends keyof Filters>(key: K, value: Filters[K]) =>
		setDraft((current) => ({ ...current, [key]: value }));

	const apply = (event: FormEvent) => {
		event.preventDefault();
		setApplied(draft);
		setPage(0);
	};

	const reset = () => {
		setDraft(NO_FILTERS);
		setApplied(NO_FILTERS);
		setPage(0);
	};

	return (
		<div className="w-full">
			<Card className="h-full bg-sidebar p-2.5 rounded-xl max-w-6xl mx-auto">
				<div className="rounded-xl bg-background shadow-md">
					<CardHeader>
						<CardTitle className="text-xl flex flex-row gap-2">
							<ClipboardList className="size-6 text-muted-foreground self-center" />
							Audit Logs
						</CardTitle>
						<CardDescription>
							Who did what in this organization, newest first.
						</CardDescription>
					</CardHeader>
					<CardContent className="space-y-4 py-8 border-t">
						<form
							onSubmit={apply}
							className="grid gap-3 md:grid-cols-3 lg:grid-cols-6"
						>
							<Input
								aria-label="User email"
								placeholder="User email"
								value={draft.userEmail}
								onChange={(event) => update("userEmail", event.target.value)}
							/>
							<Input
								aria-label="Resource name"
								placeholder="Resource name"
								value={draft.resourceName}
								onChange={(event) => update("resourceName", event.target.value)}
							/>
							<Select
								value={draft.action}
								onValueChange={(value) =>
									update("action", value as Filters["action"])
								}
							>
								<SelectTrigger aria-label="Action">
									<SelectValue placeholder="Action" />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value={ANY}>All actions</SelectItem>
									{auditActions.map((action) => (
										<SelectItem key={action} value={action}>
											{action}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<Select
								value={draft.resourceType}
								onValueChange={(value) =>
									update("resourceType", value as Filters["resourceType"])
								}
							>
								<SelectTrigger aria-label="Resource type">
									<SelectValue placeholder="Resource type" />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value={ANY}>All resources</SelectItem>
									{auditResourceTypes.map((resourceType) => (
										<SelectItem key={resourceType} value={resourceType}>
											{resourceType}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<Input
								type="date"
								aria-label="From"
								value={draft.from}
								onChange={(event) => update("from", event.target.value)}
							/>
							<Input
								type="date"
								aria-label="To"
								value={draft.to}
								onChange={(event) => update("to", event.target.value)}
							/>
							<div className="flex flex-row gap-2 md:col-span-3 lg:col-span-6">
								<Button type="submit">Apply filters</Button>
								<Button type="button" variant="outline" onClick={reset}>
									Reset
								</Button>
							</div>
						</form>

						{isPending ? (
							<div className="flex flex-row gap-2 items-center justify-center text-sm text-muted-foreground min-h-[25vh]">
								<span>Loading...</span>
								<Loader2 className="animate-spin size-4" />
							</div>
						) : isError ? (
							<div className="text-sm text-destructive min-h-[25vh] flex items-center justify-center">
								The audit logs could not be loaded.
							</div>
						) : data.items.length === 0 ? (
							<div className="flex flex-col items-center gap-3 text-sm text-muted-foreground min-h-[25vh] justify-center">
								<ClipboardList className="size-8" />
								No audit log matches these filters.
							</div>
						) : (
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>Time</TableHead>
										<TableHead>User</TableHead>
										<TableHead>Action</TableHead>
										<TableHead>Resource</TableHead>
										<TableHead>Details</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{data.items.map((entry) => (
										<TableRow key={entry.id}>
											<TableCell className="whitespace-nowrap">
												{format(entry.createdAt, "PP pp")}
											</TableCell>
											<TableCell>
												<div className="flex flex-col">
													<span>{entry.userEmail}</span>
													<span className="text-xs text-muted-foreground">
														{entry.userRole}
													</span>
												</div>
											</TableCell>
											<TableCell>
												<Badge variant={actionVariant(entry.action)}>
													{entry.action}
												</Badge>
											</TableCell>
											<TableCell>
												<div className="flex flex-col">
													<span>{entry.resourceName ?? entry.resourceId}</span>
													<span className="text-xs text-muted-foreground">
														{entry.resourceType}
													</span>
												</div>
											</TableCell>
											<TableCell>
												{entry.metadata && (
													<details className="text-xs">
														<summary className="cursor-pointer text-muted-foreground">
															Show
														</summary>
														<pre className="mt-1 max-w-sm overflow-x-auto whitespace-pre-wrap break-all">
															{JSON.stringify(entry.metadata, null, 2)}
														</pre>
													</details>
												)}
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						)}

						<div className="flex flex-row items-center justify-between text-sm text-muted-foreground">
							<span>
								{total === 0
									? "0 entries"
									: `${firstRow}–${lastRow} of ${total}`}
							</span>
							<div className="flex flex-row items-center gap-2">
								{isFetching && <Loader2 className="animate-spin size-4" />}
								<Button
									variant="outline"
									size="sm"
									disabled={page === 0}
									onClick={() => setPage((current) => current - 1)}
								>
									Previous
								</Button>
								<Button
									variant="outline"
									size="sm"
									disabled={lastRow >= total}
									onClick={() => setPage((current) => current + 1)}
								>
									Next
								</Button>
							</div>
						</div>
					</CardContent>
				</div>
			</Card>
		</div>
	);
};
