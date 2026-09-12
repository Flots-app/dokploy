import Head from "next/head";
import Link from "next/link";
import { useState } from "react";
import { ShowDeployments } from "@/components/dashboard/application/deployments/show-deployments";
import { DockerLogs } from "@/components/dashboard/compose/logs/show-stack";
import { AdvanceBreadcrumb } from "@/components/shared/advance-breadcrumb";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api, type RouterOutputs } from "@/utils/api";

export function ShowPreviewInstance({
	compose,
}: {
	compose: RouterOutputs["compose"]["one"];
}) {
	const [containerId, setContainerId] = useState<string>();
	const { data: source } = api.compose.one.useQuery({
		composeId: compose.previewParentId!,
	});
	const { data: containers, error } =
		api.docker.getContainersByAppNameMatch.useQuery(
			{
				appName: compose.appName,
				appType: "stack",
				composeId: compose.composeId,
				serverId: compose.serverId || undefined,
			},
			{ refetchInterval: 10000 },
		);
	return (
		<div className="space-y-6 pb-10">
			<Head>
				<title>{compose.name} | Dokploy</title>
			</Head>
			<AdvanceBreadcrumb />
			<Card>
				<CardHeader>
					<CardTitle>{compose.name}</CardTitle>
				</CardHeader>
				<CardContent className="space-y-4">
					<p className="text-sm text-muted-foreground">
						Manage deployment, expiry and removal from the source's PR
						environments.
					</p>
					{source && (
						<Link
							className="text-primary underline"
							href={`/dashboard/project/${source.environment.projectId}/environment/${source.environmentId}/services/compose/${source.composeId}?tab=previews`}
						>
							Manage PR environments
						</Link>
					)}
					<div className="flex flex-wrap gap-4">
						{compose.domains.map((domain) => (
							<a
								key={domain.domainId}
								href={`${domain.https ? "https" : "http"}://${domain.host}`}
								target="_blank"
								rel="noreferrer"
								className="text-primary underline"
							>
								{domain.serviceName}:{domain.port}
							</a>
						))}
					</div>
					<p className="text-sm text-muted-foreground">
						Worker: {compose.server?.name} · Commit:{" "}
						{compose.previewCommitSha?.slice(0, 12)}
					</p>
				</CardContent>
			</Card>
			<ShowDeployments
				id={compose.composeId}
				type="compose"
				serverId={compose.serverId || undefined}
				readOnly
			/>
			<Card>
				<CardHeader>
					<CardTitle>Containers and logs</CardTitle>
				</CardHeader>
				<CardContent className="space-y-4">
					{error && <p className="text-destructive">{error.message}</p>}
					{containers?.map((container) => (
						<div
							key={container.containerId}
							className="flex items-center justify-between gap-4 border-b pb-3"
						>
							<div className="min-w-0">
								<p className="break-all">{container.name}</p>
								<p className="text-sm text-muted-foreground">
									{container.status}
								</p>
							</div>
							<Button
								variant="outline"
								onClick={() => setContainerId(container.containerId)}
							>
								View logs
							</Button>
						</div>
					))}
					{containerId && (
						<DockerLogs
							containerId={containerId}
							serverId={compose.serverId || undefined}
							serviceId={compose.composeId}
							runType="native"
						/>
					)}
				</CardContent>
			</Card>
		</div>
	);
}
