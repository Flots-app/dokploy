import type { ComposePreviewSettings } from "@dokploy/server/utils/docker/compose-preview";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
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
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { api, type RouterOutputs } from "@/utils/api";

export function ShowComposePreviews({ composeId }: { composeId: string }) {
	const { data: source } = api.compose.one.useQuery({ composeId });
	const { data: permissions } = api.user.getPermissions.useQuery();
	const { data: previews, error } = api.composePreview.all.useQuery(
		{ composeId },
		{ refetchInterval: 5000 },
	);
	const utils = api.useUtils();
	const [prNumber, setPrNumber] = useState("");
	const refresh = async () => {
		await utils.composePreview.all.invalidate({ composeId });
	};
	const deploy = api.composePreview.deploy.useMutation({
		onSuccess: async () => {
			await refresh();
			toast.success("Preview queued");
		},
		onError: (error) => toast.error(error.message),
	});
	const remove = api.composePreview.remove.useMutation({
		onSuccess: async () => {
			await refresh();
			toast.success("Preview cleanup queued");
		},
		onError: (error) => toast.error(error.message),
	});
	if (source?.previewParentId)
		return (
			<p>This environment is managed from its source Compose preview tab.</p>
		);
	return (
		<div className="space-y-6">
			{permissions?.envVars.read && (
				<ComposePreviewSettingsForm
					composeId={composeId}
					canEdit={!!(permissions.service.create && permissions.envVars.write)}
				/>
			)}
			<Card>
				<CardHeader>
					<CardTitle>Pull request environments</CardTitle>
					<CardDescription>
						Each PR has its own services, volumes and URLs. Closing the PR or
						reaching its lifetime removes the environment and its volumes.
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-4">
					{permissions?.deployment.create && (
						<form
							className="flex items-end gap-3"
							onSubmit={(event) => {
								event.preventDefault();
								deploy.mutate({
									composeId,
									pullRequestNumber: Number(prNumber),
								});
							}}
						>
							<div className="space-y-2">
								<Label htmlFor="preview-pr">PR number</Label>
								<Input
									id="preview-pr"
									type="number"
									min={1}
									required
									value={prNumber}
									onChange={(event) => setPrNumber(event.target.value)}
									placeholder="123"
								/>
							</div>
							<Button
								disabled={deploy.isPending || !source?.previewSettings?.enabled}
							>
								Deploy / resume
							</Button>
						</form>
					)}
					{error && (
						<p role="alert" className="text-destructive">
							{error.message}
						</p>
					)}
					{previews?.length === 0 && (
						<p className="text-sm text-muted-foreground">
							No preview environments yet. Open a PR against the configured base
							branch, or enter an existing PR above.
						</p>
					)}
					{previews?.map((preview) => (
						<div
							key={preview.previewId}
							className="space-y-3 rounded-lg border p-4"
						>
							<div className="flex flex-wrap items-center justify-between gap-3">
								<div className="flex items-center gap-3">
									<a
										href={preview.url || undefined}
										target="_blank"
										rel="noreferrer"
										className="font-medium"
									>
										PR #{preview.pullRequestNumber}
									</a>
									<Badge
										variant={
											preview.status === "error" ? "destructive" : "secondary"
										}
									>
										{preview.status}
									</Badge>
									<span className="text-sm text-muted-foreground">
										{preview.branch}
									</span>
								</div>
								<span className="text-sm text-muted-foreground">
									{preview.server?.name}
								</span>
							</div>
							{preview.error && (
								<p role="alert" className="text-sm text-destructive">
									{preview.error}
								</p>
							)}
							<div className="flex flex-wrap gap-4 text-sm">
								{preview.instance?.domains.map((domain) => (
									<a
										key={domain.domainId}
										href={`${domain.https ? "https" : "http"}://${domain.host}${domain.path || "/"}`}
										target="_blank"
										rel="noreferrer"
										className="text-primary underline"
									>
										{domain.serviceName}
									</a>
								))}
							</div>
							<div className="flex flex-wrap items-center gap-3">
								{preview.instance && (
									<Button asChild size="sm" variant="outline">
										<Link
											href={`/dashboard/project/${source?.environment.projectId}/environment/${preview.instance.environmentId}/services/compose/${preview.instance.composeId}?tab=deployments`}
										>
											Logs and services
										</Link>
									</Button>
								)}
								{permissions?.deployment.create && (
									<Button
										size="sm"
										variant="outline"
										disabled={deploy.isPending}
										onClick={() =>
											deploy.mutate({
												composeId,
												pullRequestNumber: preview.pullRequestNumber,
											})
										}
									>
										Redeploy
									</Button>
								)}
								{permissions?.service.delete && preview.status !== "closed" && (
									<Button
										size="sm"
										variant="destructive"
										disabled={remove.isPending}
										onClick={() =>
											remove.mutate({ previewId: preview.previewId })
										}
									>
										Remove environment and volumes
									</Button>
								)}
								{preview.expiresAt && (
									<span className="text-xs text-muted-foreground">
										Expires{" "}
										{new Date(preview.expiresAt).toLocaleString("en-GB", {
											timeZone: "UTC",
										})}{" "}
										UTC
									</span>
								)}
							</div>
						</div>
					))}
				</CardContent>
			</Card>
		</div>
	);
}

function ComposePreviewSettingsForm({
	composeId,
	canEdit,
}: {
	composeId: string;
	canEdit: boolean;
}) {
	const { data: source } = api.compose.one.useQuery({ composeId });
	const { data } = api.composePreview.settings.useQuery({ composeId });
	if (!data || !source) return <p>Loading preview settings...</p>;
	return (
		<LoadedPreviewSettings
			key={composeId}
			composeId={composeId}
			canEdit={canEdit}
			initial={data}
			composePath={source.composePath}
		/>
	);
}

function LoadedPreviewSettings({
	composeId,
	canEdit,
	initial,
	composePath,
}: {
	composeId: string;
	canEdit: boolean;
	initial: RouterOutputs["composePreview"]["settings"];
	composePath: string;
}) {
	const { data: workers } = api.server.all.useQuery();
	const { data: registries } = api.registry.all.useQuery();
	const utils = api.useUtils();
	const [settings, setSettings] = useState<ComposePreviewSettings>(
		initial.settings || {
			enabled: false,
			serverId: "",
			registryId: "",
			baseBranch: "main",
			composePath,
			limit: 3,
			ttlHours: 72,
			domain: "",
			https: true,
			certificateType: "letsencrypt",
			labels: [],
			cpuLimit: 2,
			memoryLimitMb: 1024,
		},
	);
	const [env, setEnv] = useState(initial.env);
	const [composeFile, setComposeFile] = useState(initial.composeFile);

	const mutation = api.composePreview.updateSettings.useMutation({
		onSuccess: async () => {
			await Promise.all([
				utils.composePreview.settings.invalidate({ composeId }),
				utils.compose.one.invalidate({ composeId }),
				utils.composePreview.all.invalidate({ composeId }),
			]);
			toast.success("Preview settings saved");
		},
		onError: (error) => toast.error(error.message),
	});
	const set = <K extends keyof ComposePreviewSettings>(
		key: K,
		value: ComposePreviewSettings[K],
	) => setSettings((previous) => ({ ...previous, [key]: value }));
	return (
		<Card>
			<CardHeader>
				<CardTitle>Compose preview settings</CardTitle>
				<CardDescription>
					Deploy trusted, non-draft GitHub PRs from the same repository. The
					source service keeps its current branch. Each preview builds on its
					selected Swarm worker and runs as an isolated stack.
				</CardDescription>
			</CardHeader>
			<CardContent>
				<form
					className="space-y-6"
					onSubmit={(event) => {
						event.preventDefault();
						mutation.mutate({ composeId, settings, env, composeFile });
					}}
				>
					<fieldset
						disabled={!canEdit || mutation.isPending}
						className="space-y-6"
					>
						<div className="flex items-center gap-3">
							<Switch
								id="previews-enabled"
								checked={settings.enabled}
								onCheckedChange={(value) => set("enabled", value)}
							/>
							<Label htmlFor="previews-enabled">Enable PR environments</Label>
						</div>
						<div className="grid gap-4 md:grid-cols-2">
							<div className="space-y-2">
								<Label htmlFor="preview-worker">Deployment worker</Label>
								<select
									id="preview-worker"
									className="h-10 w-full rounded-md border bg-background px-3"
									required
									value={settings.serverId}
									onChange={(event) => set("serverId", event.target.value)}
								>
									<option value="">Select a worker</option>
									{workers
										?.filter(
											(worker) =>
												worker.serverType === "deploy" &&
												worker.serverStatus === "active" &&
												!!worker.swarmNodeId,
										)
										.map((worker) => (
											<option key={worker.serverId} value={worker.serverId}>
												{worker.name}
												{worker.previewOnly ? " · previews only" : ""} ·
												capacity {worker.previewCapacity}
											</option>
										))}
								</select>
							</div>
							<div className="space-y-2">
								<Label htmlFor="preview-registry">Image registry</Label>
								<select
									id="preview-registry"
									required
									className="h-10 w-full rounded-md border bg-background px-3"
									value={settings.registryId}
									onChange={(event) => set("registryId", event.target.value)}
								>
									<option value="">Select a registry</option>
									{registries?.map((registry) => (
										<option
											key={registry.registryId}
											value={registry.registryId}
										>
											{registry.registryName}
										</option>
									))}
								</select>
							</div>
							{(
								[
									["baseBranch", "PR base branch"],
									["composePath", "Compose path in repository"],
									["domain", "Preview domain (wildcard DNS)"],
								] as const
							).map(([key, label]) => (
								<div key={key} className="space-y-2">
									<Label htmlFor={`preview-${key}`}>{label}</Label>
									<Input
										id={`preview-${key}`}
										required
										value={settings[key]}
										onChange={(event) => set(key, event.target.value)}
									/>
								</div>
							))}
							{(
								[
									["limit", "Maximum previews for this app", 1, 50],
									["ttlHours", "Lifetime (hours)", 1, 720],
									["cpuLimit", "CPU limit per service", 0.1, 64],
									[
										"memoryLimitMb",
										"Memory limit per service (MiB)",
										64,
										65536,
									],
								] as const
							).map(([key, label, min, max]) => (
								<div key={key} className="space-y-2">
									<Label htmlFor={`preview-${key}`}>{label}</Label>
									<Input
										id={`preview-${key}`}
										type="number"
										required
										min={min}
										max={max}
										step={key === "cpuLimit" ? 0.1 : 1}
										value={settings[key]}
										onChange={(event) => set(key, Number(event.target.value))}
									/>
								</div>
							))}
						</div>
						<div className="flex items-center gap-3">
							<Switch
								id="preview-https"
								checked={settings.https}
								onCheckedChange={(value) => set("https", value)}
							/>
							<Label htmlFor="preview-https">HTTPS URLs</Label>
						</div>
						<div className="space-y-2">
							<Label htmlFor="preview-certificate">
								Certificate management
							</Label>
							<select
								id="preview-certificate"
								className="h-10 w-full rounded-md border bg-background px-3"
								value={settings.certificateType}
								onChange={(event) =>
									set(
										"certificateType",
										event.target.value as "none" | "letsencrypt",
									)
								}
							>
								<option value="letsencrypt">
									Let's Encrypt on the manager
								</option>
								<option value="none">
									Existing certificate / upstream proxy
								</option>
							</select>
						</div>
						<div className="space-y-2">
							<Label htmlFor="preview-labels">
								Required PR labels (any match, comma separated)
							</Label>
							<Input
								id="preview-labels"
								value={settings.labels.join(",")}
								onChange={(event) =>
									set(
										"labels",
										event.target.value
											.split(",")
											.map((label) => label.trim())
											.filter(Boolean),
									)
								}
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="preview-env">Preview environment variables</Label>
							<Textarea
								id="preview-env"
								className="min-h-40 font-mono"
								value={env}
								onChange={(event) => setEnv(event.target.value)}
							/>
							<p className="text-sm text-muted-foreground">
								Variables are explicit and do not inherit staging or project
								values. Use {"${{DOKPLOY_PR_NUMBER}}"},{" "}
								{"${{DOKPLOY_PREVIEW_PASSWORD}}"} and{" "}
								{"${{DOKPLOY_PREVIEW_SERVICE_NAME_URL}}"} (service name in
								uppercase, hyphens replaced with underscores). For services with
								multiple ports, use{" "}
								{"${{DOKPLOY_PREVIEW_SERVICE_NAME_8080_URL}}"} or{" "}
								{"${{DOKPLOY_PREVIEW_SERVICE_NAME_1234_WS_URL}}"}.
							</p>
						</div>
						<div className="space-y-2">
							<Label htmlFor="preview-file">
								Preview Compose file override (optional)
							</Label>
							<Textarea
								id="preview-file"
								className="min-h-48 font-mono"
								value={composeFile}
								onChange={(event) => setComposeFile(event.target.value)}
							/>
							<p className="text-sm text-muted-foreground">
								Leave empty to use the repository file. Include preview
								databases here when staging uses external databases. Host ports
								and container names are replaced; external volumes and
								privileged services and bind mounts are rejected. Use named
								volumes and bake repository files into images.
							</p>
						</div>
						{canEdit && <Button type="submit">Save settings</Button>}
					</fieldset>
				</form>
			</CardContent>
		</Card>
	);
}

export function ComposePreviewsTrigger({
	sourceType,
}: {
	sourceType?: string;
}) {
	return sourceType === "github" ? (
		<TabsTrigger value="previews">PR environments</TabsTrigger>
	) : null;
}
