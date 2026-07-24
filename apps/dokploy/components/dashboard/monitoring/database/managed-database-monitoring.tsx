import {
	Download,
	Loader2,
	Pencil,
	Plus,
	RefreshCw,
	Trash2,
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/utils/api";

type DatabaseKind = "postgres" | "redis";
type Operator = "gt" | "gte" | "lt" | "lte" | "eq" | "neq";
type Severity = "info" | "warning" | "critical";

type RuleDraft = {
	metricKey: string;
	operator: Operator;
	threshold: string;
	lookbackWindow: string;
	forDuration: string;
	severity: Severity;
	name: string;
	description: string;
	notificationIds: string[];
	enabled: boolean;
};

const emptyDraft: RuleDraft = {
	metricKey: "",
	operator: "gt",
	threshold: "0",
	lookbackWindow: "5m",
	forDuration: "5m",
	severity: "warning",
	name: "",
	description: "",
	notificationIds: [],
	enabled: true,
};

const alertNamePattern = /^alert-[a-z0-9]+(?:-[a-z0-9]+)*$/;

const getAlertNameError = (name: string, databaseType: DatabaseKind) => {
	const trimmedName = name.trim();
	if (!trimmedName) return "Enter an alert name.";
	if (!alertNamePattern.test(trimmedName)) {
		return 'Use lowercase kebab-case starting with "alert-" and separate words with single hyphens.';
	}
	const requiredPrefix = `alert-${databaseType}-`;
	if (!trimmedName.startsWith(requiredPrefix)) {
		return `Names for this database must start with "${requiredPrefix}".`;
	}
	return null;
};

const datasourceUid = (serviceId: string) =>
	`dokploy-${serviceId.replaceAll(/[^a-zA-Z0-9_-]/g, "_")}`.slice(0, 40);

const firstMetricValue = (result: unknown) => {
	if (!Array.isArray(result) || result.length === 0) return null;
	const item = result[0] as { value?: unknown };
	if (!Array.isArray(item.value) || item.value.length < 2) return null;
	return String(item.value[1]);
};

const downloadBase64 = ({
	filename,
	data,
	contentType,
}: {
	filename: string;
	data: string;
	contentType: string;
}) => {
	const binary = window.atob(data);
	const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
	const url = URL.createObjectURL(new Blob([bytes], { type: contentType }));
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = filename;
	anchor.click();
	URL.revokeObjectURL(url);
};

export function ManagedDatabaseMonitoring({
	serviceId,
	databaseType,
	monitoringEnabled,
	resources,
	canCreate,
	canUpdate,
	canDelete,
}: {
	serviceId: string;
	databaseType: DatabaseKind;
	monitoringEnabled: boolean;
	resources: ReactNode;
	canCreate: boolean;
	canUpdate: boolean;
	canDelete: boolean;
}) {
	const utils = api.useUtils();
	const [publicUrl, setPublicUrl] = useState("");
	const [draft, setDraft] = useState<RuleDraft>(emptyDraft);
	const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
	const [alertBuilderOpen, setAlertBuilderOpen] = useState(false);
	const [databaseMonitoringEnabled, setDatabaseMonitoringEnabled] =
		useState(monitoringEnabled);
	const currentMember = api.user.get.useQuery();
	const canManageStack =
		currentMember.data?.role === "owner" ||
		currentMember.data?.role === "admin";
	const state = api.observability.state.useQuery();
	const catalog = api.observability.catalog.useQuery(
		{ serviceId },
		{ enabled: state.data?.enabled === true },
	);
	const rules = api.observability.rules.useQuery(
		{ serviceId },
		{ enabled: state.data?.enabled === true },
	);
	const history = api.observability.history.useQuery(
		{ serviceId },
		{ enabled: state.data?.enabled === true },
	);
	const alertStates = api.observability.alertStates.useQuery(
		{ serviceId },
		{
			enabled:
				state.data?.status === "ready" || state.data?.status === "degraded",
			refetchInterval: 15_000,
			retry: false,
		},
	);
	const destinations = api.observability.destinations.useQuery(undefined, {
		enabled: state.data?.enabled === true,
	});
	const currentValue = api.observability.currentValue.useQuery(
		{
			serviceId,
			metricKey: draft.metricKey,
			lookbackWindow: draft.lookbackWindow,
		},
		{
			enabled:
				state.data?.enabled === true &&
				databaseMonitoringEnabled &&
				Boolean(draft.metricKey),
			retry: false,
		},
	);
	const exporterHealth = api.observability.currentValue.useQuery(
		{
			serviceId,
			metricKey: `${databaseType}.up`,
			lookbackWindow: "1m",
		},
		{
			enabled:
				databaseMonitoringEnabled &&
				(state.data?.status === "ready" || state.data?.status === "degraded"),
			refetchInterval: 15_000,
			retry: false,
		},
	);

	useEffect(() => {
		if (typeof window !== "undefined" && !publicUrl) {
			setPublicUrl(window.location.origin);
		}
	}, [publicUrl]);

	useEffect(() => {
		setDatabaseMonitoringEnabled(monitoringEnabled);
	}, [monitoringEnabled]);

	const invalidate = async () => {
		await Promise.all([
			utils.observability.state.invalidate(),
			utils.observability.rules.invalidate({ serviceId }),
			utils.observability.history.invalidate({ serviceId }),
			utils.observability.alertStates.invalidate({ serviceId }),
		]);
	};

	const install = api.observability.install.useMutation({
		onSuccess: async () => {
			toast.success("Managed database monitoring installed");
			await invalidate();
		},
		onError: (error) => toast.error(error.message),
	});
	const reconcile = api.observability.reconcile.useMutation({
		onSuccess: async () => {
			toast.success("Observability reconciliation completed");
			await invalidate();
		},
		onError: (error) => toast.error(error.message),
	});
	const disableStack = api.observability.disable.useMutation({
		onSuccess: async () => {
			toast.success("Observability collection stopped; data volumes retained");
			await invalidate();
		},
		onError: (error) => toast.error(error.message),
	});
	const toggleDatabase = api.observability.setDatabaseEnabled.useMutation({
		onMutate: ({ enabled }) => {
			const previous = databaseMonitoringEnabled;
			setDatabaseMonitoringEnabled(enabled);
			return { previous };
		},
		onSuccess: async () => {
			toast.success("Database monitoring updated");
			await invalidate();
		},
		onError: (error, _variables, context) => {
			if (context) setDatabaseMonitoringEnabled(context.previous);
			toast.error(error.message);
		},
	});
	const createRule = api.observability.createRule.useMutation({
		onSuccess: async () => {
			toast.success("Alert rule saved");
			setAlertBuilderOpen(false);
			setDraft(emptyDraft);
			setEditingRuleId(null);
			await invalidate();
		},
		onError: (error) => toast.error(error.message),
	});
	const updateRule = api.observability.updateRule.useMutation({
		onSuccess: async () => {
			toast.success("Alert rule updated");
			setAlertBuilderOpen(false);
			setDraft(emptyDraft);
			setEditingRuleId(null);
			await invalidate();
		},
		onError: (error) => toast.error(error.message),
	});
	const removeRule = api.observability.removeRule.useMutation({
		onSuccess: async () => {
			toast.success("Alert rule removed");
			await invalidate();
		},
		onError: (error) => toast.error(error.message),
	});
	const exportArtifacts = api.observability.exportArtifacts.useQuery(
		{ serviceId },
		{ enabled: false },
	);

	const selectedMetric = useMemo(
		() =>
			catalog.data?.metrics.find((metric) => metric.key === draft.metricKey),
		[catalog.data?.metrics, draft.metricKey],
	);
	const alertNameError = getAlertNameError(draft.name, databaseType);

	const handleAlertBuilderOpenChange = (open: boolean) => {
		setAlertBuilderOpen(open);
		if (!open) {
			setEditingRuleId(null);
			setDraft(emptyDraft);
		}
	};

	const openCreateAlertBuilder = () => {
		setEditingRuleId(null);
		setDraft(emptyDraft);
		setAlertBuilderOpen(true);
	};

	const applyPreset = (
		preset: NonNullable<typeof catalog.data>["presets"][number],
	) => {
		setEditingRuleId(null);
		setDraft({
			metricKey: preset.metricKey,
			operator: preset.operator,
			threshold: String(preset.threshold),
			lookbackWindow: preset.lookbackWindow,
			forDuration: preset.forDuration,
			severity: preset.severity,
			name: preset.name,
			description: preset.description,
			notificationIds: [],
			enabled: preset.enabled,
		});
	};

	const submitRule = () => {
		const threshold = Number(draft.threshold);
		if (!draft.metricKey || !Number.isFinite(threshold)) {
			toast.error("Choose a metric and enter a valid threshold");
			return;
		}
		if (alertNameError) {
			toast.error(alertNameError);
			return;
		}
		const rule = {
			serviceId,
			metricKey: draft.metricKey,
			operator: draft.operator,
			threshold,
			lookbackWindow: draft.lookbackWindow,
			forDuration: draft.forDuration,
			severity: draft.severity,
			name: draft.name,
			description: draft.description,
			notificationIds: draft.notificationIds,
			enabled: draft.enabled,
		};
		if (editingRuleId) {
			updateRule.mutate({ ruleId: editingRuleId, rule });
		} else {
			createRule.mutate(rule);
		}
	};

	if (state.isLoading) {
		return (
			<div className="flex min-h-52 items-center justify-center">
				<Loader2 className="size-5 animate-spin text-muted-foreground" />
			</div>
		);
	}

	if (!state.data?.enabled) {
		return (
			<div className="grid gap-4">
				<Card>
					<CardHeader>
						<CardTitle>Managed database monitoring</CardTitle>
					</CardHeader>
					<CardContent className="space-y-4">
						<p className="max-w-3xl text-sm text-muted-foreground">
							Install the self-hosted Prometheus, Alertmanager, and Grafana
							stack. Existing PostgreSQL and Redis databases become eligible,
							but collection only starts after this explicit installation.
						</p>
						{canCreate && canManageStack ? (
							<div className="flex max-w-2xl flex-col gap-2 sm:flex-row">
								<Input
									value={publicUrl}
									onChange={(event) => setPublicUrl(event.target.value)}
									placeholder="https://dokploy.example.com"
								/>
								<Button
									onClick={() => install.mutate({ publicUrl })}
									disabled={install.isPending || !publicUrl}
								>
									{install.isPending && (
										<Loader2 className="mr-2 size-4 animate-spin" />
									)}
									Install monitoring
								</Button>
							</div>
						) : (
							<p className="text-sm text-muted-foreground">
								Ask an organization owner or admin to install the stack.
							</p>
						)}
						{state.data?.lastError && (
							<p className="text-sm text-destructive">{state.data.lastError}</p>
						)}
					</CardContent>
				</Card>
				<Card>
					<CardHeader>
						<CardTitle>Resources</CardTitle>
					</CardHeader>
					<CardContent>{resources}</CardContent>
				</Card>
			</div>
		);
	}

	const dashboardUid =
		databaseType === "postgres" ? "dokploy-postgres" : "dokploy-redis";
	const dashboardUrl = `/api/observability/grafana/d/${dashboardUid}/dokploy-${databaseType}?orgId=1&kiosk&var-service_id=${encodeURIComponent(serviceId)}&var-DS_DOKPLOY_DATABASE=${encodeURIComponent(datasourceUid(serviceId))}`;
	const liveAlerts = Array.isArray(alertStates.data)
		? alertStates.data.length
		: 0;
	const exporterValue = firstMetricValue(exporterHealth.data?.result);
	const exporterStatus = exporterHealth.isError
		? "error"
		: exporterHealth.isFetching && exporterValue === null
			? "waiting"
			: exporterValue === "1"
				? "healthy"
				: exporterValue === null
					? "no data"
					: "unreachable";

	return (
		<div className="space-y-4">
			<Card>
				<CardContent className="flex flex-col gap-4 pt-6 lg:flex-row lg:items-center lg:justify-between">
					<div className="flex flex-wrap items-center gap-2">
						<Badge
							variant={
								state.data.status === "ready" ? "default" : "destructive"
							}
						>
							Stack: {state.data.status}
						</Badge>
						<Badge
							variant={databaseMonitoringEnabled ? "default" : "secondary"}
						>
							Database: {databaseMonitoringEnabled ? "enrolled" : "opted out"}
						</Badge>
						<Badge variant={liveAlerts > 0 ? "destructive" : "outline"}>
							{liveAlerts} active alert{liveAlerts === 1 ? "" : "s"}
						</Badge>
					</div>
					<div className="flex flex-wrap items-center gap-3">
						{canUpdate && (
							<div className="flex items-center gap-2">
								<Switch
									checked={databaseMonitoringEnabled}
									onCheckedChange={(enabled) =>
										toggleDatabase.mutate({ serviceId, enabled })
									}
									disabled={toggleDatabase.isPending}
								/>
								<Label>Collect metrics</Label>
							</div>
						)}
						{canUpdate && canManageStack && (
							<Button
								variant="outline"
								size="sm"
								onClick={() => reconcile.mutate()}
								disabled={reconcile.isPending}
							>
								<RefreshCw
									className={`mr-2 size-4 ${reconcile.isPending ? "animate-spin" : ""}`}
								/>
								Reconcile
							</Button>
						)}
						<Button
							variant="outline"
							size="sm"
							onClick={async () => {
								const result = await exportArtifacts.refetch();
								if (result.data) downloadBase64(result.data);
							}}
							disabled={exportArtifacts.isFetching}
						>
							<Download className="mr-2 size-4" />
							Export
						</Button>
						{canDelete && canManageStack && (
							<Button
								variant="destructive"
								size="sm"
								onClick={() => disableStack.mutate()}
								disabled={disableStack.isPending}
							>
								Disable stack
							</Button>
						)}
					</div>
				</CardContent>
			</Card>

			<Tabs defaultValue="dashboard" className="w-full">
				<TabsList className="h-auto flex-wrap">
					<TabsTrigger value="dashboard">Dashboard</TabsTrigger>
					<TabsTrigger value="alerts">Alerts</TabsTrigger>
					<TabsTrigger value="history">Alert history</TabsTrigger>
					<TabsTrigger value="resources">Resources</TabsTrigger>
				</TabsList>

				<TabsContent value="dashboard" className="space-y-4 pt-2">
					{!databaseMonitoringEnabled ? (
						<div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
							Metric collection is disabled for this database. Historical data
							is retained.
						</div>
					) : (
						<>
							<div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
								<div className="rounded-lg border p-3 text-sm">
									<div className="flex items-center justify-between">
										<span>
											{databaseType === "postgres"
												? "postgres_exporter"
												: "redis_exporter"}
										</span>
										<Badge
											variant={
												exporterStatus === "healthy"
													? "outline"
													: exporterStatus === "waiting" ||
															exporterStatus === "no data"
														? "secondary"
														: "destructive"
											}
										>
											{exporterStatus}
										</Badge>
									</div>
									<p className="mt-2 text-xs text-muted-foreground">
										Last minute availability from Prometheus.
									</p>
								</div>
								{state.data.agents.map((agent) => (
									<div
										key={agent.observabilityAgentId}
										className="rounded-lg border p-3 text-sm"
									>
										<div className="flex items-center justify-between">
											<span>{agent.server?.name ?? "Dokploy server"}</span>
											<Badge
												variant={
													agent.status === "healthy" ? "outline" : "destructive"
												}
											>
												{agent.status}
											</Badge>
										</div>
										{agent.lastSeenAt && (
											<p className="mt-2 text-xs text-muted-foreground">
												Last Remote Write:{" "}
												{new Date(agent.lastSeenAt).toLocaleString()}
											</p>
										)}
										{agent.lastError && (
											<p className="mt-2 text-xs text-destructive">
												{agent.lastError}
											</p>
										)}
									</div>
								))}
							</div>
							<iframe
								src={dashboardUrl}
								title={`${databaseType} Grafana dashboard`}
								className="h-[760px] w-full rounded-lg border bg-background"
							/>
						</>
					)}
				</TabsContent>

				<TabsContent value="alerts" className="space-y-4 pt-2">
					{Array.isArray(alertStates.data) && alertStates.data.length > 0 && (
						<Card>
							<CardHeader>
								<CardTitle className="text-base">Live alert states</CardTitle>
							</CardHeader>
							<CardContent className="space-y-2">
								{alertStates.data.map((item) => {
									const labels = (
										item as {
											metric?: Record<string, string>;
										}
									).metric;
									const alertState = labels?.alertstate ?? "unknown";
									return (
										<div
											key={JSON.stringify(labels ?? item)}
											className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
										>
											<span>
												{labels?.alertname ?? labels?.rule_id ?? "Alert"}
											</span>
											<Badge
												variant={
													alertState === "firing"
														? "destructive"
														: alertState === "pending"
															? "secondary"
															: "outline"
												}
											>
												{alertState}
											</Badge>
										</div>
									);
								})}
							</CardContent>
						</Card>
					)}
					<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
						<div>
							<h3 className="font-medium">Alert rules</h3>
							<p className="text-sm text-muted-foreground">
								Create and manage catalog-backed alerts for this database.
							</p>
						</div>
						{canCreate && (
							<Button
								onClick={openCreateAlertBuilder}
								disabled={!databaseMonitoringEnabled}
							>
								<Plus className="mr-2 size-4" />
								Create alert
							</Button>
						)}
					</div>

					<Dialog
						open={alertBuilderOpen}
						onOpenChange={handleAlertBuilderOpenChange}
					>
						<DialogContent className="sm:max-w-5xl">
							<DialogHeader>
								<DialogTitle>
									{editingRuleId ? "Edit alert" : "Create alert"}
								</DialogTitle>
								<DialogDescription>
									{editingRuleId
										? "Update the alert condition and notification destinations."
										: "Build an alert from the managed metric catalog."}
								</DialogDescription>
							</DialogHeader>
							<div className="space-y-5">
								{!editingRuleId && (
									<div className="space-y-2">
										<Label>Start from a preset</Label>
										<div className="flex flex-wrap gap-2">
											{catalog.data?.presets.map((preset) => (
												<Button
													key={preset.presetKey}
													variant="outline"
													size="sm"
													onClick={() => applyPreset(preset)}
												>
													{preset.name}
												</Button>
											))}
										</div>
									</div>
								)}
								<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
									<div className="space-y-2">
										<Label>Metric</Label>
										<Select
											value={draft.metricKey}
											onValueChange={(metricKey) => {
												const metric = catalog.data?.metrics.find(
													(item) => item.key === metricKey,
												);
												setDraft((current) => ({
													...current,
													metricKey,
													operator: metric?.operators[0] ?? "gt",
													lookbackWindow: metric?.defaultLookback ?? "5m",
												}));
											}}
										>
											<SelectTrigger>
												<SelectValue placeholder="Choose a metric" />
											</SelectTrigger>
											<SelectContent>
												{catalog.data?.metrics.map((metric) => (
													<SelectItem key={metric.key} value={metric.key}>
														{metric.label} ({metric.unit})
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									</div>
									<div className="space-y-2">
										<Label>Operator</Label>
										<Select
											value={draft.operator}
											onValueChange={(operator) =>
												setDraft((current) => ({
													...current,
													operator: operator as Operator,
												}))
											}
										>
											<SelectTrigger>
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												{selectedMetric?.operators.map((operator) => (
													<SelectItem key={operator} value={operator}>
														{operator}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									</div>
									<div className="space-y-2">
										<Label>Threshold</Label>
										<Input
											type="number"
											value={draft.threshold}
											onChange={(event) =>
												setDraft((current) => ({
													...current,
													threshold: event.target.value,
												}))
											}
										/>
									</div>
									<div className="space-y-2">
										<Label>Current value</Label>
										<div className="flex h-9 items-center rounded-md border px-3 text-sm">
											{currentValue.isFetching
												? "Loading…"
												: (firstMetricValue(currentValue.data?.result) ??
													"No data")}
										</div>
									</div>
									<div className="space-y-2">
										<Label>Lookback</Label>
										<Input
											value={draft.lookbackWindow}
											onChange={(event) =>
												setDraft((current) => ({
													...current,
													lookbackWindow: event.target.value,
												}))
											}
										/>
									</div>
									<div className="space-y-2">
										<Label>For duration</Label>
										<Input
											value={draft.forDuration}
											onChange={(event) =>
												setDraft((current) => ({
													...current,
													forDuration: event.target.value,
												}))
											}
										/>
									</div>
									<div className="space-y-2">
										<Label>Severity</Label>
										<Select
											value={draft.severity}
											onValueChange={(severity) =>
												setDraft((current) => ({
													...current,
													severity: severity as Severity,
												}))
											}
										>
											<SelectTrigger>
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												<SelectItem value="info">Info</SelectItem>
												<SelectItem value="warning">Warning</SelectItem>
												<SelectItem value="critical">Critical</SelectItem>
											</SelectContent>
										</Select>
									</div>
									<div className="flex items-end gap-2 pb-2">
										<Switch
											checked={draft.enabled}
											onCheckedChange={(enabled) =>
												setDraft((current) => ({ ...current, enabled }))
											}
										/>
										<Label>Enabled</Label>
									</div>
								</div>
								<div className="grid gap-4 md:grid-cols-2">
									<div className="space-y-2">
										<Label>Name</Label>
										<Input
											value={draft.name}
											onChange={(event) =>
												setDraft((current) => ({
													...current,
													name: event.target.value,
												}))
											}
											placeholder={`alert-${databaseType}-apps-prd-memory-critical-gt-90`}
											maxLength={120}
											autoCapitalize="none"
											spellCheck={false}
											aria-invalid={Boolean(draft.name && alertNameError)}
										/>
										<p
											className={
												draft.name && alertNameError
													? "text-xs text-destructive"
													: "text-xs text-muted-foreground"
											}
										>
											{draft.name && alertNameError
												? alertNameError
												: `Required format: alert-${databaseType}-<scope>-<metric>-<severity>-<operator>-<threshold>.`}
										</p>
									</div>
									<div className="space-y-2">
										<Label>Description</Label>
										<Textarea
											value={draft.description}
											onChange={(event) =>
												setDraft((current) => ({
													...current,
													description: event.target.value,
												}))
											}
										/>
									</div>
								</div>
								<div className="space-y-2">
									<Label>Notification destinations</Label>
									<div className="flex flex-wrap gap-3">
										{destinations.data?.map((destination) => {
											const checkboxId = `monitoring-destination-${destination.notificationId}`;
											return (
												<label
													key={destination.notificationId}
													htmlFor={checkboxId}
													className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
												>
													<Checkbox
														id={checkboxId}
														checked={draft.notificationIds.includes(
															destination.notificationId,
														)}
														onCheckedChange={(checked) =>
															setDraft((current) => ({
																...current,
																notificationIds: checked
																	? [
																			...current.notificationIds,
																			destination.notificationId,
																		]
																	: current.notificationIds.filter(
																			(id) => id !== destination.notificationId,
																		),
															}))
														}
													/>
													{destination.name} ({destination.notificationType})
												</label>
											);
										})}
									</div>
								</div>
							</div>
							<DialogFooter>
								<Button
									variant="outline"
									onClick={() => handleAlertBuilderOpenChange(false)}
									disabled={createRule.isPending || updateRule.isPending}
								>
									Cancel
								</Button>
								<Button
									onClick={submitRule}
									disabled={
										createRule.isPending ||
										updateRule.isPending ||
										!databaseMonitoringEnabled
									}
								>
									{(createRule.isPending || updateRule.isPending) && (
										<Loader2 className="mr-2 size-4 animate-spin" />
									)}
									{editingRuleId ? "Update alert" : "Create alert"}
								</Button>
							</DialogFooter>
						</DialogContent>
					</Dialog>

					<div className="space-y-3">
						{rules.data?.map((rule) => (
							<div
								key={rule.databaseAlertRuleId}
								className="flex flex-col gap-3 rounded-lg border p-4 md:flex-row md:items-center md:justify-between"
							>
								<div>
									<div className="flex flex-wrap items-center gap-2">
										<p className="font-medium">{rule.name}</p>
										<Badge variant="outline">{rule.severity}</Badge>
										<Badge
											variant={
												rule.syncStatus === "error"
													? "destructive"
													: "secondary"
											}
										>
											{rule.syncStatus}
										</Badge>
										{!rule.enabled && (
											<Badge variant="secondary">disabled</Badge>
										)}
									</div>
									<p className="mt-1 text-sm text-muted-foreground">
										{rule.metricKey} {rule.operator} {rule.threshold} for{" "}
										{rule.forDuration}
									</p>
									{rule.syncError && (
										<p className="mt-1 text-xs text-destructive">
											{rule.syncError}
										</p>
									)}
								</div>
								<div className="flex items-center gap-1">
									{canUpdate && (
										<Button
											variant="ghost"
											size="icon"
											aria-label={`Edit ${rule.name}`}
											onClick={() => {
												setEditingRuleId(rule.databaseAlertRuleId);
												setDraft({
													metricKey: rule.metricKey,
													operator: rule.operator,
													threshold: String(rule.threshold),
													lookbackWindow: rule.lookbackWindow,
													forDuration: rule.forDuration,
													severity: rule.severity,
													name: rule.name,
													description: rule.description,
													notificationIds: rule.destinations.map(
														(destination) => destination.notificationId,
													),
													enabled: rule.enabled,
												});
												setAlertBuilderOpen(true);
											}}
										>
											<Pencil className="size-4" />
										</Button>
									)}
									{canDelete && (
										<Button
											variant="ghost"
											size="icon"
											aria-label={`Delete ${rule.name}`}
											onClick={() =>
												removeRule.mutate({
													ruleId: rule.databaseAlertRuleId,
												})
											}
											disabled={removeRule.isPending}
										>
											<Trash2 className="size-4" />
										</Button>
									)}
								</div>
							</div>
						))}
						{rules.data?.length === 0 && (
							<div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
								No alert rules yet.
							</div>
						)}
					</div>
				</TabsContent>

				<TabsContent value="history" className="space-y-3 pt-2">
					{history.data?.map((event) => (
						<div
							key={event.databaseAlertEventId}
							className="rounded-lg border p-4"
						>
							<div className="flex flex-wrap items-center gap-2">
								<Badge
									variant={
										event.status === "resolved" ? "outline" : "destructive"
									}
								>
									{event.status}
								</Badge>
								<p className="font-medium">
									{event.rule?.name ?? "Deleted alert rule"}
								</p>
								<span className="text-xs text-muted-foreground">
									{new Date(event.createdAt).toLocaleString()}
								</span>
							</div>
							<p className="mt-2 text-sm text-muted-foreground">
								{event.deliveries.length} delivery attempt
								{event.deliveries.length === 1 ? "" : "s"} ·{" "}
								{
									event.deliveries.filter(
										(delivery) => delivery.status === "sent",
									).length
								}{" "}
								sent
							</p>
						</div>
					))}
					{history.data?.length === 0 && (
						<div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
							No firing or resolved transitions in the last 30 days.
						</div>
					)}
				</TabsContent>

				<TabsContent value="resources" className="pt-2">
					<div className="rounded-lg border p-6">{resources}</div>
				</TabsContent>
			</Tabs>
		</div>
	);
}
