import type { UseFormReturn } from "react-hook-form";
import {
	FormControl,
	FormDescription,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Switch } from "@/components/ui/switch";
import type { PoolFormValues } from "./pool-form";
import { NumberInput } from "./shared";

/**
 * How the pool keeps taking jobs while it updates, and while Dokploy is down:
 * machines updated a few at a time after a canary, and the reserve each
 * machine arms itself with when no controller answers.
 */
export const ResilienceFields = ({
	form,
}: {
	form: UseFormReturn<PoolFormValues>;
}) => (
	<div className="grid gap-4 sm:grid-cols-2">
		<FormField
			control={form.control}
			name="rolloutPolicy.maxUnavailable"
			render={({ field }) => (
				<FormItem>
					<FormLabel>Machines updated at a time</FormLabel>
					<FormControl>
						<NumberInput
							min={1}
							max={32}
							value={field.value}
							onValueChange={field.onChange}
						/>
					</FormControl>
					<FormDescription>
						Runner, runtime and OS updates: the other machines keep taking jobs.
					</FormDescription>
					<FormMessage />
				</FormItem>
			)}
		/>
		<FormField
			control={form.control}
			name="autonomyReserve"
			render={({ field }) => (
				<FormItem>
					<FormLabel>Jobs per slot without Dokploy</FormLabel>
					<FormControl>
						<NumberInput
							min={0}
							max={10}
							value={field.value}
							onValueChange={field.onChange}
						/>
					</FormControl>
					<FormDescription>
						Each machine keeps this many runner registrations per slot and arms
						itself with them when Dokploy stops answering (up to 20 hours). 0
						turns it off.
					</FormDescription>
					<FormMessage />
				</FormItem>
			)}
		/>
		<FormField
			control={form.control}
			name="rolloutPolicy.canary"
			render={({ field }) => (
				<FormItem className="flex flex-row items-start justify-between gap-4 rounded-lg border p-3 sm:col-span-2">
					<div className="space-y-0.5">
						<FormLabel>Canary first</FormLabel>
						<FormDescription>
							A new runner or runtime release goes to one machine first; the
							others follow once it ran it for 10 minutes with its runners
							online. A failure pauses the rollout until you resume it.
						</FormDescription>
					</div>
					<FormControl>
						<Switch checked={field.value} onCheckedChange={field.onChange} />
					</FormControl>
				</FormItem>
			)}
		/>
	</div>
);
