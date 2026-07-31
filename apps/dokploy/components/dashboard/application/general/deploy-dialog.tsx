import { Server } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useEffect, useState } from "react";
import { AlertBlock } from "@/components/shared/alert-block";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { api } from "@/utils/api";

interface Props {
	applicationId: string;
	title: string;
	description: string;
	confirmLabel: string;
	/** Rebuilds reuse the source code already downloaded on the build machine. */
	reusesDownloadedSource?: boolean;
	children: ReactNode;
	onConfirm: (selection: {
		buildServerId: string | null;
	}) => Promise<unknown> | unknown;
}

const NONE = "none";

/**
 * Deploy confirmation that also picks the Build Server running this build. It
 * starts on the one configured in the advanced settings and never changes it,
 * so a one-off build somewhere else does not become the new default. The
 * registry stays the application's own, since that is what the deploy server
 * pulls from.
 */
export const DeployDialog = ({
	applicationId,
	title,
	description,
	confirmLabel,
	reusesDownloadedSource,
	children,
	onConfirm,
}: Props) => {
	const [open, setOpen] = useState(false);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const { data: application } = api.application.one.useQuery(
		{ applicationId },
		{ enabled: !!applicationId },
	);
	const { data: buildServers } = api.server.buildServers.useQuery();

	const configuredBuildServerId = application?.buildServerId || NONE;
	const [buildServerId, setBuildServerId] = useState(NONE);

	useEffect(() => {
		if (!open) return;
		setBuildServerId(configuredBuildServerId);
	}, [open, configuredBuildServerId]);

	const hasRegistry = Boolean(
		application?.registryId || application?.buildRegistryId,
	);
	const missingRegistry = buildServerId !== NONE && !hasRegistry;
	const isOverridden = buildServerId !== configuredBuildServerId;

	const handleConfirm = async () => {
		setIsSubmitting(true);
		try {
			await onConfirm({
				buildServerId: buildServerId === NONE ? null : buildServerId,
			});
			setOpen(false);
		} finally {
			setIsSubmitting(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>{children}</DialogTrigger>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<Server className="size-5 text-muted-foreground" />
						{title}
					</DialogTitle>
					<DialogDescription>{description}</DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-4">
					<div className="flex flex-col gap-2">
						<Label htmlFor="deploy-build-server">Build Server</Label>
						<Select value={buildServerId} onValueChange={setBuildServerId}>
							<SelectTrigger id="deploy-build-server">
								<SelectValue placeholder="Select a build server" />
							</SelectTrigger>
							<SelectContent>
								<SelectGroup>
									<SelectItem value={NONE}>
										None (build on the deploy server)
									</SelectItem>
									{buildServers?.map((buildServer) => (
										<SelectItem
											key={buildServer.serverId}
											value={buildServer.serverId}
										>
											<span className="flex items-center gap-2 justify-between w-full">
												<span>{buildServer.name}</span>
												<span className="text-muted-foreground text-xs">
													{buildServer.ipAddress}
												</span>
											</span>
										</SelectItem>
									))}
									<SelectLabel>
										Build Servers ({buildServers?.length || 0})
									</SelectLabel>
								</SelectGroup>
							</SelectContent>
						</Select>
						<span className="text-sm text-muted-foreground">
							The image is pushed to the registry configured on this
							application, then pulled by the deploy server.
						</span>
					</div>

					{missingRegistry ? (
						<AlertBlock type="warning">
							This application has no registry configured, so the deploy server
							cannot pull an image built somewhere else. Add one in{" "}
							<Link href="/dashboard/settings/registry" className="underline">
								Settings
							</Link>{" "}
							and select it in the Build Server settings first.
						</AlertBlock>
					) : null}

					{isOverridden && reusesDownloadedSource ? (
						<AlertBlock type="warning">
							This action reuses the source code already downloaded by the
							previous build, which only exists on the Build Server that ran it.
							Deploy instead to download the code on another one.
						</AlertBlock>
					) : null}

					{isOverridden && !missingRegistry ? (
						<AlertBlock type="info">
							This choice applies to this deployment only. The application keeps
							the Build Server configured in its advanced settings.
						</AlertBlock>
					) : null}
				</div>

				<DialogFooter>
					<Button variant="secondary" onClick={() => setOpen(false)}>
						Cancel
					</Button>
					<Button
						isLoading={isSubmitting}
						disabled={missingRegistry}
						onClick={handleConfirm}
					>
						{confirmLabel}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};
