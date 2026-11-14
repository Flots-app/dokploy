import {
	PROVIDER_NAMES,
	providerState,
} from "@dokploy/server/utils/github-runners/providers";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { type UseFormReturn, useFieldArray, useWatch } from "react-hook-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	FormControl,
	FormDescription,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { RunnerPool } from "./format";
import { NEW_PROVIDER_BUDGET, type PoolFormValues } from "./pool-form";

const DEFAULT_LABELS = {
	blacksmith: {
		labels: "blacksmith-2vcpu-ubuntu-2404-arm",
		x64Labels: "blacksmith-2vcpu-ubuntu-2404",
	},
	github: { labels: "ubuntu-24.04-arm", x64Labels: "ubuntu-24.04" },
} as const;

/** An id that tells providers apart in the chain (and their usage). */
const newId = () => crypto.randomUUID().slice(0, 8);

/** The providers the jobs go to, in order, while no machine of the pool takes them. */
export const ProvidersFields = ({
	form,
	pool,
}: {
	form: UseFormReturn<PoolFormValues>;
	pool?: RunnerPool;
}) => {
	const { fields, append, remove, move } = useFieldArray({
		control: form.control,
		name: "fallbackChain",
	});
	const chain = useWatch({ control: form.control, name: "fallbackChain" });
	const add = (kind: "blacksmith" | "github") =>
		append({
			id: newId(),
			kind,
			...DEFAULT_LABELS[kind],
			limited: true,
			...NEW_PROVIDER_BUDGET,
		});
	return (
		<div className="grid gap-3 sm:col-span-2">
			<div className="space-y-1">
				<FormLabel>Fallback providers</FormLabel>
				<FormDescription>
					Where the jobs go, in this order, while no machine of the pool takes
					them. A provider over its budget this month is skipped; with none
					left, the jobs stay on the pool and wait. Without providers, the jobs
					go to the fallback runners above, with no budget.
				</FormDescription>
			</div>
			{fields.map((field, index) => {
				const provider = chain?.[index];
				return (
					<div key={field.id} className="grid gap-3 rounded-lg border p-3">
						<div className="flex flex-wrap items-center justify-between gap-2">
							<span className="text-sm font-medium">
								{index + 1}. {PROVIDER_NAMES[provider?.kind ?? field.kind]}
							</span>
							<div className="flex gap-1">
								<Button
									type="button"
									variant="ghost"
									size="icon"
									disabled={index === 0}
									onClick={() => move(index, index - 1)}
									aria-label="Move up"
								>
									<ArrowUp className="size-4" />
								</Button>
								<Button
									type="button"
									variant="ghost"
									size="icon"
									disabled={index === fields.length - 1}
									onClick={() => move(index, index + 1)}
									aria-label="Move down"
								>
									<ArrowDown className="size-4" />
								</Button>
								<Button
									type="button"
									variant="ghost"
									size="icon"
									onClick={() => remove(index)}
									aria-label="Remove the provider"
								>
									<Trash2 className="size-4" />
								</Button>
							</div>
						</div>
						<div className="grid gap-3 sm:grid-cols-2">
							<FormField
								control={form.control}
								name={`fallbackChain.${index}.labels`}
								render={({ field: input }) => (
									<FormItem>
										<FormLabel>Runner</FormLabel>
										<FormControl>
											<Input className="font-mono" {...input} />
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>
							<FormField
								control={form.control}
								name={`fallbackChain.${index}.x64Labels`}
								render={({ field: input }) => (
									<FormItem>
										<FormLabel>Runner of the x86_64 jobs</FormLabel>
										<FormControl>
											<Input className="font-mono" {...input} />
										</FormControl>
									</FormItem>
								)}
							/>
						</div>
						<FormField
							control={form.control}
							name={`fallbackChain.${index}.limited`}
							render={({ field: input }) => (
								<FormItem className="flex items-center justify-between gap-4">
									<FormLabel>Monthly budget</FormLabel>
									<FormControl>
										<Switch
											checked={input.value}
											onCheckedChange={input.onChange}
										/>
									</FormControl>
								</FormItem>
							)}
						/>
						{provider?.limited && (
							<div className="grid gap-3 sm:grid-cols-4">
								{(
									[
										["freeMinutes", "Free minutes", 0, undefined],
										["pricePerMinute", "Price of a minute", 0, 100],
										["overspend", "Allowed overspend", 0, undefined],
										["warningPercent", "Warn at (%)", 1, 100],
									] as const
								).map(([key, label, min, max]) => (
									<FormField
										key={key}
										control={form.control}
										name={`fallbackChain.${index}.${key}`}
										render={({ field: input }) => (
											<FormItem>
												<FormLabel>{label}</FormLabel>
												<FormControl>
													<Input
														type="number"
														inputMode="decimal"
														step="any"
														min={min}
														max={max}
														value={input.value}
														onChange={(event) =>
															input.onChange(Number(event.target.value) || 0)
														}
														onBlur={input.onBlur}
													/>
												</FormControl>
											</FormItem>
										)}
									/>
								))}
								<FormDescription className="sm:col-span-4">
									Minutes of the provider&apos;s month (Blacksmith counts 2-vCPU
									minutes). Past the free minutes, each minute costs its price
									until the allowed overspend is spent; 0 stops at the free
									minutes. GitHub reports its own charges, used instead of the
									price.
								</FormDescription>
							</div>
						)}
					</div>
				);
			})}
			<div className="flex flex-wrap gap-2">
				<Button
					type="button"
					variant="outline"
					onClick={() => add("blacksmith")}
				>
					<Plus className="mr-1 size-4" /> Blacksmith
				</Button>
				<Button type="button" variant="outline" onClick={() => add("github")}>
					<Plus className="mr-1 size-4" /> GitHub-hosted
				</Button>
			</div>
			{chain?.some((provider) => provider.kind === "blacksmith") && (
				<div className="grid gap-3 sm:grid-cols-2">
					<FormField
						control={form.control}
						name="blacksmithOrganization"
						render={({ field }) => (
							<FormItem>
								<FormLabel>Blacksmith organization</FormLabel>
								<FormControl>
									<Input {...field} />
								</FormControl>
							</FormItem>
						)}
					/>
					<FormField
						control={form.control}
						name="blacksmithToken"
						render={({ field }) => (
							<FormItem>
								<FormLabel>Blacksmith token</FormLabel>
								<FormControl>
									<Input
										type="password"
										autoComplete="off"
										placeholder={
											pool?.hasBlacksmithToken
												? "Stored: leave empty to keep it"
												: ""
										}
										{...field}
									/>
								</FormControl>
								<FormDescription>
									Reads the usage of the organization (blacksmith usage).
								</FormDescription>
							</FormItem>
						)}
					/>
				</div>
			)}
			{chain?.some(
				(provider) => provider.kind === "github" && provider.limited,
			) && (
				<FormField
					control={form.control}
					name="billingToken"
					render={({ field }) => (
						<FormItem>
							<FormLabel>GitHub billing token (optional)</FormLabel>
							<FormControl>
								<Input
									type="password"
									autoComplete="off"
									placeholder={
										pool?.hasBillingToken
											? "Stored: leave empty to keep it"
											: ""
									}
									{...field}
								/>
							</FormControl>
							<FormDescription>
								Reads the billing usage of the owner. Empty: the pool&apos;s own
								credentials, which then need read access to its billing.
							</FormDescription>
						</FormItem>
					)}
				/>
			)}
		</div>
	);
};

const STATUS = {
	within: { label: "within budget", variant: "green" },
	warning: { label: "nears its budget", variant: "yellow" },
	exhausted: { label: "over budget", variant: "red" },
	unknown: { label: "usage unknown", variant: "blank" },
} as const;

/** The providers of the pool this month: usage, spend and where they stand. */
export const ProvidersUsage = ({ pool }: { pool: RunnerPool }) => {
	const chain = pool.fallbackChain ?? [];
	if (!pool.routingVariable || !chain.length) return null;
	const now = Date.now();
	return (
		<ul className="grid gap-1">
			{chain.map((provider, index) => {
				const state = providerState(
					provider,
					pool.fallbackUsage?.[provider.id],
					now,
				);
				return (
					<li key={provider.id} className="flex flex-wrap items-center gap-2">
						<span className="text-foreground">
							{index + 1}. {PROVIDER_NAMES[provider.kind]}
						</span>
						<Badge variant={STATUS[state.status].variant}>
							{STATUS[state.status].label}
						</Badge>
						{state.minutes !== null && (
							<span>
								{Math.round(state.minutes)}
								{state.limitMinutes !== null &&
									` / ${Math.round(state.limitMinutes)}`}{" "}
								minutes, {state.spend} past the free minutes,{" "}
								{state.projectedMinutes} expected by the end of the month
							</span>
						)}
						{!provider.budget && <span>no budget</span>}
						{state.reason && state.status !== "within" && (
							<span>{state.reason}</span>
						)}
					</li>
				);
			})}
		</ul>
	);
};
