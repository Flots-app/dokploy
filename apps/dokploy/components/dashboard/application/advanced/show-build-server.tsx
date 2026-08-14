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

interface Props {
	applicationId: string;
}

const schema = z.object({
	buildServerId: z.string().min(1, "A Build Server is required"),
	buildRegistryId: z.string().min(1, "A Build Registry is required"),
});

type Schema = z.infer<typeof schema>;

export const ShowBuildServer = ({ applicationId }: Props) => {
	const { data, refetch } = api.application.one.useQuery(
		{ applicationId },
		{ enabled: !!applicationId },
	);
	const { data: buildServers } = api.server.buildServers.useQuery();
	const { data: registries } = api.registry.all.useQuery();

	const { mutateAsync, isPending } =
		api.application.updateBuildServer.useMutation();
	const defaultBuildServer = buildServers?.find(
		(server) => server.isDefaultBuildServer,
	);

	const form = useForm<Schema>({
		defaultValues: {
			buildServerId: data?.buildServerId || defaultBuildServer?.serverId || "",
			buildRegistryId: data?.buildRegistryId || "",
		},
		resolver: zodResolver(schema),
	});

	useEffect(() => {
		if (data && buildServers) {
			form.reset({
				buildServerId: data.buildServerId || defaultBuildServer?.serverId || "",
				buildRegistryId: data?.buildRegistryId || "",
			});
		}
	}, [form, data, buildServers, defaultBuildServer?.serverId]);

	const onSubmit = async (formData: Schema) => {
		await mutateAsync({
			applicationId,
			buildServerId: formData.buildServerId,
			buildRegistryId: formData.buildRegistryId,
		})
			.then(async () => {
				toast.success("Build Server Settings Updated");
				await refetch();
			})
			.catch(() => {
				toast.error("Error updating build server settings");
			});
	};

	return (
		<Card className="bg-background">
			<CardHeader>
				<div className="flex flex-row items-center gap-2">
					<Server className="size-6 text-muted-foreground" />
					<div>
						<CardTitle className="text-xl">Build Server</CardTitle>
						<CardDescription>
							Configure a dedicated server for building your application.
						</CardDescription>
					</div>
				</div>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<AlertBlock type="info">
					Every Application build runs on a dedicated Build Server. A Deploy
					Server cannot be selected, and both a Build Server and registry are
					required.
				</AlertBlock>

				<AlertBlock type="info">
					<strong>Dockerfile zero-downtime contract:</strong> Git source, at
					least one Dokploy Domain, a Docker Swarm health check, and a stop
					grace period of at least 30 seconds are required. Published host
					ports, mounts, custom Traefik labels and non-VIP routing are rejected.
					Dokploy builds and pushes an immutable deployment image on this
					server, pulls it before activation, then waits for a start-first Swarm
					update and 30 seconds of stable health.
				</AlertBlock>

				{!buildServers || buildServers.length === 0 ? (
					<AlertBlock type="warning">
						No active Build Server is available. Create one in{" "}
						<Link
							href="/dashboard/settings/servers"
							className="text-primary underline"
						>
							Settings
						</Link>{" "}
						before building this Application.
					</AlertBlock>
				) : null}

				{!registries || registries.length === 0 ? (
					<AlertBlock type="warning">
						You need to add at least one registry to use build servers. Please
						go to{" "}
						<Link
							href="/dashboard/settings/registry"
							className="text-primary underline"
						>
							Settings
						</Link>{" "}
						to add a registry.
					</AlertBlock>
				) : null}

				<Form {...form}>
					<form
						onSubmit={form.handleSubmit(onSubmit)}
						className="grid w-full gap-4"
					>
						<FormField
							control={form.control}
							name="buildServerId"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Build Server</FormLabel>
									<Select onValueChange={field.onChange} value={field.value}>
										<FormControl>
											<SelectTrigger>
												<SelectValue placeholder="Select a build server" />
											</SelectTrigger>
										</FormControl>
										<SelectContent>
											<SelectGroup>
												{buildServers?.map((server) => (
													<SelectItem
														key={server.serverId}
														value={server.serverId}
													>
														<span className="flex items-center gap-2 justify-between w-full">
															<span>{server.name}</span>
															{server.isDefaultBuildServer ? (
																<span className="text-primary text-xs">
																	Default
																</span>
															) : null}
															<span className="text-muted-foreground text-xs">
																{server.ipAddress}
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
									<FormDescription>
										Select a build server to handle the build process for this
										application.
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
									<Select onValueChange={field.onChange} value={field.value}>
										<FormControl>
											<SelectTrigger>
												<SelectValue placeholder="Select a registry" />
											</SelectTrigger>
										</FormControl>
										<SelectContent>
											<SelectGroup>
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
										Select a registry to store the built images from the build
										server.
									</FormDescription>
									<FormMessage />
								</FormItem>
							)}
						/>

						<div className="flex w-full justify-end">
							<Button
								disabled={!buildServers?.length || !registries?.length}
								isLoading={isPending}
								type="submit"
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
