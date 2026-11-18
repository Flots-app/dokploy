import type { ComposePreviewSettings } from "@dokploy/server/utils/docker/compose-preview";
import { AlertTriangle, EyeIcon, EyeOffIcon, Loader2 } from "lucide-react";
import Link from "next/link";
import { type CSSProperties, type ReactNode, useState } from "react";
import { toast } from "sonner";
import { CodeEditor } from "@/components/shared/code-editor";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Toggle } from "@/components/ui/toggle";
import { api, type RouterOutputs } from "@/utils/api";
import { COMPOSE_PREVIEW_DOCS_URL } from "./utils";

type NumberSetting = "limit" | "ttlHours" | "cpuLimit" | "memoryLimitMb";
type SetSetting = <K extends keyof ComposePreviewSettings>(
	key: K,
	value: ComposePreviewSettings[K],
) => void;

const NUMBER_FIELDS: readonly [
	NumberSetting,
	string,
	number,
	number,
	string | undefined,
][] = [
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
	["memoryLimitMb", "Memory limit per service (MiB)", 64, 65536, undefined],
];

const defaultSettings = (composePath: string): ComposePreviewSettings => ({
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
});

function Field({
	id,
	label,
	hint,
	children,
}: {
	id: string;
	label: string;
	hint?: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className="space-y-2">
			<Label htmlFor={id}>{label}</Label>
			{children}
			{hint && <p className="text-xs text-muted-foreground">{hint}</p>}
		</div>
	);
}

function NoWorkerAlert() {
	return (
		<Alert>
			<AlertTriangle className="size-4" />
			<AlertTitle>No preview worker is ready</AlertTitle>
			<AlertDescription>
				Join a deployment server to the Swarm as a worker, then open it in{" "}
				<Link
					href="/dashboard/settings/servers"
					className="text-primary underline"
				>
					Remote servers
				</Link>
				, open <strong>View Actions</strong>, select its Swarm manager, turn on{" "}
				<strong>Reserve this server for Compose previews</strong>, save, then
				apply the preview network firewall.
			</AlertDescription>
		</Alert>
	);
}

function TargetFields({
	settings,
	set,
	required,
	labelsText,
	setLabelsText,
}: {
	settings: ComposePreviewSettings;
	set: SetSetting;
	required: boolean;
	labelsText: string;
	setLabelsText: (value: string) => void;
}) {
	const { data: workers } = api.server.all.useQuery();
	const { data: registries } = api.registry.all.useQuery();
	const readyWorkers = (workers || []).filter(
		(worker) =>
			worker.serverType === "deploy" &&
			worker.serverStatus === "active" &&
			!!worker.swarmNodeId &&
			worker.previewOnly,
	);
	return (
		<>
			{workers && !readyWorkers.length && <NoWorkerAlert />}
			<div className="grid gap-4 md:grid-cols-2">
				<Field
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
									{worker.name} · up to {worker.previewCapacity} PRs
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</Field>
				<Field
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
				</Field>
				<Field
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
				</Field>
				<Field id="preview-composePath" label="Compose file in the repository">
					<Input
						id="preview-composePath"
						required={required}
						value={settings.composePath}
						onChange={(event) => set("composePath", event.target.value)}
					/>
				</Field>
				<Field
					id="preview-domain"
					label="Preview domain"
					hint={
						<>
							Point a wildcard DNS record (
							<code>*.{settings.domain || "preview.example.com"}</code>) at the
							Swarm manager. Each service gets a host under it.
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
				</Field>
				<Field
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
				</Field>
			</div>
		</>
	);
}

function LimitFields({
	numbers,
	setNumbers,
}: {
	numbers: Record<NumberSetting, string>;
	setNumbers: (
		update: (
			previous: Record<NumberSetting, string>,
		) => Record<NumberSetting, string>,
	) => void;
}) {
	return (
		<div className="grid gap-4 md:grid-cols-2">
			{NUMBER_FIELDS.map(([key, label, min, max, hint]) => (
				<Field key={key} id={`preview-${key}`} label={label} hint={hint}>
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
				</Field>
			))}
		</div>
	);
}

function TlsFields({
	settings,
	set,
}: {
	settings: ComposePreviewSettings;
	set: SetSetting;
}) {
	return (
		<div className="grid gap-4 md:grid-cols-2">
			<div className="flex items-center gap-3">
				<Switch
					id="preview-https"
					checked={settings.https}
					onCheckedChange={(value) => set("https", value)}
				/>
				<Label htmlFor="preview-https">HTTPS URLs</Label>
			</div>
			<Field id="preview-certificate" label="Certificates">
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
			</Field>
		</div>
	);
}

function EnvEditor({
	value,
	onChange,
	disabled,
}: {
	value: string;
	onChange: (value: string) => void;
	disabled: boolean;
}) {
	const [hidden, setHidden] = useState(true);
	return (
		<div className="space-y-2">
			<div className="flex items-center justify-between">
				<Label id="preview-env-label">PR environment variables</Label>
				<Toggle
					aria-label={hidden ? "Show values" : "Hide values"}
					pressed={!hidden}
					onPressedChange={(pressed) => setHidden(!pressed)}
				>
					{hidden ? (
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
				disabled={hidden || disabled}
				style={{ WebkitTextSecurity: hidden ? "disc" : null } as CSSProperties}
				className="h-56 font-mono"
				placeholder={[
					"DATABASE_URL=postgres://app:${{DOKPLOY_PREVIEW_PASSWORD}}@db:5432/app",
					"PUBLIC_URL=${{DOKPLOY_PREVIEW_WEB_URL}}",
				].join("\n")}
				value={value}
				onChange={onChange}
			/>
			<p className="text-xs text-muted-foreground">
				Variables do not inherit staging or project values. Available
				placeholders: <code>{"${{DOKPLOY_PR_NUMBER}}"}</code>,{" "}
				<code>{"${{DOKPLOY_PR_BRANCH}}"}</code>,{" "}
				<code>{"${{DOKPLOY_PREVIEW_PASSWORD}}"}</code> (random per PR),{" "}
				<code>{"${{DOKPLOY_DEPLOY_URL}}"}</code>,{" "}
				<code>{"${{DOKPLOY_PREVIEW_<SERVICE>_URL}}"}</code>,{" "}
				<code>{"${{DOKPLOY_PREVIEW_<SERVICE>_<PORT>_URL}}"}</code> and{" "}
				<code>{"${{DOKPLOY_PREVIEW_<SERVICE>_<PORT>_WS_URL}}"}</code> (service
				name in uppercase, other characters replaced with underscores). They are
				also exported as plain variables.
			</p>
		</div>
	);
}

function ComposeOverrideEditor({
	value,
	onChange,
	disabled,
}: {
	value: string;
	onChange: (value: string) => void;
	disabled: boolean;
}) {
	return (
		<div className="space-y-2">
			<Label id="preview-file-label">Compose file override (optional)</Label>
			<CodeEditor
				id="preview-file"
				role="group"
				aria-labelledby="preview-file-label"
				language="yaml"
				disabled={disabled}
				className="h-64 font-mono"
				placeholder={
					"services:\n  web:\n    build: .\n  db:\n    image: postgres:17\n    volumes: [db:/var/lib/postgresql/data]\nvolumes:\n  db: {}"
				}
				value={value}
				onChange={onChange}
			/>
			<p className="text-xs text-muted-foreground">
				Leave empty to use the repository file. Add PR databases here when
				staging uses external ones. Host ports and container names are dropped;
				external volumes, bind mounts and privileged services are rejected. Use
				named volumes and bake repository files into images.
			</p>
		</div>
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
	const utils = api.useUtils();
	const [settings, setSettings] = useState<ComposePreviewSettings>(
		() => initial.settings || defaultSettings(composePath),
	);
	// Raw text, so commas can be typed and numbers cleared; parsed on submit.
	const [labelsText, setLabelsText] = useState(() =>
		settings.labels.join(", "),
	);
	const [numbers, setNumbers] = useState<Record<NumberSetting, string>>(() => ({
		limit: String(settings.limit),
		ttlHours: String(settings.ttlHours),
		cpuLimit: String(settings.cpuLimit),
		memoryLimitMb: String(settings.memoryLimitMb),
	}));
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
	const set: SetSetting = (key, value) =>
		setSettings((previous) => ({ ...previous, [key]: value }));
	const locked = !canEdit || mutation.isPending;
	const submit = () =>
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
						submit();
					}}
				>
					<fieldset disabled={locked} className="space-y-6">
						<div className="flex items-center gap-3">
							<Switch
								id="previews-enabled"
								checked={settings.enabled}
								onCheckedChange={(value) => set("enabled", value)}
							/>
							<Label htmlFor="previews-enabled">Enable PR environments</Label>
						</div>
						<TargetFields
							settings={settings}
							set={set}
							// Turning previews off must work even when the worker is gone.
							required={settings.enabled}
							labelsText={labelsText}
							setLabelsText={setLabelsText}
						/>
						<LimitFields numbers={numbers} setNumbers={setNumbers} />
						<TlsFields settings={settings} set={set} />
					</fieldset>
					{/* Outside the fieldset: read-only users can still reveal the
					    variables the server returns to them. */}
					<EnvEditor value={env} onChange={setEnv} disabled={locked} />
					<ComposeOverrideEditor
						value={composeFile}
						onChange={setComposeFile}
						disabled={locked}
					/>
					{canEdit && (
						<Button type="submit" isLoading={mutation.isPending}>
							Save settings
						</Button>
					)}
				</form>
			</CardContent>
		</Card>
	);
}

export function ComposePreviewSettingsForm({
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
