import type { ComposePreviewSettings } from "@dokploy/server/utils/docker/compose-preview";
import copy from "copy-to-clipboard";
import {
	AlertTriangle,
	Copy,
	ExternalLink,
	EyeIcon,
	EyeOffIcon,
	GitPullRequest,
	Loader2,
} from "lucide-react";
import Link from "next/link";
import { type CSSProperties, useState } from "react";
import { toast } from "sonner";
import { CodeEditor } from "@/components/shared/code-editor";
import { DialogAction } from "@/components/shared/dialog-action";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { TabsTrigger } from "@/components/ui/tabs";
import { Toggle } from "@/components/ui/toggle";
import { api, type RouterOutputs } from "@/utils/api";

export const COMPOSE_PREVIEW_DOCS_URL =
	"https://github.com/Flots-app/dokploy/blob/canary/ops/compose-preview/README.md";

type Preview = RouterOutputs["composePreview"]["all"][number];
type PreviewDomain = NonNullable<Preview["instance"]>["domains"][number];

/** Shared by the source page and the instance page so both link the same URL. */
export const previewDomainUrl = (domain: {
	https: boolean;
	host: string;
	path: string | null;
}) =>
	`${domain.https ? "https" : "http"}://${domain.host}${domain.path && domain.path !== "/" ? domain.path : ""}`;

/** Previews need a self-hosted GitHub Docker Compose source (see the router). */
export const supportsComposePreviews = (
	source?: { sourceType: string; composeType: string } | null,
	isCloud?: boolean,
) =>
	!!source &&
	!isCloud &&
	source.sourceType === "github" &&
	source.composeType === "docker-compose";

const STATUS: Record<
	Preview["status"],
	{
		label: string;
		variant: "default" | "secondary" | "destructive" | "outline";
		busy?: boolean;
	}
> = {
	pending: { label: "Queued", variant: "secondary", busy: true },
	deploying: { label: "Deploying", variant: "secondary", busy: true },
	ready: { label: "Ready", variant: "default" },
	removing: { label: "Removing", variant: "secondary", busy: true },
	closed: { label: "Removed", variant: "outline" },
	error: { label: "Failed", variant: "destructive" },
};

function PreviewStatus({ status }: { status: Preview["status"] }) {
	const entry = STATUS[status];
	return (
		<Badge variant={entry.variant} className="gap-1">
			{entry.busy && <Loader2 className="size-3 animate-spin" aria-hidden />}
			{entry.label}
		</Badge>
	);
}

function CopyUrl({ url }: { url: string }) {
	return (
		<Button
			type="button"
			size="icon"
			variant="ghost"
			className="size-7"
			aria-label={`Copy ${url}`}
			onClick={() => {
				copy(url);
				toast.success("URL copied");
			}}
		>
			<Copy className="size-3.5" />
		</Button>
	);
}

export function ShowComposePreviews({ composeId }: { composeId: string }) {
	const { data: source } = api.compose.one.useQuery({ composeId });
	const { data: isCloud } = api.settings.isCloud.useQuery();
	const { data: permissions } = api.user.getPermissions.useQuery();
	const supported = supportsComposePreviews(source, isCloud);
	const {
		data: previews,
		error,
		isLoading,
	} = api.composePreview.all.useQuery(
		{ composeId },
		{
			enabled: supported,
			// Poll fast while something is moving, slowly otherwise.
			refetchInterval: (query) =>
				query.state.data?.some((preview) => STATUS[preview.status].busy)
					? 3000
					: 15000,
		},
	);
	const utils = api.useUtils();
	const [prNumber, setPrNumber] = useState("");
	const refresh = () => utils.composePreview.all.invalidate({ composeId });
	const deploy = api.composePreview.deploy.useMutation({
		onSuccess: async (_, input) => {
			await refresh();
			toast.success(`PR #${input.pullRequestNumber} queued`);
		},
		onError: (error) => toast.error(error.message),
	});
	const remove = api.composePreview.remove.useMutation({
		onSuccess: async () => {
			await refresh();
			toast.success("Removal queued");
		},
		onError: (error) => toast.error(error.message),
	});
	if (source?.previewParentId)
		return (
			<p className="text-sm text-muted-foreground">
				This environment is managed from its source Compose PR environments tab.
			</p>
		);
	if (source && !supported)
		return (
			<Alert>
				<AlertTriangle className="size-4" />
				<AlertTitle>PR environments are not available here</AlertTitle>
				<AlertDescription>
					They need a self-hosted Dokploy and a Docker Compose service (not a
					stack) deployed from a GitHub App provider.
				</AlertDescription>
			</Alert>
		);
	const enabled = !!source?.previewSettings?.enabled;
	const repositoryUrl =
		source?.owner && source.repository
			? `https://github.com/${source.owner}/${source.repository}`
			: null;
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
						Each PR gets its own services, volumes and URLs, and a comment on
						the PR with its status and links. Closing or merging the PR, or
						reaching its lifetime, removes the environment and its volumes.
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-4">
					{permissions?.deployment.create && (
						<form
							className="flex flex-wrap items-end gap-3"
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
								type="submit"
								disabled={deploy.isPending || !enabled}
								isLoading={
									deploy.isPending &&
									deploy.variables?.pullRequestNumber === Number(prNumber)
								}
							>
								Deploy or resume
							</Button>
							{!enabled && (
								<p className="text-sm text-muted-foreground">
									Enable PR environments in the settings above first.
								</p>
							)}
						</form>
					)}
					{error && (
						<p role="alert" className="text-sm text-destructive">
							{error.message}
						</p>
					)}
					{isLoading && (
						<div className="flex items-center gap-2 text-sm text-muted-foreground">
							<Loader2 className="size-4 animate-spin" /> Loading environments…
						</div>
					)}
					{previews?.length === 0 && (
						<p className="text-sm text-muted-foreground">
							No PR environments yet. Open a PR against{" "}
							<code>
								{source?.previewSettings?.baseBranch || "the base branch"}
							</code>{" "}
							or enter an open PR number above.
						</p>
					)}
					{previews?.map((preview) => (
						<PreviewRow
							key={preview.previewId}
							preview={preview}
							projectId={source?.environment.projectId}
							prUrl={
								preview.url ||
								(repositoryUrl
									? `${repositoryUrl}/pull/${preview.pullRequestNumber}`
									: null)
							}
							canDeploy={!!permissions?.deployment.create && enabled}
							canRemove={!!permissions?.service.delete}
							deploying={
								deploy.isPending &&
								deploy.variables?.pullRequestNumber ===
									preview.pullRequestNumber
							}
							removing={
								remove.isPending &&
								remove.variables?.previewId === preview.previewId
							}
							onDeploy={() =>
								deploy.mutate({
									composeId,
									pullRequestNumber: preview.pullRequestNumber,
								})
							}
							onRemove={() => remove.mutate({ previewId: preview.previewId })}
						/>
					))}
				</CardContent>
			</Card>
		</div>
	);
}

function PreviewRow({
	preview,
	projectId,
	prUrl,
	canDeploy,
	canRemove,
	deploying,
	removing,
	onDeploy,
	onRemove,
}: {
	preview: Preview;
	projectId?: string;
	prUrl: string | null;
	canDeploy: boolean;
	canRemove: boolean;
	deploying: boolean;
	removing: boolean;
	onDeploy: () => void;
	onRemove: () => void;
}) {
	const active = preview.status !== "closed";
	return (
		<div className="space-y-3 rounded-lg border p-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="flex flex-wrap items-center gap-3">
					{prUrl ? (
						<a
							href={prUrl}
							target="_blank"
							rel="noreferrer"
							className="flex items-center gap-1 font-medium hover:underline"
						>
							<GitPullRequest className="size-4" />
							PR #{preview.pullRequestNumber}
						</a>
					) : (
						<span className="font-medium">PR #{preview.pullRequestNumber}</span>
					)}
					<PreviewStatus status={preview.status} />
					{preview.branch && (
						<code className="text-sm text-muted-foreground">
							{preview.branch}
						</code>
					)}
					{preview.deployedSha && (
						<code className="text-xs text-muted-foreground">
							{preview.deployedSha.slice(0, 7)}
						</code>
					)}
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
			{active && !!preview.instance?.domains.length && (
				<ul className="space-y-1 text-sm">
					{preview.instance.domains.map((domain: PreviewDomain) => {
						const url = previewDomainUrl(domain);
						return (
							<li key={domain.domainId} className="flex items-center gap-2">
								<span className="w-32 truncate text-muted-foreground">
									{domain.serviceName}
								</span>
								<a
									href={url}
									target="_blank"
									rel="noreferrer"
									className="flex min-w-0 items-center gap-1 truncate text-primary hover:underline"
								>
									<span className="truncate">{url}</span>
									<ExternalLink className="size-3 shrink-0" />
								</a>
								<CopyUrl url={url} />
							</li>
						);
					})}
				</ul>
			)}
			<div className="flex flex-wrap items-center gap-3">
				{preview.instance && projectId && (
					<Button asChild size="sm" variant="outline">
						<Link
							href={`/dashboard/project/${projectId}/environment/${preview.instance.environmentId}/services/compose/${preview.instance.composeId}`}
						>
							Logs and containers
						</Link>
					</Button>
				)}
				{canDeploy && (
					<Button
						size="sm"
						variant="outline"
						disabled={deploying}
						isLoading={deploying}
						onClick={onDeploy}
					>
						{active ? "Redeploy" : "Recreate"}
					</Button>
				)}
				{canRemove && active && preview.status !== "removing" && (
					<DialogAction
						type="destructive"
						title={`Remove PR #${preview.pullRequestNumber} environment?`}
						description="Its services, named volumes (databases included) and images are deleted permanently. Pushing to the PR does not recreate it until you redeploy it here."
						onClick={onRemove}
					>
						<Button
							size="sm"
							variant="destructive"
							disabled={removing}
							isLoading={removing}
						>
							Remove environment
						</Button>
					</DialogAction>
				)}
				{active && preview.expiresAt && (
					<span className="text-xs text-muted-foreground">
						Expires{" "}
						{new Date(preview.expiresAt).toLocaleString("en-GB", {
							timeZone: "UTC",
							dateStyle: "medium",
							timeStyle: "short",
						})}{" "}
						UTC
					</span>
				)}
			</div>
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
	const { data, error } = api.composePreview.settings.useQuery({ composeId });
	if (error)
		return (
			<p role="alert" className="text-sm text-destructive">
				{error.message}
			</p>
		);
	if (!data || !source)
		return (
			<div className="flex items-center gap-2 text-sm text-muted-foreground">
				<Loader2 className="size-4 animate-spin" /> Loading preview settings…
			</div>
		);
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

function NativeField({
	id,
	label,
	hint,
	children,
}: {
	id: string;
	label: string;
	hint?: React.ReactNode;
	children: React.ReactNode;
}) {
	return (
		<div className="space-y-2">
			<Label htmlFor={id}>{label}</Label>
			{children}
			{hint && <p className="text-xs text-muted-foreground">{hint}</p>}
		</div>
	);
}

type NumberSetting = "limit" | "ttlHours" | "cpuLimit" | "memoryLimitMb";

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
	// Raw text so commas and spaces can be typed; parsed on submit.
	const [labelsText, setLabelsText] = useState(settings.labels.join(", "));
	// Raw text too, so a number can be cleared and retyped (`Number("")` is 0).
	const [numbers, setNumbers] = useState<Record<NumberSetting, string>>({
		limit: String(settings.limit),
		ttlHours: String(settings.ttlHours),
		cpuLimit: String(settings.cpuLimit),
		memoryLimitMb: String(settings.memoryLimitMb),
	});
	const [env, setEnv] = useState(initial.env);
	const [envHidden, setEnvHidden] = useState(true);
	const [composeFile, setComposeFile] = useState(initial.composeFile);
	const readyWorkers = (workers || []).filter(
		(worker) =>
			worker.serverType === "deploy" &&
			worker.serverStatus === "active" &&
			!!worker.swarmNodeId,
	);

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
	// Turning previews off must work even when the worker or registry is gone.
	const required = settings.enabled;
	return (
		<Card>
			<CardHeader>
				<CardTitle>PR environment settings</CardTitle>
				<CardDescription>
					Deploys non-draft PRs opened from this repository by people with write
					access. The source service keeps its own branch. Each PR builds on the
					selected Swarm worker and runs as an isolated stack.{" "}
					<a
						href={COMPOSE_PREVIEW_DOCS_URL}
						target="_blank"
						rel="noreferrer"
						className="text-primary underline"
					>
						Setup guide
					</a>
				</CardDescription>
			</CardHeader>
			<CardContent>
				<form
					className="space-y-6"
					onSubmit={(event) => {
						event.preventDefault();
						mutation.mutate({
							composeId,
							settings: {
								...settings,
								limit: Number(numbers.limit),
								ttlHours: Number(numbers.ttlHours),
								cpuLimit: Number(numbers.cpuLimit),
								memoryLimitMb: Number(numbers.memoryLimitMb),
								labels: [
									...new Set(
										labelsText
											.split(",")
											.map((label) => label.trim())
											.filter(Boolean),
									),
								],
							},
							env,
							composeFile,
						});
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
						{workers && !readyWorkers.length && (
							<Alert>
								<AlertTriangle className="size-4" />
								<AlertTitle>No preview worker is ready</AlertTitle>
								<AlertDescription>
									Join a deployment server to the Swarm as a worker, then open
									it in{" "}
									<Link
										href="/dashboard/settings/servers"
										className="text-primary underline"
									>
										Remote servers
									</Link>
									, choose <strong>Preview worker</strong> in its actions and
									save the worker policy and firewall.
								</AlertDescription>
							</Alert>
						)}
						<div className="grid gap-4 md:grid-cols-2">
							<NativeField
								id="preview-worker"
								label="Swarm worker"
								hint="Builds and runs every PR of this service."
							>
								<Select
									value={settings.serverId || undefined}
									onValueChange={(value) => set("serverId", value)}
								>
									<SelectTrigger id="preview-worker">
										<SelectValue placeholder="Select a worker" />
									</SelectTrigger>
									<SelectContent>
										{readyWorkers.map((worker) => (
											<SelectItem key={worker.serverId} value={worker.serverId}>
												{worker.name}
												{worker.previewOnly ? " · previews only" : ""} · up to{" "}
												{worker.previewCapacity} PRs
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</NativeField>
							<NativeField
								id="preview-registry"
								label="Image registry"
								hint="Built images are pushed here and pulled by digest."
							>
								<Select
									value={settings.registryId || undefined}
									onValueChange={(value) => set("registryId", value)}
								>
									<SelectTrigger id="preview-registry">
										<SelectValue placeholder="Select a registry" />
									</SelectTrigger>
									<SelectContent>
										{registries?.map((registry) => (
											<SelectItem
												key={registry.registryId}
												value={registry.registryId}
											>
												{registry.registryName}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</NativeField>
							<NativeField
								id="preview-baseBranch"
								label="PR base branch"
								hint="Only PRs targeting this branch get an environment."
							>
								<Input
									id="preview-baseBranch"
									required={required}
									value={settings.baseBranch}
									onChange={(event) => set("baseBranch", event.target.value)}
								/>
							</NativeField>
							<NativeField
								id="preview-composePath"
								label="Compose file in the repository"
							>
								<Input
									id="preview-composePath"
									required={required}
									value={settings.composePath}
									onChange={(event) => set("composePath", event.target.value)}
								/>
							</NativeField>
							<NativeField
								id="preview-domain"
								label="Preview domain"
								hint={
									<>
										Point a wildcard DNS record (
										<code>*.{settings.domain || "preview.example.com"}</code>)
										at the Swarm manager. Each service gets a host under it.
									</>
								}
							>
								<Input
									id="preview-domain"
									required={required}
									placeholder="preview.example.com"
									value={settings.domain}
									onChange={(event) => set("domain", event.target.value)}
								/>
							</NativeField>
							<NativeField
								id="preview-labels"
								label="Required PR labels"
								hint="Comma separated. Empty: every eligible PR. Otherwise a PR needs at least one of them."
							>
								<Input
									id="preview-labels"
									placeholder="preview, qa"
									value={labelsText}
									onChange={(event) => setLabelsText(event.target.value)}
								/>
							</NativeField>
							{(
								[
									[
										"limit",
										"Maximum PRs at once",
										1,
										50,
										"Extra PRs wait and start automatically when one closes.",
									],
									[
										"ttlHours",
										"Lifetime (hours)",
										1,
										720,
										"Counted from the last deployed commit.",
									],
									["cpuLimit", "CPU limit per service", 0.1, 64, undefined],
									[
										"memoryLimitMb",
										"Memory limit per service (MiB)",
										64,
										65536,
										undefined,
									],
								] as const
							).map(([key, label, min, max, hint]) => (
								<NativeField
									key={key}
									id={`preview-${key}`}
									label={label}
									hint={hint}
								>
									<Input
										id={`preview-${key}`}
										type="number"
										required
										min={min}
										max={max}
										step={key === "cpuLimit" ? 0.1 : 1}
										value={numbers[key]}
										onChange={(event) =>
											setNumbers((previous) => ({
												...previous,
												[key]: event.target.value,
											}))
										}
									/>
								</NativeField>
							))}
						</div>
						<div className="grid gap-4 md:grid-cols-2">
							<div className="flex items-center gap-3">
								<Switch
									id="preview-https"
									checked={settings.https}
									onCheckedChange={(value) => set("https", value)}
								/>
								<Label htmlFor="preview-https">HTTPS URLs</Label>
							</div>
							<NativeField id="preview-certificate" label="Certificates">
								<Select
									value={settings.certificateType}
									onValueChange={(value) =>
										set("certificateType", value as "none" | "letsencrypt")
									}
								>
									<SelectTrigger id="preview-certificate">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="letsencrypt">
											Let's Encrypt on the manager
										</SelectItem>
										<SelectItem value="none">
											Existing wildcard certificate or upstream proxy
										</SelectItem>
									</SelectContent>
								</Select>
							</NativeField>
						</div>
						<div className="space-y-2">
							<div className="flex items-center justify-between">
								<Label id="preview-env-label">PR environment variables</Label>
								<Toggle
									aria-label={envHidden ? "Show values" : "Hide values"}
									pressed={!envHidden}
									onPressedChange={(pressed) => setEnvHidden(!pressed)}
								>
									{envHidden ? (
										<EyeIcon className="size-4 text-muted-foreground" />
									) : (
										<EyeOffIcon className="size-4 text-muted-foreground" />
									)}
								</Toggle>
							</div>
							<CodeEditor
								id="preview-env"
								role="group"
								aria-labelledby="preview-env-label"
								language="properties"
								lineWrapping
								disabled={envHidden || !canEdit || mutation.isPending}
								style={
									{
										WebkitTextSecurity: envHidden ? "disc" : null,
									} as CSSProperties
								}
								className="h-56 font-mono"
								placeholder={[
									"DATABASE_URL=postgres://app:${{DOKPLOY_PREVIEW_PASSWORD}}@db:5432/app",
									"PUBLIC_URL=${{DOKPLOY_PREVIEW_WEB_URL}}",
								].join("\n")}
								value={env}
								onChange={setEnv}
							/>
							<p className="text-xs text-muted-foreground">
								Variables do not inherit staging or project values. Available
								placeholders: <code>{"${{DOKPLOY_PR_NUMBER}}"}</code>,{" "}
								<code>{"${{DOKPLOY_PR_BRANCH}}"}</code>,{" "}
								<code>{"${{DOKPLOY_PREVIEW_PASSWORD}}"}</code> (random per PR),{" "}
								<code>{"${{DOKPLOY_DEPLOY_URL}}"}</code>,{" "}
								<code>{"${{DOKPLOY_PREVIEW_<SERVICE>_URL}}"}</code>,{" "}
								<code>{"${{DOKPLOY_PREVIEW_<SERVICE>_<PORT>_URL}}"}</code> and{" "}
								<code>{"${{DOKPLOY_PREVIEW_<SERVICE>_<PORT>_WS_URL}}"}</code>{" "}
								(service name in uppercase, other characters replaced with
								underscores). They are also exported as plain variables.
							</p>
						</div>
						<div className="space-y-2">
							<Label id="preview-file-label">
								Compose file override (optional)
							</Label>
							<CodeEditor
								id="preview-file"
								role="group"
								aria-labelledby="preview-file-label"
								language="yaml"
								disabled={!canEdit || mutation.isPending}
								className="h-64 font-mono"
								placeholder={
									"services:\n  web:\n    build: .\n  db:\n    image: postgres:17\n    volumes: [db:/var/lib/postgresql/data]\nvolumes:\n  db: {}"
								}
								value={composeFile}
								onChange={setComposeFile}
							/>
							<p className="text-xs text-muted-foreground">
								Leave empty to use the repository file. Add PR databases here
								when staging uses external ones. Host ports and container names
								are dropped; external volumes, bind mounts and privileged
								services are rejected. Use named volumes and bake repository
								files into images.
							</p>
						</div>
						{canEdit && (
							<Button type="submit" isLoading={mutation.isPending}>
								Save settings
							</Button>
						)}
					</fieldset>
				</form>
			</CardContent>
		</Card>
	);
}

export function ComposePreviewsTrigger({
	source,
}: {
	source?: { sourceType: string; composeType: string } | null;
}) {
	const { data: isCloud } = api.settings.isCloud.useQuery();
	return supportsComposePreviews(source, isCloud) ? (
		<TabsTrigger value="previews">PR environments</TabsTrigger>
	) : null;
}
