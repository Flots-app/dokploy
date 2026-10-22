import {
	Loader2,
	ShieldAlert,
	ShieldCheck,
	ShieldEllipsis,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
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
import { errorText } from "../github-runners/format";

export type FirewallTargetType = "githubRunnerPool" | "githubRunnerNode";

/** The firewall a machine follows, as the runner overview reports it. */
export interface FirewallStatus {
	firewallId: string;
	name: string;
	inherited: boolean;
	state: "applied" | "applying" | "error" | "inactive";
	error: string | null;
}

const STATE_TEXT: Record<FirewallStatus["state"], string> = {
	applied: "applied",
	applying: "being applied",
	error: "not applied",
	inactive: "applied once the machine runs",
};

/** "Firewall Internet only (pool), applied" with its icon. */
export const FirewallStatusText = ({ status }: { status: FirewallStatus }) => {
	const Icon =
		status.state === "applied"
			? ShieldCheck
			: status.state === "error"
				? ShieldAlert
				: ShieldEllipsis;
	return (
		<span
			className={`inline-flex items-center gap-1 ${status.state === "error" ? "text-destructive" : ""}`}
			title={status.error ?? undefined}
		>
			<Icon className="size-3.5" />
			firewall {status.name}
			{status.inherited ? " (pool)" : ""}, {STATE_TEXT[status.state]}
		</span>
	);
};

const NONE = "__none__";

const useAttach = () => {
	const utils = api.useUtils();
	const attach = api.firewall.attach.useMutation();
	const detach = api.firewall.detach.useMutation();
	const save = async (
		target: { type: FirewallTargetType; id: string },
		firewallId: string | null,
	) => {
		if (firewallId) await attach.mutateAsync({ firewallId, target });
		else await detach.mutateAsync({ target });
		await Promise.all([
			utils.firewall.list.invalidate(),
			utils.githubRunner.overview.invalidate(),
		]);
	};
	return { save, pending: attach.isPending || detach.isPending };
};

/**
 * Picks the firewall of a runner pool or machine. A machine without one of
 * its own follows its pool's.
 */
export const FirewallTargetDialog = ({
	target,
	currentId,
	poolFirewallName,
	open,
	onOpenChange,
}: {
	target: { type: FirewallTargetType; id: string; name: string };
	/** Its own firewall; for a machine, null follows the pool. */
	currentId: string | null;
	/** Machines only: the firewall of the pool, null for none. */
	poolFirewallName?: string | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) => {
	const {
		data: firewalls,
		error,
		isPending,
	} = api.firewall.list.useQuery(undefined, { enabled: open });
	const [choice, setChoice] = useState(currentId ?? NONE);
	const { save, pending } = useAttach();
	const machine = target.type === "githubRunnerNode";
	const noneLabel = machine
		? `Same as the pool (${poolFirewallName ?? "no firewall"})`
		: "No firewall";

	const submit = async () => {
		try {
			await save(target, choice === NONE ? null : choice);
			toast.success(`Firewall of ${target.name} saved`);
			onOpenChange(false);
		} catch (cause) {
			toast.error(errorText(cause, "The firewall could not be changed"));
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Firewall of {target.name}</DialogTitle>
					<DialogDescription>
						What the jobs of {machine ? "this machine" : "this pool"} may reach.
						A machine takes no job until its firewall is in place.
					</DialogDescription>
				</DialogHeader>
				{error ? (
					<p className="text-sm text-destructive">
						{errorText(error, "The firewalls could not be loaded")}
					</p>
				) : (
					<div className="grid gap-2">
						<Label htmlFor="firewall-choice">Firewall</Label>
						<Select value={choice} onValueChange={setChoice}>
							<SelectTrigger id="firewall-choice" disabled={isPending}>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value={NONE}>{noneLabel}</SelectItem>
								{(firewalls ?? []).map((firewall) => (
									<SelectItem
										key={firewall.firewallId}
										value={firewall.firewallId}
									>
										{firewall.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<p className="text-xs text-muted-foreground">
							Create and edit firewalls on the{" "}
							<Link href="/dashboard/firewalls" className="underline">
								Firewalls
							</Link>{" "}
							page.
						</p>
					</div>
				)}
				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button onClick={submit} disabled={pending || Boolean(error)}>
						{pending && <Loader2 className="size-4 animate-spin" />}
						Save
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};

/** Attaches a firewall to a runner pool or machine, from the Firewalls page. */
export const AttachTargetDialog = ({
	firewall,
	open,
	onOpenChange,
}: {
	firewall: { firewallId: string; name: string };
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) => {
	const { data: targets, error } = api.firewall.targets.useQuery(undefined, {
		enabled: open,
	});
	const [choice, setChoice] = useState("");
	const { save, pending } = useAttach();
	const [type = "", id = ""] = choice.split(":");

	const submit = async () => {
		try {
			await save({ type: type as FirewallTargetType, id }, firewall.firewallId);
			toast.success(`${firewall.name} applies to it now`);
			setChoice("");
			onOpenChange(false);
		} catch (cause) {
			toast.error(errorText(cause, "The firewall could not be attached"));
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Apply {firewall.name}</DialogTitle>
					<DialogDescription>
						A pool passes it to its machines; a machine can have its own
						instead. It replaces the firewall the resource had.
					</DialogDescription>
				</DialogHeader>
				{error ? (
					<p className="text-sm text-destructive">
						{errorText(error, "The resources could not be loaded")}
					</p>
				) : (
					<div className="grid gap-2">
						<Label htmlFor="firewall-target">Resource</Label>
						<Select value={choice} onValueChange={setChoice}>
							<SelectTrigger id="firewall-target">
								<SelectValue placeholder="Pick a runner pool or machine" />
							</SelectTrigger>
							<SelectContent>
								<SelectGroup>
									<SelectLabel>GitHub runner pools</SelectLabel>
									{(targets?.pools ?? []).map((pool) => (
										<SelectItem
											key={pool.githubRunnerPoolId}
											value={`githubRunnerPool:${pool.githubRunnerPoolId}`}
										>
											{pool.name}
										</SelectItem>
									))}
								</SelectGroup>
								<SelectGroup>
									<SelectLabel>GitHub runner machines</SelectLabel>
									{(targets?.nodes ?? []).map((node) => (
										<SelectItem
											key={node.githubRunnerNodeId}
											value={`githubRunnerNode:${node.githubRunnerNodeId}`}
										>
											{node.name} ({node.platform === "macos" ? "Mac" : "Linux"}
											)
										</SelectItem>
									))}
								</SelectGroup>
							</SelectContent>
						</Select>
					</div>
				)}
				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button onClick={submit} disabled={!choice || pending}>
						{pending && <Loader2 className="size-4 animate-spin" />}
						Apply
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};
