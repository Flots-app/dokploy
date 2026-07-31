import {
	ADDITIONAL_FLAG_ERROR,
	ADDITIONAL_FLAG_REGEX,
} from "@dokploy/server/db/validations/destination";
import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import {
	ExternalLink,
	KeyRound,
	PenBoxIcon,
	PlusIcon,
	RefreshCw,
	ShieldCheck,
	Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
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
import {
	Form,
	FormControl,
	FormDescription,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { api } from "@/utils/api";
import { S3_PROVIDERS } from "./constants";

const addDestination = z
	.object({
		name: z.string().min(1, "Name is required"),
		provider: z.string().min(1, "Provider is required"),
		accessKeyId: z.string().min(1, "Access Key Id is required"),
		secretAccessKey: z.string().min(1, "Secret Access Key is required"),
		bucket: z.string().min(1, "Bucket is required"),
		region: z.string(),
		endpoint: z.string().min(1, "Endpoint is required"),
		serverId: z.string().optional(),
		additionalFlags: z
			.array(
				z.object({
					value: z
						.string()
						.min(1, "Flag cannot be empty")
						.regex(ADDITIONAL_FLAG_REGEX, ADDITIONAL_FLAG_ERROR),
				}),
			)
			.optional(),
		encryptionEnabled: z.boolean(),
		encryptionPassword: z.string().optional(),
		encryptionPassword2: z.string().optional(),
		encryptionFilenameMode: z.enum(["standard", "obfuscate", "off"]),
		encryptionDirectoryNames: z.boolean(),
		encryptionPasswordConfigured: z.boolean(),
	})
	.superRefine((destination, ctx) => {
		if (
			destination.encryptionEnabled &&
			!destination.encryptionPassword &&
			!destination.encryptionPasswordConfigured
		) {
			ctx.addIssue({
				code: "custom",
				message: "Encryption password is required",
				path: ["encryptionPassword"],
			});
		}
		if (
			destination.encryptionPassword2 &&
			destination.encryptionPassword2 === destination.encryptionPassword
		) {
			ctx.addIssue({
				code: "custom",
				message: "Use a different second password",
				path: ["encryptionPassword2"],
			});
		}
	});

type AddDestination = z.infer<typeof addDestination>;

const generateEncryptionPassword = () => {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
};

interface Props {
	destinationId?: string;
}

export const HandleDestinations = ({ destinationId }: Props) => {
	const [open, setOpen] = useState(false);
	const utils = api.useUtils();
	const { data: servers } = api.server.withSSHKey.useQuery();
	const { data: isCloud } = api.settings.isCloud.useQuery();

	const createDestination = api.destination.create.useMutation();
	const updateDestination = api.destination.update.useMutation();
	const activeMutation = destinationId ? updateDestination : createDestination;
	const { isError, error, isPending } = activeMutation;

	const { data: destination } = api.destination.one.useQuery(
		{
			destinationId: destinationId || "",
		},
		{
			enabled: !!destinationId,
			refetchOnWindowFocus: false,
		},
	);
	const {
		mutateAsync: testConnection,
		isPending: isPendingConnection,
		error: connectionError,
		isError: isErrorConnection,
	} = api.destination.testConnection.useMutation();

	const form = useForm<AddDestination>({
		defaultValues: {
			provider: "",
			accessKeyId: "",
			bucket: "",
			name: "",
			region: "",
			secretAccessKey: "",
			endpoint: "",
			additionalFlags: [],
			encryptionEnabled: false,
			encryptionPassword: "",
			encryptionPassword2: "",
			encryptionFilenameMode: "standard",
			encryptionDirectoryNames: true,
			encryptionPasswordConfigured: false,
		},
		resolver: zodResolver(addDestination),
	});

	const { fields, append, remove } = useFieldArray({
		control: form.control,
		name: "additionalFlags",
	});
	const encryptionEnabled = form.watch("encryptionEnabled");
	const encryptionFilenameMode = form.watch("encryptionFilenameMode");

	useEffect(() => {
		if (destination) {
			form.reset({
				name: destination.name,
				provider: destination.provider || "",
				accessKeyId: destination.accessKey,
				secretAccessKey: destination.secretAccessKey,
				bucket: destination.bucket,
				region: destination.region,
				endpoint: destination.endpoint,
				additionalFlags:
					destination.additionalFlags?.map((f) => ({ value: f })) ?? [],
				encryptionEnabled: destination.encryptionEnabled,
				encryptionPassword: "",
				encryptionPassword2: "",
				encryptionFilenameMode: ["standard", "obfuscate", "off"].includes(
					destination.encryptionFilenameMode,
				)
					? (destination.encryptionFilenameMode as
							| "standard"
							| "obfuscate"
							| "off")
					: "standard",
				encryptionDirectoryNames: destination.encryptionDirectoryNames,
				encryptionPasswordConfigured: destination.encryptionEnabled,
			});
		} else {
			form.reset();
		}
	}, [form, form.reset, form.formState.isSubmitSuccessful, destination]);

	const onSubmit = async (data: AddDestination) => {
		const destination = {
			provider: data.provider || "",
			accessKey: data.accessKeyId,
			bucket: data.bucket,
			endpoint: data.endpoint,
			name: data.name,
			region: data.region,
			secretAccessKey: data.secretAccessKey,
			additionalFlags: data.additionalFlags?.map((f) => f.value) ?? [],
		};
		const mutation = destinationId
			? updateDestination.mutateAsync({
					...destination,
					destinationId,
					serverId: data.serverId,
				})
			: createDestination.mutateAsync({
					...destination,
					serverId: data.serverId,
					encryptionEnabled: data.encryptionEnabled,
					encryptionPassword: data.encryptionPassword,
					encryptionPassword2: data.encryptionPassword2,
					encryptionFilenameMode: data.encryptionFilenameMode,
					encryptionDirectoryNames: data.encryptionDirectoryNames,
				});

		await mutation
			.then(async () => {
				toast.success(`Destination ${destinationId ? "Updated" : "Created"}`);
				await utils.destination.all.invalidate();
				if (destinationId) {
					await utils.destination.one.invalidate({ destinationId });
				}
				setOpen(false);
			})
			.catch((e) => {
				toast.error(
					`Error ${destinationId ? "Updating" : "Creating"} the Destination`,
					{
						description: e.message,
					},
				);
			});
	};

	const handleTestConnection = async (serverId?: string) => {
		const result = await form.trigger([
			"provider",
			"accessKeyId",
			"secretAccessKey",
			"bucket",
			"endpoint",
			"additionalFlags",
			"encryptionPassword",
			"encryptionPassword2",
		]);

		if (!result) {
			const errors = form.formState.errors;
			const errorFields = Object.entries(errors)
				.map(([field, error]) => `${field}: ${error?.message}`)
				.filter(Boolean)
				.join("\n");

			toast.error("Please fill all required fields", {
				description: errorFields,
			});
			return;
		}

		if (isCloud && !serverId) {
			toast.error("Please select a server");
			return;
		}

		const provider = form.getValues("provider");
		const accessKey = form.getValues("accessKeyId");
		const secretKey = form.getValues("secretAccessKey");
		const bucket = form.getValues("bucket");
		const endpoint = form.getValues("endpoint");
		const region = form.getValues("region");

		await testConnection({
			provider,
			accessKey,
			bucket,
			endpoint,
			name: "Test",
			region,
			secretAccessKey: secretKey,
			serverId,
			additionalFlags:
				form.getValues("additionalFlags")?.map((f) => f.value) ?? [],
			encryptionEnabled: destinationId ? false : encryptionEnabled,
			encryptionPassword: destinationId
				? undefined
				: form.getValues("encryptionPassword"),
			encryptionPassword2: destinationId
				? undefined
				: form.getValues("encryptionPassword2"),
			encryptionFilenameMode: form.getValues("encryptionFilenameMode"),
			encryptionDirectoryNames: form.getValues("encryptionDirectoryNames"),
		})
			.then(() => {
				toast.success("Connection Success");
			})
			.catch((e) => {
				toast.error("Error connecting to provider", {
					description: e.message,
				});
			});
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger className="" asChild>
				{destinationId ? (
					<Button
						variant="ghost"
						size="icon"
						className="group hover:bg-blue-500/10 "
					>
						<PenBoxIcon className="size-3.5  text-primary group-hover:text-blue-500" />
					</Button>
				) : (
					<Button className="cursor-pointer space-x-3">
						<PlusIcon className="h-4 w-4" />
						Add Destination
					</Button>
				)}
			</DialogTrigger>
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>
						{destinationId ? "Update" : "Add"} Destination
					</DialogTitle>
					<DialogDescription>
						In this section, you can configure and add new destinations for your
						backups. Please ensure that you provide the correct information to
						guarantee secure and efficient storage.
					</DialogDescription>
				</DialogHeader>
				{(isError || isErrorConnection) && (
					<AlertBlock type="error" className="w-full">
						{connectionError?.message || error?.message}
					</AlertBlock>
				)}

				<Form {...form}>
					<form
						id="hook-form-destination-add"
						onSubmit={form.handleSubmit(onSubmit)}
						className="grid w-full gap-4 "
					>
						<FormField
							control={form.control}
							name="name"
							render={({ field }) => {
								return (
									<FormItem>
										<FormLabel>Name</FormLabel>
										<FormControl>
											<Input placeholder={"S3 Bucket"} {...field} />
										</FormControl>
										<FormMessage />
									</FormItem>
								);
							}}
						/>
						<FormField
							control={form.control}
							name="provider"
							render={({ field }) => {
								return (
									<FormItem>
										<FormLabel>Provider</FormLabel>
										<FormControl>
											<Select
												onValueChange={field.onChange}
												defaultValue={field.value}
												value={field.value}
											>
												<FormControl>
													<SelectTrigger>
														<SelectValue placeholder="Select a S3 Provider" />
													</SelectTrigger>
												</FormControl>
												<SelectContent>
													{S3_PROVIDERS.map((s3Provider) => (
														<SelectItem
															key={s3Provider.key}
															value={s3Provider.key}
														>
															{s3Provider.name}
														</SelectItem>
													))}
												</SelectContent>
											</Select>
										</FormControl>
										<FormMessage />
									</FormItem>
								);
							}}
						/>

						<FormField
							control={form.control}
							name="accessKeyId"
							render={({ field }) => {
								return (
									<FormItem>
										<FormLabel>Access Key Id</FormLabel>
										<FormControl>
											<Input placeholder={"xcas41dasde"} {...field} />
										</FormControl>
										<FormMessage />
									</FormItem>
								);
							}}
						/>
						<FormField
							control={form.control}
							name="secretAccessKey"
							render={({ field }) => (
								<FormItem>
									<div className="space-y-0.5">
										<FormLabel>Secret Access Key</FormLabel>
									</div>
									<FormControl>
										<Input placeholder={"asd123asdasw"} {...field} />
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="bucket"
							render={({ field }) => (
								<FormItem>
									<div className="space-y-0.5">
										<FormLabel>Bucket</FormLabel>
									</div>
									<FormControl>
										<Input placeholder={"dokploy-bucket"} {...field} />
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="region"
							render={({ field }) => (
								<FormItem>
									<div className="space-y-0.5">
										<FormLabel>Region</FormLabel>
									</div>
									<FormControl>
										<Input placeholder={"us-east-1"} {...field} />
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="endpoint"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Endpoint</FormLabel>
									<FormControl>
										<Input
											placeholder={"https://us.bucket.aws/s3"}
											{...field}
										/>
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
						<div className="space-y-4 rounded-lg border p-4">
							<div className="flex items-center justify-between gap-4">
								<div className="flex items-center gap-2">
									<ShieldCheck className="size-4 text-muted-foreground" />
									<div>
										<p className="text-sm font-medium">
											Backup encryption at rest
										</p>
										<p className="text-xs text-muted-foreground">
											Powered by rclone crypt
										</p>
									</div>
								</div>
								<a
									href="https://rclone.org/crypt/"
									target="_blank"
									rel="noreferrer"
									className="flex items-center gap-1 text-xs text-primary hover:underline"
								>
									Documentation
									<ExternalLink className="size-3" />
								</a>
							</div>

							{destinationId ? (
								<div className="rounded-md bg-muted p-3 text-sm text-muted-foreground">
									{destination?.encryptionEnabled
										? "Encryption is enabled. Its password and filename settings are immutable so existing backups cannot be orphaned."
										: "This destination remains plaintext. Create a new encrypted destination to keep legacy and encrypted backup namespaces separate."}
								</div>
							) : (
								<>
									<FormField
										control={form.control}
										name="encryptionEnabled"
										render={({ field }) => (
											<FormItem className="flex items-center justify-between rounded-md border p-3">
												<div className="space-y-1">
													<FormLabel>Encrypt this destination</FormLabel>
													<FormDescription>
														Encrypts contents and, by default, object names.
													</FormDescription>
												</div>
												<FormControl>
													<Switch
														checked={field.value}
														onCheckedChange={field.onChange}
													/>
												</FormControl>
											</FormItem>
										)}
									/>

									{encryptionEnabled && (
										<div className="space-y-4">
											<FormField
												control={form.control}
												name="encryptionPassword"
												render={({ field }) => (
													<FormItem>
														<FormLabel>Encryption password</FormLabel>
														<div className="flex gap-2">
															<FormControl>
																<Input
																	type="password"
																	autoComplete="new-password"
																	placeholder="Enter or generate a strong password"
																	{...field}
																/>
															</FormControl>
															<Button
																type="button"
																variant="outline"
																size="icon"
																onClick={() => {
																	form.setValue(
																		"encryptionPassword",
																		generateEncryptionPassword(),
																		{ shouldValidate: true },
																	);
																}}
															>
																<RefreshCw className="size-4" />
															</Button>
														</div>
														<FormDescription>
															<KeyRound className="mr-1 inline size-3" />
															Save it externally. It cannot be recovered from
															the UI or changed later.
														</FormDescription>
														<FormMessage />
													</FormItem>
												)}
											/>

											<FormField
												control={form.control}
												name="encryptionPassword2"
												render={({ field }) => (
													<FormItem>
														<FormLabel>Second password (recommended)</FormLabel>
														<div className="flex gap-2">
															<FormControl>
																<Input
																	type="password"
																	autoComplete="new-password"
																	placeholder="Use a different password"
																	{...field}
																/>
															</FormControl>
															<Button
																type="button"
																variant="outline"
																size="icon"
																onClick={() => {
																	form.setValue(
																		"encryptionPassword2",
																		generateEncryptionPassword(),
																		{ shouldValidate: true },
																	);
																}}
															>
																<RefreshCw className="size-4" />
															</Button>
														</div>
														<FormDescription>
															rclone uses this as an additional secret when
															deriving encryption keys.
														</FormDescription>
														<FormMessage />
													</FormItem>
												)}
											/>

											<FormField
												control={form.control}
												name="encryptionFilenameMode"
												render={({ field }) => (
													<FormItem>
														<FormLabel>Filename encryption</FormLabel>
														<Select
															onValueChange={field.onChange}
															value={field.value}
														>
															<FormControl>
																<SelectTrigger>
																	<SelectValue />
																</SelectTrigger>
															</FormControl>
															<SelectContent>
																<SelectItem value="standard">
																	Standard (recommended)
																</SelectItem>
																<SelectItem value="obfuscate">
																	Obfuscate (not secure)
																</SelectItem>
																<SelectItem value="off">Off</SelectItem>
															</SelectContent>
														</Select>
														<FormDescription>
															Content is always encrypted. Standard also
															protects object names.
														</FormDescription>
													</FormItem>
												)}
											/>

											{encryptionFilenameMode !== "off" && (
												<FormField
													control={form.control}
													name="encryptionDirectoryNames"
													render={({ field }) => (
														<FormItem className="flex items-center justify-between rounded-md border p-3">
															<div className="space-y-1">
																<FormLabel>Encrypt directory names</FormLabel>
																<FormDescription>
																	Protect application and prefix names too.
																</FormDescription>
															</div>
															<FormControl>
																<Switch
																	checked={field.value}
																	onCheckedChange={field.onChange}
																/>
															</FormControl>
														</FormItem>
													)}
												/>
											)}
										</div>
									)}
								</>
							)}
						</div>
						<div className="flex flex-col gap-2">
							<div className="flex items-center justify-between">
								<FormLabel>Additional Flags (Optional)</FormLabel>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={() => append({ value: "" })}
								>
									<PlusIcon className="size-4" />
									Add Flag
								</Button>
							</div>
							{fields.map((field, index) => (
								<FormField
									key={field.id}
									control={form.control}
									name={`additionalFlags.${index}.value`}
									render={({ field }) => (
										<FormItem>
											<div className="flex items-center gap-2">
												<FormControl>
													<Input
														placeholder="--s3-sign-accept-encoding=false"
														{...field}
													/>
												</FormControl>
												<Button
													type="button"
													variant="ghost"
													size="icon"
													onClick={() => remove(index)}
												>
													<Trash2 className="size-4 text-muted-foreground" />
												</Button>
											</div>
											<FormMessage />
										</FormItem>
									)}
								/>
							))}
						</div>
					</form>

					<DialogFooter
						className={cn(
							isCloud ? "flex-col!" : "flex-row",
							"flex w-full  justify-between! gap-4",
						)}
					>
						{isCloud ? (
							<div className="flex flex-col gap-4 border p-2 rounded-lg">
								<span className="text-sm text-muted-foreground">
									Select a server to test the destination. If you don't have a
									server choose the default one.
								</span>
								<FormField
									control={form.control}
									name="serverId"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Server (Optional)</FormLabel>
											<FormControl>
												<Select
													onValueChange={field.onChange}
													defaultValue={field.value}
												>
													<SelectTrigger className="w-full">
														<SelectValue placeholder="Select a server" />
													</SelectTrigger>
													<SelectContent>
														<SelectGroup>
															<SelectLabel>Servers</SelectLabel>
															{servers?.map((server) => (
																<SelectItem
																	key={server.serverId}
																	value={server.serverId}
																>
																	{server.name}
																</SelectItem>
															))}
															<SelectItem value={"none"}>None</SelectItem>
														</SelectGroup>
													</SelectContent>
												</Select>
											</FormControl>

											<FormMessage />
										</FormItem>
									)}
								/>
								<Button
									type="button"
									variant={"secondary"}
									isLoading={isPendingConnection}
									onClick={async () => {
										await handleTestConnection(form.getValues("serverId"));
									}}
								>
									Test Connection
								</Button>
							</div>
						) : (
							<Button
								isLoading={isPendingConnection}
								type="button"
								variant="secondary"
								onClick={async () => {
									await handleTestConnection();
								}}
							>
								Test connection
							</Button>
						)}

						<Button
							isLoading={isPending}
							form="hook-form-destination-add"
							type="submit"
						>
							{destinationId ? "Update" : "Create"}
						</Button>
					</DialogFooter>
				</Form>
			</DialogContent>
		</Dialog>
	);
};
