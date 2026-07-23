import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { Server } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { AlertBlock } from "@/components/shared/alert-block";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Form,
	FormControl,
	FormDescription,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
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

const schema = z
	.object({
		buildServerId: z.string().optional(),
		buildRegistryId: z.string().optional(),
	})
	.refine(
		(data) => {
			const noServer = !data.buildServerId || data.buildServerId === "none";
			const noRegistry =
				!data.buildRegistryId || data.buildRegistryId === "none";
			return noServer === noRegistry;
		},
		{
			message:
				"Build Server and Build Registry must be selected or disabled together",
			path: ["buildServerId"],
		},
	);

type Schema = z.infer<typeof schema>;

export const ShowComposeBuildServer = ({
	composeId,
}: {
	composeId: string;
}) => {
	const { data, refetch } = api.compose.one.useQuery(
		{ composeId },
		{ enabled: Boolean(composeId) },
	);
	const { data: buildServers } = api.server.buildServers.useQuery();
	const { data: registries } = api.registry.all.useQuery();
	const { mutateAsync, isPending } =
		api.compose.updateBuildServer.useMutation();
	const persistedBuildServerId =
		data?.buildServerId || data?.buildServer?.serverId || "none";
	const persistedBuildRegistryId =
		data?.buildRegistryId || data?.buildRegistry?.registryId || "none";
	const selectionsReady =
		data !== undefined &&
		buildServers !== undefined &&
		registries !== undefined;
	const form = useForm<Schema>({
		resolver: zodResolver(schema),
		defaultValues: { buildServerId: "none", buildRegistryId: "none" },
	});

	useEffect(() => {
		if (!selectionsReady) return;
		form.reset({
			buildServerId: persistedBuildServerId,
			buildRegistryId: persistedBuildRegistryId,
		});
	}, [form, persistedBuildRegistryId, persistedBuildServerId, selectionsReady]);

	const eligible =
		data?.sourceType !== "raw" &&
		data?.composeType === "docker-compose" &&
		!data?.command?.trim() &&
		!data?.isolatedDeployment &&
		!data?.randomize;
	const selectedBuildServerId = form.watch("buildServerId");
	const selectedBuildRegistryId = form.watch("buildRegistryId");
	const enablingBuildServer =
		Boolean(selectedBuildServerId && selectedBuildServerId !== "none") &&
		Boolean(selectedBuildRegistryId && selectedBuildRegistryId !== "none");
	const hasDomains = Boolean(data?.domains?.length);
	const domainsMissing = enablingBuildServer && !hasDomains;

	const onSubmit = async (values: Schema) => {
		const buildServerId =
			!values.buildServerId || values.buildServerId === "none"
				? null
				: values.buildServerId;
		const buildRegistryId =
			!values.buildRegistryId || values.buildRegistryId === "none"
				? null
				: values.buildRegistryId;
		try {
			await mutateAsync({ composeId, buildServerId, buildRegistryId });
			await refetch();
			toast.success("Compose Build Server settings updated");
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "Unable to update Compose Build Server settings",
			);
		}
	};

	return (
		<Card className="bg-background">
			<CardHeader>
				<div className="flex items-center gap-2">
					<Server className="size-6 text-muted-foreground" />
					<div>
						<CardTitle className="text-xl">Compose Build Server</CardTitle>
						<CardDescription>
							Build remotely and activate releases with HTTP blue/green routing.
						</CardDescription>
					</div>
				</div>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<AlertBlock type="info">
					This mode is strict zero-downtime through Dokploy Domains and Traefik.
					The Git Compose must declare <code>x-dokploy.zero-downtime</code>,
					healthchecks, graceful stop periods, overlap safety, and immutable
					images tagged with <code>DOKPLOY_DEPLOYMENT_ID</code>. Host ports,
					container names, custom Traefik labels, local files, and unsafe
					volumes are rejected before the runtime is changed. Defaults are 120
					seconds for readiness, 30 seconds for stabilization, and 30 seconds
					for drain. Deployment logs identify the violating service, volume,
					network, image, healthcheck, or Domain before starting a runtime
					candidate.
				</AlertBlock>
				{!eligible ? (
					<AlertBlock type="warning">
						This Compose does not currently meet the V1 constraints. You can
						still disable an existing configuration.
					</AlertBlock>
				) : null}
				{!registries?.length ? (
					<AlertBlock type="warning">
						Add a registry in{" "}
						<Link href="/dashboard/settings/registry" className="underline">
							Settings
						</Link>{" "}
						before enabling this feature.
					</AlertBlock>
				) : null}
				{!hasDomains ? (
					<AlertBlock type="warning">
						At least one Dokploy Domain is required before enabling or deploying
						a zero-downtime Compose Build Server.{" "}
						<Link href="?tab=domains" className="underline">
							Add a Domain
						</Link>{" "}
						and map it to a healthy HTTP service first.
					</AlertBlock>
				) : null}

				<Form {...form}>
					<form onSubmit={form.handleSubmit(onSubmit)} className="grid gap-4">
						<FormField
							control={form.control}
							name="buildServerId"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Build Server</FormLabel>
									<Select
										value={field.value || "none"}
										onValueChange={(value) => {
											field.onChange(value);
											if (value === "none")
												form.setValue("buildRegistryId", "none");
										}}
									>
										<FormControl>
											<SelectTrigger>
												<SelectValue placeholder="Select a Build Server" />
											</SelectTrigger>
										</FormControl>
										<SelectContent>
											<SelectGroup>
												<SelectItem value="none">None</SelectItem>
												{buildServers?.map((server) => (
													<SelectItem
														key={server.serverId}
														value={server.serverId}
													>
														{server.name} ({server.ipAddress})
													</SelectItem>
												))}
												<SelectLabel>
													Build Servers ({buildServers?.length || 0})
												</SelectLabel>
											</SelectGroup>
										</SelectContent>
									</Select>
									<FormDescription>
										Hosts checkout, build, push, and deployment logs.
									</FormDescription>
									<FormMessage />
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="buildRegistryId"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Build Registry</FormLabel>
									<Select
										value={field.value || "none"}
										onValueChange={(value) => {
											field.onChange(value);
											if (value === "none")
												form.setValue("buildServerId", "none");
										}}
									>
										<FormControl>
											<SelectTrigger>
												<SelectValue placeholder="Select a registry" />
											</SelectTrigger>
										</FormControl>
										<SelectContent>
											<SelectGroup>
												<SelectItem value="none">None</SelectItem>
												{registries?.map((registry) => (
													<SelectItem
														key={registry.registryId}
														value={registry.registryId}
													>
														{registry.registryName}
													</SelectItem>
												))}
												<SelectLabel>
													Registries ({registries?.length || 0})
												</SelectLabel>
											</SelectGroup>
										</SelectContent>
									</Select>
									<FormDescription>
										Stores immutable images consumed by the runtime server.
									</FormDescription>
									<FormMessage />
								</FormItem>
							)}
						/>
						<div className="flex justify-end">
							<Button
								type="submit"
								isLoading={isPending}
								disabled={domainsMissing}
							>
								Save
							</Button>
						</div>
					</form>
				</Form>
			</CardContent>
		</Card>
	);
};
