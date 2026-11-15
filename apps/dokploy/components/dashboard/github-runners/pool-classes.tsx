import { PROVIDER_NAMES } from "@dokploy/server/utils/github-runners/providers";
import { Plus, Trash2 } from "lucide-react";
import { type UseFormReturn, useFieldArray } from "react-hook-form";
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
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import type { RunnerPool } from "./format";
import type { PoolFormValues } from "./pool-form";

/** Classes of jobs with a routing variable of their own, e.g. heavy Android builds. */
export const JobClassesFields = ({
	form,
	variable,
}: {
	form: UseFormReturn<PoolFormValues>;
	variable: string;
}) => {
	const { fields, append, remove } = useFieldArray({
		control: form.control,
		name: "jobClasses",
	});
	return (
		<div className="grid gap-3 sm:col-span-2">
			<div className="space-y-1">
				<FormLabel>Job classes</FormLabel>
				<FormDescription>
					Jobs that need runners of their own when they leave the pool (larger
					ones for Android builds, say) read {variable || "the variable"}
					_&lt;SUFFIX&gt;: the pool&apos;s runners of their architecture while
					one is ON, otherwise the runner each provider names for the class, or
					the class&apos;s own fallback without providers.
				</FormDescription>
			</div>
			{fields.map((field, index) => (
				<div
					key={field.id}
					className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[1fr_1fr_2fr_auto]"
				>
					<FormField
						control={form.control}
						name={`jobClasses.${index}.suffix`}
						render={({ field: input }) => (
							<FormItem>
								<FormLabel>Suffix</FormLabel>
								<FormControl>
									<Input
										className="font-mono"
										placeholder="ANDROID"
										{...input}
										onChange={(event) =>
											input.onChange(event.target.value.toUpperCase())
										}
									/>
								</FormControl>
								<FormMessage />
							</FormItem>
						)}
					/>
					<FormField
						control={form.control}
						name={`jobClasses.${index}.arch`}
						render={({ field: input }) => (
							<FormItem>
								<FormLabel>On the pool</FormLabel>
								<Select value={input.value} onValueChange={input.onChange}>
									<FormControl>
										<SelectTrigger>
											<SelectValue />
										</SelectTrigger>
									</FormControl>
									<SelectContent>
										<SelectItem value="native">Native runners</SelectItem>
										<SelectItem value="x64">x86_64 runners</SelectItem>
									</SelectContent>
								</Select>
							</FormItem>
						)}
					/>
					<FormField
						control={form.control}
						name={`jobClasses.${index}.fallbackLabels`}
						render={({ field: input }) => (
							<FormItem>
								<FormLabel>Fallback runner</FormLabel>
								<FormControl>
									<Input
										className="font-mono"
										placeholder="ubuntu-24.04"
										{...input}
									/>
								</FormControl>
								<FormMessage />
							</FormItem>
						)}
					/>
					<Button
						type="button"
						variant="ghost"
						size="icon"
						className="self-end"
						onClick={() => remove(index)}
						aria-label="Remove the class"
					>
						<Trash2 className="size-4" />
					</Button>
				</div>
			))}
			<div>
				<Button
					type="button"
					variant="outline"
					onClick={() =>
						append({
							id: crypto.randomUUID().slice(0, 8),
							suffix: "",
							arch: "native",
							fallbackLabels: "ubuntu-24.04",
						})
					}
				>
					<Plus className="mr-1 size-4" /> Job class
				</Button>
			</div>
		</div>
	);
};

/** Where the jobs of each class go right now. */
export const ClassRoutingLines = ({ pool }: { pool: RunnerPool }) => {
	if (!pool.routingVariable) return null;
	return (
		<>
			{(pool.jobClasses ?? []).map((jobClass) => {
				const routing = pool.classRouting?.[jobClass.id];
				if (!routing) return null;
				const line = routing.error
					? {
							tone: "bg-red-500",
							text: `Cannot update ${routing.variable}: ${routing.error}`,
						}
					: routing.target === "pool"
						? {
								tone: "bg-emerald-500",
								text: `${jobClass.suffix} jobs go to the ${jobClass.arch === "x64" ? "x86_64 " : ""}runners of these machines`,
							}
						: {
								tone: "bg-orange-500",
								text: `${jobClass.suffix} jobs go to ${routing.value} (${routing.provider ? PROVIDER_NAMES[routing.provider] : "GitHub-hosted"})`,
							};
				return (
					<span
						key={jobClass.id}
						className="flex items-start gap-2 text-sm text-foreground"
					>
						<span
							className={`mt-1.5 size-2 shrink-0 rounded-full ${line.tone}`}
						/>
						{line.text}
					</span>
				);
			})}
		</>
	);
};
