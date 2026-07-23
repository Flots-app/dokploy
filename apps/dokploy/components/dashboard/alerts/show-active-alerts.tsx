import { formatDistanceToNow } from "date-fns";
import {
	AlertTriangle,
	CheckCircle2,
	Clock3,
	Database,
	ExternalLink,
	Folder,
	Info,
	RefreshCw,
	Search,
	Server,
	ShieldAlert,
	X,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { api } from "@/utils/api";
import {
	type ActiveAlertFilters,
	filterActiveAlerts,
} from "./active-alert-filters";

const defaultFilters: ActiveAlertFilters = {
	search: "",
	severity: "all",
	databaseType: "all",
	projectId: "all",
	environmentId: "all",
	age: "all",
	sort: "newest",
};

const severityBadge = {
	critical: "red",
	warning: "yellow",
	info: "blue",
} as const;

const severityIcon = {
	critical: ShieldAlert,
	warning: AlertTriangle,
	info: Info,
} as const;

export function ShowActiveAlerts() {
	const [filters, setFilters] = useState<ActiveAlertFilters>(defaultFilters);
	const activeAlerts = api.observability.activeAlerts.useQuery(undefined, {
		refetchInterval: 15_000,
		retry: false,
	});
	const alerts = activeAlerts.data ?? [];
	const projects = useMemo(
		() =>
			[
				...new Map(
					alerts
						.filter((alert) => alert.projectId)
						.map((alert) => [
							alert.projectId as string,
							{ id: alert.projectId as string, name: alert.projectName },
						]),
				).values(),
			].sort((left, right) => left.name.localeCompare(right.name)),
		[alerts],
	);
	const environments = useMemo(
		() =>
			[
				...new Map(
					alerts
						.filter(
							(alert) =>
								alert.environmentId &&
								(filters.projectId === "all" ||
									alert.projectId === filters.projectId),
						)
						.map((alert) => [
							alert.environmentId as string,
							{
								id: alert.environmentId as string,
								name: alert.environmentName,
							},
						]),
				).values(),
			].sort((left, right) => left.name.localeCompare(right.name)),
		[alerts, filters.projectId],
	);
	const filteredAlerts = useMemo(
		() => filterActiveAlerts(alerts, filters),
		[alerts, filters],
	);
	const criticalCount = alerts.filter(
		(alert) => alert.severity === "critical",
	).length;
	const warningCount = alerts.filter(
		(alert) => alert.severity === "warning",
	).length;
	const oldestAlert = [...alerts].sort(
		(left, right) =>
			new Date(left.startsAt).getTime() - new Date(right.startsAt).getTime(),
	)[0];
	const activeFilterCount = [
		filters.search.trim() !== "",
		filters.severity !== "all",
		filters.databaseType !== "all",
		filters.projectId !== "all",
		filters.environmentId !== "all",
		filters.age !== "all",
	].filter(Boolean).length;

	const resetFilters = () => setFilters(defaultFilters);

	if (activeAlerts.isLoading) {
		return (
			<div className="space-y-4">
				<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
					{Array.from({ length: 4 }, (_, index) => (
						<Skeleton className="h-24 rounded-xl" key={index} />
					))}
				</div>
				<Skeleton className="h-28 rounded-xl" />
				<Skeleton className="h-48 rounded-xl" />
			</div>
		);
	}

	if (activeAlerts.error) {
		return (
			<Alert variant="destructive">
				<AlertTriangle />
				<AlertTitle>Unable to load active alerts</AlertTitle>
				<AlertDescription className="flex flex-wrap items-center gap-3">
					<span>{activeAlerts.error.message}</span>
					<Button
						variant="outline"
						size="sm"
						onClick={() => activeAlerts.refetch()}
					>
						Try again
					</Button>
				</AlertDescription>
			</Alert>
		);
	}

	return (
		<div className="space-y-4">
			<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
				<SummaryCard
					label="Open alerts"
					value={alerts.length}
					icon={ShieldAlert}
					className="text-destructive"
				/>
				<SummaryCard
					label="Critical"
					value={criticalCount}
					icon={AlertTriangle}
					className="text-red-500"
				/>
				<SummaryCard
					label="Warnings"
					value={warningCount}
					icon={AlertTriangle}
					className="text-yellow-500"
				/>
				<SummaryCard
					label="Oldest active"
					value={
						oldestAlert
							? formatDistanceToNow(new Date(oldestAlert.startsAt))
							: "—"
					}
					icon={Clock3}
				/>
			</div>

			<Card>
				<CardHeader className="pb-3">
					<div className="flex flex-wrap items-center justify-between gap-2">
						<div>
							<CardTitle className="text-base">Filters</CardTitle>
							<p className="mt-1 text-sm text-muted-foreground">
								Showing {filteredAlerts.length} of {alerts.length} unresolved
								alert{alerts.length === 1 ? "" : "s"}.
							</p>
						</div>
						<div className="flex items-center gap-2">
							{activeFilterCount > 0 && (
								<Button variant="ghost" size="sm" onClick={resetFilters}>
									<X className="size-4" />
									Clear {activeFilterCount}
								</Button>
							)}
							<Button
								variant="outline"
								size="sm"
								onClick={() => activeAlerts.refetch()}
								disabled={activeAlerts.isFetching}
							>
								<RefreshCw
									className={cn(
										"size-4",
										activeAlerts.isFetching && "animate-spin",
									)}
								/>
								Refresh
							</Button>
						</div>
					</div>
				</CardHeader>
				<CardContent>
					<div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
						<div className="relative md:col-span-2">
							<Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
							<Input
								aria-label="Search active alerts"
								className="pl-9"
								placeholder="Search alert, database, project, metric…"
								value={filters.search}
								onChange={(event) =>
									setFilters((current) => ({
										...current,
										search: event.target.value,
									}))
								}
							/>
						</div>
						<FilterSelect
							label="All severities"
							value={filters.severity}
							onValueChange={(severity) =>
								setFilters((current) => ({
									...current,
									severity: severity as ActiveAlertFilters["severity"],
								}))
							}
							options={[
								{ value: "all", label: "All severities" },
								{ value: "critical", label: "Critical" },
								{ value: "warning", label: "Warning" },
								{ value: "info", label: "Info" },
							]}
						/>
						<FilterSelect
							label="All databases"
							value={filters.databaseType}
							onValueChange={(databaseType) =>
								setFilters((current) => ({
									...current,
									databaseType:
										databaseType as ActiveAlertFilters["databaseType"],
								}))
							}
							options={[
								{ value: "all", label: "All databases" },
								{ value: "postgres", label: "PostgreSQL" },
								{ value: "redis", label: "Redis" },
							]}
						/>
						<FilterSelect
							label="All projects"
							value={filters.projectId}
							onValueChange={(projectId) =>
								setFilters((current) => ({
									...current,
									projectId,
									environmentId: "all",
								}))
							}
							options={[
								{ value: "all", label: "All projects" },
								...projects.map((project) => ({
									value: project.id,
									label: project.name,
								})),
							]}
						/>
						<FilterSelect
							label="All environments"
							value={filters.environmentId}
							onValueChange={(environmentId) =>
								setFilters((current) => ({ ...current, environmentId }))
							}
							options={[
								{ value: "all", label: "All environments" },
								...environments.map((environment) => ({
									value: environment.id,
									label: environment.name,
								})),
							]}
						/>
						<FilterSelect
							label="Any duration"
							value={filters.age}
							onValueChange={(age) =>
								setFilters((current) => ({
									...current,
									age: age as ActiveAlertFilters["age"],
								}))
							}
							options={[
								{ value: "all", label: "Any duration" },
								{ value: "under-1h", label: "Under 1 hour" },
								{ value: "1h-24h", label: "1–24 hours" },
								{ value: "1d-7d", label: "1–7 days" },
								{ value: "over-7d", label: "Over 7 days" },
							]}
						/>
						<FilterSelect
							label="Newest first"
							value={filters.sort}
							onValueChange={(sort) =>
								setFilters((current) => ({
									...current,
									sort: sort as ActiveAlertFilters["sort"],
								}))
							}
							options={[
								{ value: "newest", label: "Newest first" },
								{ value: "oldest", label: "Oldest first" },
								{ value: "severity", label: "Severity" },
							]}
						/>
					</div>
				</CardContent>
			</Card>

			{alerts.length === 0 ? (
				<EmptyState
					title="All clear"
					description="No alert has fired without a matching resolution."
					icon={CheckCircle2}
				/>
			) : filteredAlerts.length === 0 ? (
				<EmptyState
					title="No alerts match these filters"
					description="Clear or adjust the filters to see the unresolved incidents."
					icon={Search}
					action={
						<Button variant="outline" onClick={resetFilters}>
							Clear filters
						</Button>
					}
				/>
			) : (
				<div className="space-y-3">
					{filteredAlerts.map((alert) => {
						const SeverityIcon = severityIcon[alert.severity];
						const databaseHref =
							alert.databaseType && alert.projectId && alert.environmentId
								? `/dashboard/project/${alert.projectId}/environment/${alert.environmentId}/services/${alert.databaseType}/${alert.serviceId}?tab=monitoring`
								: null;

						return (
							<Card
								key={alert.databaseAlertEventId}
								className={cn(
									"border-l-4",
									alert.severity === "critical" && "border-l-red-500",
									alert.severity === "warning" && "border-l-yellow-500",
									alert.severity === "info" && "border-l-blue-500",
								)}
							>
								<CardContent className="p-4 sm:p-5">
									<div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
										<div className="min-w-0 space-y-3">
											<div className="flex flex-wrap items-center gap-2">
												<SeverityIcon className="size-5" />
												<h2 className="font-semibold">{alert.name}</h2>
												<Badge variant={severityBadge[alert.severity]}>
													{alert.severity}
												</Badge>
												<Badge variant="destructive">firing</Badge>
												{alert.databaseType && (
													<Badge variant="outline">
														{alert.databaseType === "postgres"
															? "PostgreSQL"
															: "Redis"}
													</Badge>
												)}
											</div>
											{alert.description && (
												<p className="text-sm text-muted-foreground">
													{alert.description}
												</p>
											)}
											<div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
												<span className="inline-flex items-center gap-1.5">
													<Database className="size-4 text-muted-foreground" />
													{alert.databaseName}
												</span>
												<span className="inline-flex items-center gap-1.5">
													<Folder className="size-4 text-muted-foreground" />
													{alert.projectName} / {alert.environmentName}
												</span>
												<span className="inline-flex items-center gap-1.5">
													<Clock3 className="size-4 text-muted-foreground" />
													Fired{" "}
													{formatDistanceToNow(new Date(alert.startsAt), {
														addSuffix: true,
													})}
												</span>
											</div>
											<div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
												{alert.metricKey && (
													<code className="rounded bg-muted px-2 py-1">
														{alert.metricKey}
													</code>
												)}
												{alert.value !== null && (
													<span className="rounded bg-muted px-2 py-1 font-mono">
														value: {alert.value}
													</span>
												)}
												<span>fingerprint: {alert.fingerprint}</span>
											</div>
										</div>
										{databaseHref ? (
											<Button asChild variant="outline" size="sm">
												<Link href={databaseHref}>
													Open database
													<ExternalLink className="size-4" />
												</Link>
											</Button>
										) : (
											<Badge variant="secondary">
												<Server className="size-3" />
												Resource unavailable
											</Badge>
										)}
									</div>
								</CardContent>
							</Card>
						);
					})}
				</div>
			)}
		</div>
	);
}

function SummaryCard({
	label,
	value,
	icon: Icon,
	className,
}: {
	label: string;
	value: number | string;
	icon: typeof ShieldAlert;
	className?: string;
}) {
	return (
		<Card>
			<CardContent className="flex items-center justify-between p-4">
				<div>
					<p className="text-sm text-muted-foreground">{label}</p>
					<p className="mt-1 text-2xl font-semibold">{value}</p>
				</div>
				<Icon className={cn("size-5 text-muted-foreground", className)} />
			</CardContent>
		</Card>
	);
}

function FilterSelect({
	value,
	onValueChange,
	options,
	label,
}: {
	value: string;
	onValueChange: (value: string) => void;
	options: Array<{ value: string; label: string }>;
	label: string;
}) {
	return (
		<Select value={value} onValueChange={onValueChange}>
			<SelectTrigger aria-label={label} className="w-full">
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{options.map((option) => (
					<SelectItem key={option.value} value={option.value}>
						{option.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

function EmptyState({
	title,
	description,
	icon: Icon,
	action,
}: {
	title: string;
	description: string;
	icon: typeof Search;
	action?: React.ReactNode;
}) {
	return (
		<div className="flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed p-8 text-center">
			<div className="rounded-full bg-muted p-3">
				<Icon className="size-6 text-muted-foreground" />
			</div>
			<h2 className="mt-4 font-semibold">{title}</h2>
			<p className="mt-1 max-w-md text-sm text-muted-foreground">
				{description}
			</p>
			{action && <div className="mt-4">{action}</div>}
		</div>
	);
}
