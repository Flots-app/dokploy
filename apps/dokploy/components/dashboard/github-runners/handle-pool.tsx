import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { CheckCircle2, Loader2, Pencil, PlusIcon } from "lucide-react";
import { useState } from "react";
import {
	type FieldErrors,
	type UseFormReturn,
	useForm,
	useWatch,
} from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { AlertBlock } from "@/components/shared/alert-block";
import { Button } from "@/components/ui/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
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
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/utils/api";
import { parseLabels } from "./budget-values";
import type { RunnerPool } from "./format";

// Fields shown only for some scopes or authentication methods, and the
// collapsed advanced settings, are unmounted and then read as undefined.
const optional = z.string().trim().optional();

const schema = z
	.object({
		name: z.string().trim().min(1, "Name is required").max(64),
		description: z.string().max(500).optional(),
		scope: z.enum(["organization", "repository"]),
		owner: z.string().trim().min(1, "Owner is required"),
		repository: optional,
		runnerGroup: optional,
		labels: z.string(),
		authType: z.enum(["token", "app", "provider"]),
		token: optional,
		appId: z.string().regex(/^\d*$/, "Digits only").optional(),
		appInstallationId: z.string().regex(/^\d*$/, "Digits only").optional(),
		appPrivateKey: optional,
		githubId: optional,
		runnerVersion: z
			.string()
			.trim()
			.regex(
				/^(\d+\.\d+\.\d+)?$/,
				"Use a version such as 2.329.0, or leave empty",
			)
			.optional(),
		apiUrl: z.string().trim().url().optional(),
		runnerEnv: z.string().optional(),
		jobStartedHook: optional,
		jobCompletedHook: optional,
		rerunInterruptedJobs: z.boolean().optional(),
	})
	.refine((value) => value.scope === "organization" || value.repository, {
		path: ["repository"],
		message: "Repository is required",
	});

type FormValues = z.infer<typeof schema>;
type PoolForm = UseFormReturn<FormValues>;

const defaults = (pool?: RunnerPool): FormValues => ({
	name: pool?.name ?? "",
	description: pool?.description ?? "",
	scope: pool?.scope ?? "organization",
	owner: pool?.owner ?? "",
	repository: pool?.repository ?? "",
	runnerGroup: pool?.runnerGroup ?? "Default",
	labels: pool?.labels.join(", ") ?? "",
	authType: pool?.authType ?? "app",
	token: "",
	appId: pool?.appId ? String(pool.appId) : "",
	appInstallationId: pool?.appInstallationId ?? "",
	appPrivateKey: "",
	githubId: pool?.githubId ?? "",
	runnerVersion: pool?.runnerVersion ?? "",
	apiUrl: pool?.apiUrl ?? "https://api.github.com",
	runnerEnv: "",
	jobStartedHook: pool?.jobStartedHook ?? "",
	jobCompletedHook: pool?.jobCompletedHook ?? "",
	rerunInterruptedJobs: pool?.rerunInterruptedJobs ?? true,
});

/** Undefined (an unmounted field) keeps the stored value; empty clears it. */
const keepOr = <T,>(value: string | undefined, stored: T | null | undefined) =>
	value === undefined ? (stored ?? null) : value || null;

const toPoolInput = (values: FormValues, pool?: RunnerPool) => ({
	name: values.name,
	description: values.description || null,
	scope: values.scope,
	owner: values.owner,
	repository: values.scope === "repository" ? values.repository || null : null,
	runnerGroup:
		values.scope === "organization"
			? values.runnerGroup || "Default"
			: "Default",
	labels: parseLabels(values.labels),
	apiUrl: values.apiUrl || pool?.apiUrl || "https://api.github.com",
	authType: values.authType,
	// Secrets are never sent back: an empty field keeps the stored one.
	token: values.authType === "token" ? values.token || null : null,
	appId:
		values.authType === "app" && values.appId ? Number(values.appId) : null,
	appInstallationId:
		values.authType === "app" ? values.appInstallationId || null : null,
	appPrivateKey:
		values.authType === "app" ? values.appPrivateKey || null : null,
	githubId: values.authType === "provider" ? values.githubId || null : null,
	runnerVersion: keepOr(values.runnerVersion, pool?.runnerVersion),
	runnerEnv: values.runnerEnv ?? "",
	jobStartedHook: keepOr(values.jobStartedHook, pool?.jobStartedHook),
	jobCompletedHook: keepOr(values.jobCompletedHook, pool?.jobCompletedHook),
	rerunInterruptedJobs: values.rerunInterruptedJobs ?? true,
});

const TextField = ({
	form,
	name,
	label,
	placeholder,
	description,
	disabled,
}: {
	form: PoolForm;
	name: "name" | "owner" | "repository" | "runnerGroup" | "labels";
	label: string;
	placeholder?: string;
	description?: string;
	disabled?: boolean;
}) => (
	<FormField
		control={form.control}
		name={name}
		render={({ field }) => (
			<FormItem>
				<FormLabel>{label}</FormLabel>
				<FormControl>
					<Input placeholder={placeholder} disabled={disabled} {...field} />
				</FormControl>
				{description && <FormDescription>{description}</FormDescription>}
				<FormMessage />
			</FormItem>
		)}
	/>
);

const TargetFields = ({
	form,
	pool,
}: {
	form: PoolForm;
	pool?: RunnerPool;
}) => {
	const scope = useWatch({ control: form.control, name: "scope" });
	// The GitHub target of a pool with machines cannot change.
	const locked = Boolean(pool?.nodes.length);
	return (
		<>
			<div className="grid gap-4 sm:grid-cols-2">
				<TextField
					form={form}
					name="name"
					label="Name"
					placeholder="Flots CI"
				/>
				<FormField
					control={form.control}
					name="scope"
					render={({ field }) => (
						<FormItem>
							<FormLabel>Runners for</FormLabel>
							<Select
								value={field.value}
								onValueChange={field.onChange}
								disabled={locked}
							>
								<FormControl>
									<SelectTrigger>
										<SelectValue />
									</SelectTrigger>
								</FormControl>
								<SelectContent>
									<SelectItem value="organization">An organization</SelectItem>
									<SelectItem value="repository">A repository</SelectItem>
								</SelectContent>
							</Select>
							<FormMessage />
						</FormItem>
					)}
				/>
				<TextField
					form={form}
					name="owner"
					label={scope === "organization" ? "Organization" : "Owner"}
					placeholder="Flots-app"
					disabled={locked}
				/>
				{scope === "repository" ? (
					<TextField
						form={form}
						name="repository"
						label="Repository"
						placeholder="monorepo"
						disabled={locked}
					/>
				) : (
					<TextField
						form={form}
						name="runnerGroup"
						label="Runner group"
						placeholder="Default"
					/>
				)}
			</div>
			<TextField
				form={form}
				name="labels"
				label="Labels"
				placeholder="flots-mac-mini-parallel, flots-mac-mini-linux"
				description="Added to self-hosted, Linux, the architecture and dokploy-<machine>. Workflows select the pool with runs-on."
			/>
		</>
	);
};

const AppFields = ({ form, pool }: { form: PoolForm; pool?: RunnerPool }) => (
	<div className="grid gap-4 sm:grid-cols-2">
		<FormField
			control={form.control}
			name="appId"
			render={({ field }) => (
				<FormItem>
					<FormLabel>App ID</FormLabel>
					<FormControl>
						<Input inputMode="numeric" {...field} />
					</FormControl>
					<FormMessage />
				</FormItem>
			)}
		/>
		<FormField
			control={form.control}
			name="appInstallationId"
			render={({ field }) => (
				<FormItem>
					<FormLabel>Installation ID</FormLabel>
					<FormControl>
						<Input inputMode="numeric" {...field} />
					</FormControl>
					<FormMessage />
				</FormItem>
			)}
		/>
		<FormField
			control={form.control}
			name="appPrivateKey"
			render={({ field }) => (
				<FormItem className="sm:col-span-2">
					<FormLabel>Private key</FormLabel>
					<FormControl>
						<Textarea
							rows={4}
							className="font-mono text-xs"
							placeholder={
								pool?.hasAppPrivateKey
									? "Unchanged"
									: "-----BEGIN RSA PRIVATE KEY-----"
							}
							{...field}
						/>
					</FormControl>
					<FormMessage />
				</FormItem>
			)}
		/>
	</div>
);

const ProviderField = ({ form }: { form: PoolForm }) => {
	const { data: providers } = api.github.githubProviders.useQuery();
	return (
		<FormField
			control={form.control}
			name="githubId"
			render={({ field }) => (
				<FormItem>
					<FormLabel>GitHub provider</FormLabel>
					<Select value={field.value} onValueChange={field.onChange}>
						<FormControl>
							<SelectTrigger>
								<SelectValue placeholder="Select a provider" />
							</SelectTrigger>
						</FormControl>
						<SelectContent>
							{providers?.map((provider) => (
								<SelectItem key={provider.githubId} value={provider.githubId}>
									{provider.gitProvider.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<FormDescription>
						Its GitHub App must also be granted the runner permission above.
					</FormDescription>
					<FormMessage />
				</FormItem>
			)}
		/>
	);
};

const AuthFields = ({ form, pool }: { form: PoolForm; pool?: RunnerPool }) => {
	const authType = useWatch({ control: form.control, name: "authType" });
	return (
		<>
			<FormField
				control={form.control}
				name="authType"
				render={({ field }) => (
					<FormItem>
						<FormLabel>Authentication</FormLabel>
						<Select value={field.value} onValueChange={field.onChange}>
							<FormControl>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
							</FormControl>
							<SelectContent>
								<SelectItem value="app">GitHub App (recommended)</SelectItem>
								<SelectItem value="provider">
									Dokploy GitHub provider
								</SelectItem>
								<SelectItem value="token">Fine-grained token</SelectItem>
							</SelectContent>
						</Select>
						<FormDescription>
							Needs "Self-hosted runners: read and write" on the organization,
							or "Administration: read and write" on the repository. Credentials
							stay encrypted in Dokploy and never reach the machines.
						</FormDescription>
					</FormItem>
				)}
			/>
			{authType === "token" && (
				<FormField
					control={form.control}
					name="token"
					render={({ field }) => (
						<FormItem>
							<FormLabel>Token</FormLabel>
							<FormControl>
								<Input
									type="password"
									autoComplete="off"
									placeholder={pool?.hasToken ? "Unchanged" : "github_pat_…"}
									{...field}
								/>
							</FormControl>
							<FormMessage />
						</FormItem>
					)}
				/>
			)}
			{authType === "app" && <AppFields form={form} pool={pool} />}
			{authType === "provider" && <ProviderField form={form} />}
		</>
	);
};

const RerunField = ({ form }: { form: PoolForm }) => (
	<FormField
		control={form.control}
		name="rerunInterruptedJobs"
		render={({ field }) => (
			<FormItem className="flex items-start justify-between gap-4 rounded-lg border p-3">
				<div className="space-y-1">
					<FormLabel>Re-run interrupted jobs</FormLabel>
					<FormDescription>
						When a machine crashes or is stopped with its jobs interrupted,
						their failed jobs are re-run once the run completes and land on the
						other machines (3 attempts at most). The token or App also needs
						"Actions: read and write".
					</FormDescription>
				</div>
				<FormControl>
					<Switch
						checked={field.value ?? true}
						onCheckedChange={field.onChange}
					/>
				</FormControl>
			</FormItem>
		)}
	/>
);

const AdvancedFields = ({
	form,
	pool,
}: {
	form: PoolForm;
	pool?: RunnerPool;
}) => (
	<Collapsible>
		<CollapsibleTrigger asChild>
			<Button type="button" variant="link" className="px-0">
				Advanced settings
			</Button>
		</CollapsibleTrigger>
		<CollapsibleContent className="grid gap-4 pt-2">
			<div className="grid gap-4 sm:grid-cols-2">
				<FormField
					control={form.control}
					name="runnerVersion"
					render={({ field }) => (
						<FormItem>
							<FormLabel>Runner version</FormLabel>
							<FormControl>
								<Input placeholder="Latest" {...field} />
							</FormControl>
							<FormDescription>
								Empty follows the latest actions/runner release (checked every 6
								hours, rolled out without interrupting jobs).
							</FormDescription>
							<FormMessage />
						</FormItem>
					)}
				/>
				<FormField
					control={form.control}
					name="apiUrl"
					render={({ field }) => (
						<FormItem>
							<FormLabel>GitHub API URL</FormLabel>
							<FormControl>
								<Input {...field} />
							</FormControl>
							<FormDescription>
								Change it for GitHub Enterprise Server.
							</FormDescription>
							<FormMessage />
						</FormItem>
					)}
				/>
				<FormField
					control={form.control}
					name="jobStartedHook"
					render={({ field }) => (
						<FormItem>
							<FormLabel>Job started hook</FormLabel>
							<FormControl>
								<Input
									placeholder="/opt/flots-ci-hooks/job-started.sh"
									{...field}
								/>
							</FormControl>
							<FormMessage />
						</FormItem>
					)}
				/>
				<FormField
					control={form.control}
					name="jobCompletedHook"
					render={({ field }) => (
						<FormItem>
							<FormLabel>Job completed hook</FormLabel>
							<FormControl>
								<Input
									placeholder="/opt/flots-ci-hooks/job-completed.sh"
									{...field}
								/>
							</FormControl>
							<FormMessage />
						</FormItem>
					)}
				/>
			</div>
			<FormField
				control={form.control}
				name="runnerEnv"
				render={({ field }) => (
					<FormItem>
						<FormLabel>Job environment</FormLabel>
						<FormControl>
							<Textarea
								rows={3}
								className="font-mono text-xs"
								placeholder={
									pool?.runnerEnvKeys.length
										? `Unchanged (${pool.runnerEnvKeys.join(", ")})`
										: "KEY=value"
								}
								{...field}
							/>
						</FormControl>
						<FormDescription>
							One KEY=value per line, given to every job. Stored encrypted.
						</FormDescription>
						<FormMessage />
					</FormItem>
				)}
			/>
		</CollapsibleContent>
	</Collapsible>
);

/** Mounted only while the dialog is open, so it starts from the saved pool. */
const PoolFormContent = ({
	pool,
	onDone,
}: {
	pool?: RunnerPool;
	onDone: () => void;
}) => {
	const utils = api.useUtils();
	const create = api.githubRunner.createPool.useMutation();
	const update = api.githubRunner.updatePool.useMutation();
	const test = api.githubRunner.testCredentials.useMutation();
	const form = useForm<FormValues>({
		defaultValues: defaults(pool),
		resolver: zodResolver(schema),
	});

	// Some fields are hidden depending on the scope and the authentication: name
	// the invalid one instead of failing silently.
	const reportInvalid = (errors: FieldErrors<FormValues>) => {
		const [field, error] = Object.entries(errors)[0] ?? [];
		if (field) toast.error(`${field}: ${error?.message ?? "invalid value"}`);
	};

	const onTest = async () => {
		if (!(await form.trigger())) {
			reportInvalid(form.formState.errors);
			return;
		}
		await test
			.mutateAsync({
				...toPoolInput(form.getValues(), pool),
				githubRunnerPoolId: pool?.githubRunnerPoolId ?? null,
			})
			.catch(() => undefined);
	};

	const onSubmit = async (values: FormValues) => {
		const input = toPoolInput(values, pool);
		try {
			if (pool) {
				await update.mutateAsync({
					...input,
					githubRunnerPoolId: pool.githubRunnerPoolId,
					// The stored environment is never sent back: empty keeps it.
					runnerEnv: values.runnerEnv || null,
				});
			} else {
				await create.mutateAsync(input);
			}
			await utils.githubRunner.overview.invalidate();
			toast.success(pool ? "Pool updated" : "Pool created");
			onDone();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Unable to save the pool",
			);
		}
	};

	const error = create.error ?? update.error;

	return (
		<>
			{error && <AlertBlock type="error">{error.message}</AlertBlock>}
			<Form {...form}>
				<form
					id="runner-pool-form"
					onSubmit={form.handleSubmit(onSubmit, reportInvalid)}
					className="grid gap-4"
				>
					<TargetFields form={form} pool={pool} />
					<AuthFields form={form} pool={pool} />
					<RerunField form={form} />
					<AdvancedFields form={form} pool={pool} />
				</form>
			</Form>
			{test.data && (
				<AlertBlock type="success">
					<span className="flex items-center gap-2">
						<CheckCircle2 className="size-4" />
						Connected: {test.data.runners} runner(s) registered,{" "}
						{test.data.online} online, runner group #{test.data.groupId}.
					</span>
				</AlertBlock>
			)}
			{test.error && <AlertBlock type="error">{test.error.message}</AlertBlock>}
			<DialogFooter className="gap-2">
				<Button
					type="button"
					variant="outline"
					onClick={onTest}
					disabled={test.isPending}
				>
					{test.isPending && <Loader2 className="size-4 animate-spin" />}
					Test connection
				</Button>
				<Button
					type="submit"
					form="runner-pool-form"
					disabled={create.isPending || update.isPending}
				>
					{pool ? "Save" : "Create"}
				</Button>
			</DialogFooter>
		</>
	);
};

export const HandlePool = ({ pool }: { pool?: RunnerPool }) => {
	const [open, setOpen] = useState(false);
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				{pool ? (
					<Button variant="ghost" size="icon" aria-label="Edit pool">
						<Pencil className="size-4" />
					</Button>
				) : (
					<Button>
						<PlusIcon className="size-4" />
						Create pool
					</Button>
				)}
			</DialogTrigger>
			<DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>
						{pool ? "Edit runner pool" : "Create a runner pool"}
					</DialogTitle>
					<DialogDescription>
						A pool registers ephemeral self-hosted runners for one GitHub
						organization or repository. Every job gets a fresh runner; caches
						stay on the machines.
					</DialogDescription>
				</DialogHeader>
				<PoolFormContent pool={pool} onDone={() => setOpen(false)} />
			</DialogContent>
		</Dialog>
	);
};
