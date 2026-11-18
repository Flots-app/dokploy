import { AlertTriangle, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
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
import { TabsTrigger } from "@/components/ui/tabs";
import { api, type RouterOutputs } from "@/utils/api";
import { PreviewRow } from "./preview-row";
import { ComposePreviewSettingsForm } from "./settings-form";
import { isPreviewBusy, supportsComposePreviews } from "./utils";

type Source = RouterOutputs["compose"]["one"];

function DeployPrForm({
	enabled,
	pending,
	onDeploy,
}: {
	enabled: boolean;
	pending: (pullRequestNumber: number) => boolean;
	onDeploy: (pullRequestNumber: number) => void;
}) {
	const [prNumber, setPrNumber] = useState("");
	return (
		<form
			className="flex flex-wrap items-end gap-3"
			onSubmit={(event) => {
				event.preventDefault();
				onDeploy(Number(prNumber));
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
				disabled={!enabled || pending(Number(prNumber))}
				isLoading={pending(Number(prNumber))}
			>
				Deploy or resume
			</Button>
			{!enabled && (
				<p className="text-sm text-muted-foreground">
					Enable PR environments in the settings above first.
				</p>
			)}
		</form>
	);
}

function PreviewList({
	source,
	composeId,
	canDeploy,
	canRemove,
}: {
	source?: Source;
	composeId: string;
	canDeploy: boolean;
	canRemove: boolean;
}) {
	const utils = api.useUtils();
	const {
		data: previews,
		error,
		isLoading,
	} = api.composePreview.all.useQuery(
		{ composeId },
		{
			// Poll fast while something is moving, slowly otherwise.
			refetchInterval: (query) =>
				query.state.data?.some((preview) => isPreviewBusy(preview.status))
					? 3000
					: 15000,
		},
	);
	const refresh = () => utils.composePreview.all.invalidate({ composeId });
	const deploy = api.composePreview.deploy.useMutation({
		onSuccess: async (_, input) => {
			await refresh();
			toast.success(`PR #${input.pullRequestNumber} queued`);
		},
		onError: (failure) => toast.error(failure.message),
	});
	const remove = api.composePreview.remove.useMutation({
		onSuccess: async () => {
			await refresh();
			toast.success("Removal queued");
		},
		onError: (failure) => toast.error(failure.message),
	});
	const { data: currentUser } = api.user.get.useQuery();
	const isAdmin =
		currentUser?.role === "owner" || currentUser?.role === "admin";
	const forget = api.composePreview.forget.useMutation({
		onSuccess: async () => {
			await refresh();
			toast.success("PR environment forgotten");
		},
		onError: (failure) => toast.error(failure.message),
	});
	const enabled = !!source?.previewSettings?.enabled;
	const repositoryUrl =
		source?.owner && source.repository
			? `https://github.com/${source.owner}/${source.repository}`
			: null;
	const deploying = (pullRequestNumber: number) =>
		deploy.isPending &&
		deploy.variables?.pullRequestNumber === pullRequestNumber;
	const deployPr = (pullRequestNumber: number) =>
		deploy.mutate({ composeId, pullRequestNumber });
	return (
		<CardContent className="space-y-4">
			{canDeploy && (
				<DeployPrForm
					enabled={enabled}
					pending={deploying}
					onDeploy={deployPr}
				/>
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
					canDeploy={canDeploy && enabled}
					canRemove={canRemove}
					deploying={deploying(preview.pullRequestNumber)}
					removing={
						remove.isPending &&
						remove.variables?.previewId === preview.previewId
					}
					onDeploy={() => deployPr(preview.pullRequestNumber)}
					onRemove={() => remove.mutate({ previewId: preview.previewId })}
					onForget={
						isAdmin && canRemove
							? () => forget.mutate({ previewId: preview.previewId })
							: undefined
					}
				/>
			))}
		</CardContent>
	);
}

function Unsupported() {
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
}

export function ShowComposePreviews({ composeId }: { composeId: string }) {
	const { data: source } = api.compose.one.useQuery({ composeId });
	const { data: isCloud } = api.settings.isCloud.useQuery();
	const { data: permissions } = api.user.getPermissions.useQuery();
	if (source?.previewParentId)
		return (
			<p className="text-sm text-muted-foreground">
				This environment is managed from its source Compose PR environments tab.
			</p>
		);
	if (source && !supportsComposePreviews(source, isCloud))
		return <Unsupported />;
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
				{source && (
					<PreviewList
						source={source}
						composeId={composeId}
						canDeploy={!!permissions?.deployment.create}
						canRemove={!!permissions?.service.delete}
					/>
				)}
			</Card>
		</div>
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
