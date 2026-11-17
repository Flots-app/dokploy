import copy from "copy-to-clipboard";
import { Copy, ExternalLink, GitPullRequest, Loader2 } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { DialogAction } from "@/components/shared/dialog-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { RouterOutputs } from "@/utils/api";
import { formatUtc, isPreviewBusy, previewDomainUrl } from "./utils";

export type Preview = RouterOutputs["composePreview"]["all"][number];

const STATUS: Record<
	Preview["status"],
	{
		label: string;
		variant: "default" | "secondary" | "destructive" | "outline";
	}
> = {
	pending: { label: "Queued", variant: "secondary" },
	deploying: { label: "Deploying", variant: "secondary" },
	ready: { label: "Ready", variant: "default" },
	removing: { label: "Removing", variant: "secondary" },
	closed: { label: "Removed", variant: "outline" },
	error: { label: "Failed", variant: "destructive" },
};

function PreviewStatus({ status }: { status: Preview["status"] }) {
	const entry = STATUS[status];
	return (
		<Badge variant={entry.variant} className="gap-1">
			{isPreviewBusy(status) && (
				<Loader2 className="size-3 animate-spin" aria-hidden />
			)}
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

function PreviewHeader({
	preview,
	prUrl,
}: {
	preview: Preview;
	prUrl: string | null;
}) {
	const title = (
		<>
			<GitPullRequest className="size-4" />
			PR #{preview.pullRequestNumber}
		</>
	);
	return (
		<div className="flex flex-wrap items-center justify-between gap-3">
			<div className="flex flex-wrap items-center gap-3">
				{prUrl ? (
					<a
						href={prUrl}
						target="_blank"
						rel="noreferrer"
						className="flex items-center gap-1 font-medium hover:underline"
					>
						{title}
					</a>
				) : (
					<span className="flex items-center gap-1 font-medium">{title}</span>
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
	);
}

function PreviewUrls({
	domains,
}: {
	domains: NonNullable<Preview["instance"]>["domains"];
}) {
	return (
		<ul className="space-y-1 text-sm">
			{domains.map((domain) => {
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
	);
}

interface PreviewActionsProps {
	preview: Preview;
	projectId?: string;
	canDeploy: boolean;
	canRemove: boolean;
	deploying: boolean;
	removing: boolean;
	onDeploy: () => void;
	onRemove: () => void;
}

function PreviewActions({
	preview,
	projectId,
	canDeploy,
	canRemove,
	deploying,
	removing,
	onDeploy,
	onRemove,
}: PreviewActionsProps) {
	const active = preview.status !== "closed";
	const removable = canRemove && active && preview.status !== "removing";
	return (
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
			{removable && (
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
					Expires {formatUtc(preview.expiresAt)}
				</span>
			)}
		</div>
	);
}

export function PreviewRow({
	prUrl,
	...props
}: PreviewActionsProps & { prUrl: string | null }) {
	const { preview } = props;
	const domains =
		preview.status !== "closed" ? preview.instance?.domains || [] : [];
	return (
		<div className="space-y-3 rounded-lg border p-4">
			<PreviewHeader preview={preview} prUrl={prUrl} />
			{preview.error && (
				<p role="alert" className="text-sm text-destructive">
					{preview.error}
				</p>
			)}
			{domains.length > 0 && <PreviewUrls domains={domains} />}
			<PreviewActions {...props} />
		</div>
	);
}
