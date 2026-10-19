import { runsOnExpression } from "@dokploy/server/utils/github-runners/routing";
import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { Pencil, PlusIcon } from "lucide-react";
import { useState } from "react";
import { type FieldErrors, type UseFormReturn, useForm } from "react-hook-form";
import { toast } from "sonner";
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
import { labelFromName, parseGithubTarget } from "./github-links";
import { AccessFields, RunnerGroupField, Step } from "./pool-access";
import {
	type PoolFormValues,
	poolFormDefaults,
	poolFormSchema,
	toPoolInput,
} from "./pool-form";
import { RoutingFields } from "./pool-routing";

type PoolForm = UseFormReturn<PoolFormValues>;

/** Until edited, the name follows the owner and the labels follow the name. */
const fillName = (form: PoolForm, name: string) => {
	if (!form.getFieldState("name").isDirty) form.setValue("name", name);
	fillLabels(form, form.getValues("name"));
};

const fillLabels = (form: PoolForm, name: string) => {
	if (!form.getFieldState("labels").isDirty) {
		form.setValue("labels", labelFromName(name));
	}
};

/** Step 1: the organization or repository whose jobs the machines run. */
const TargetFields = ({
	form,
	pool,
	onTargetChange,
}: {
	form: PoolForm;
	pool?: RunnerPool;
	onTargetChange: () => void;
}) => {
	const scope = form.watch("scope");
	// The GitHub target of a pool with machines cannot change.
	const locked = Boolean(pool?.nodes.length);
	const onOwner = (value: string) => {
		// A pasted "owner/repository" or GitHub URL fills both fields.
		const target = value.includes("/")
			? parseGithubTarget(value)
			: { owner: value, repository: null };
		form.setValue("owner", target.owner, { shouldDirty: true });
		if (target.repository) {
			form.setValue("scope", "repository");
			form.setValue("repository", target.repository, { shouldDirty: true });
		}
		if (!pool) fillName(form, target.repository ?? target.owner);
		onTargetChange();
	};
	return (
		<div className="grid gap-4 sm:grid-cols-2">
			<FormField
				control={form.control}
				name="scope"
				render={({ field }) => (
					<FormItem>
						<FormLabel>Jobs of</FormLabel>
						<Select
							value={field.value}
							onValueChange={(value) => {
								field.onChange(value);
								onTargetChange();
							}}
							disabled={locked}
						>
							<FormControl>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
							</FormControl>
							<SelectContent>
								<SelectItem value="organization">
									An organization (all its repositories)
								</SelectItem>
								<SelectItem value="repository">One repository</SelectItem>
							</SelectContent>
						</Select>
						<FormMessage />
					</FormItem>
				)}
			/>
			<FormField
				control={form.control}
				name="owner"
				render={({ field }) => (
					<FormItem>
						<FormLabel>
							{scope === "organization" ? "Organization" : "Owner"}
						</FormLabel>
						<FormControl>
							<Input
								placeholder="Flots-app or its GitHub URL"
								disabled={locked}
								{...field}
								onChange={(event) => onOwner(event.target.value)}
							/>
						</FormControl>
						<FormMessage />
					</FormItem>
				)}
			/>
			{scope === "repository" && (
				<FormField
					control={form.control}
					name="repository"
					render={({ field }) => (
						<FormItem className="sm:col-start-2">
							<FormLabel>Repository</FormLabel>
							<FormControl>
								<Input placeholder="monorepo" disabled={locked} {...field} />
							</FormControl>
							<FormMessage />
						</FormItem>
					)}
				/>
			)}
		</div>
	);
};

/** Step 3: how workflows reach the machines. */
const TargetingFields = ({
	form,
	pool,
	access,
}: {
	form: PoolForm;
	pool?: RunnerPool;
	access: Parameters<typeof RunnerGroupField>[0]["access"];
}) => {
	const [scope, labels, routingEnabled, routingVariable, fallbackLabels] =
		form.watch([
			"scope",
			"labels",
			"routingEnabled",
			"routingVariable",
			"fallbackLabels",
		]);
	const poolRunsOn = `[${["self-hosted", ...parseLabels(labels)].join(", ")}]`;
	const fallback = parseLabels(fallbackLabels);
	const runsOn = routingEnabled
		? runsOnExpression(
				routingVariable,
				fallback.length ? fallback : ["ubuntu-24.04"],
			)
		: poolRunsOn;
	return (
		<>
			{scope === "organization" && (
				<RunnerGroupField form={form} access={access} />
			)}
			<div className="grid gap-4 sm:grid-cols-2">
				<FormField
					control={form.control}
					name="name"
					render={({ field }) => (
						<FormItem>
							<FormLabel>Pool name</FormLabel>
							<FormControl>
								<Input
									placeholder="Flots CI"
									{...field}
									onChange={(event) => {
										field.onChange(event);
										if (!pool) fillLabels(form, event.target.value);
									}}
								/>
							</FormControl>
							<FormMessage />
						</FormItem>
					)}
				/>
				<FormField
					control={form.control}
					name="labels"
					render={({ field }) => (
						<FormItem>
							<FormLabel>Labels</FormLabel>
							<FormControl>
								<Input placeholder="flots-ci" {...field} />
							</FormControl>
							<FormMessage />
						</FormItem>
					)}
				/>
			</div>
			<RoutingFields form={form} />
			<div className="grid gap-1 rounded-md bg-muted p-3 text-xs">
				<span className="text-muted-foreground">
					Workflows send their jobs to these machines with:
				</span>
				<code className="break-all font-mono">runs-on: {runsOn}</code>
				{routingEnabled && (
					<span className="text-muted-foreground">
						The variable holds <code>{poolRunsOn}</code> while a runner of the
						pool is ON, and the fallback otherwise.
					</span>
				)}
				{!parseLabels(labels).length && (
					<span className="text-orange-600 dark:text-orange-500">
						Without a label, every self-hosted job of the{" "}
						{scope === "organization" ? "organization" : "repository"} can land
						on these machines.
					</span>
				)}
			</div>
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
						other machines (3 attempts at most). Uses the "Actions" permission
						the GitHub links above include.
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
	const form = useForm<PoolFormValues>({
		defaultValues: poolFormDefaults(pool),
		resolver: zodResolver(poolFormSchema),
	});

	// Some fields are hidden depending on the scope and the authentication: name
	// the invalid one instead of failing silently.
	const reportInvalid = (errors: FieldErrors<PoolFormValues>) => {
		const [field, error] = Object.entries(errors)[0] ?? [];
		if (field) toast.error(`${field}: ${error?.message ?? "invalid value"}`);
	};

	const onCheck = async () => {
		if (!(await form.trigger(["owner", "repository"]))) return;
		await test
			.mutateAsync({
				...toPoolInput(form.getValues(), pool),
				githubRunnerPoolId: pool?.githubRunnerPoolId ?? null,
			})
			.catch(() => undefined);
	};

	const onSubmit = async (values: PoolFormValues) => {
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
			toast.success(
				pool ? "Pool updated" : "Pool created: now add a machine to it",
			);
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
			<Form {...form}>
				<form
					id="runner-pool-form"
					onSubmit={form.handleSubmit(onSubmit, reportInvalid)}
					className="grid gap-6"
				>
					<Step number={1} title="Where the jobs come from">
						<TargetFields
							form={form}
							pool={pool}
							onTargetChange={() => test.reset()}
						/>
					</Step>
					<Step
						number={2}
						title="Give Dokploy access"
						description="Dokploy registers a fresh runner for each job and removes it afterwards."
					>
						<AccessFields
							form={form}
							pool={pool}
							access={test.data}
							checking={test.isPending}
							checkError={test.error?.message ?? null}
							onCheck={() => void onCheck()}
							onReset={() => test.reset()}
						/>
					</Step>
					<Step number={3} title="How workflows reach the machines">
						<TargetingFields form={form} pool={pool} access={test.data} />
					</Step>
					<div className="grid gap-2">
						<RerunField form={form} />
						<AdvancedFields form={form} pool={pool} />
					</div>
				</form>
			</Form>
			{error && <AlertBlock type="error">{error.message}</AlertBlock>}
			<DialogFooter>
				<Button
					type="submit"
					form="runner-pool-form"
					disabled={create.isPending || update.isPending}
				>
					{create.isPending || update.isPending
						? "Checking access…"
						: pool
							? "Save"
							: "Create pool"}
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
						A pool runs the GitHub Actions jobs of an organization or a
						repository on your machines. Every job gets a fresh runner; caches
						stay on the machines.
					</DialogDescription>
				</DialogHeader>
				<PoolFormContent pool={pool} onDone={() => setOpen(false)} />
			</DialogContent>
		</Dialog>
	);
};
