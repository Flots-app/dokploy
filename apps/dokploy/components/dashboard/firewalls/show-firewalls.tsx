import {
	FIREWALL_OBJECT_LABELS,
	type FirewallRule,
} from "@dokploy/server/utils/firewall/rules";
import {
	Loader2,
	Pencil,
	Plus,
	Shield,
	ShieldAlert,
	ShieldCheck,
	ShieldEllipsis,
	Trash2,
	Unlink,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { AlertBlock } from "@/components/shared/alert-block";
import { DialogAction } from "@/components/shared/dialog-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { api } from "@/utils/api";
import { errorText } from "../github-runners/format";
import { AttachTargetDialog, type FirewallTargetType } from "./attach-firewall";
import { type FirewallRow, HandleFirewall } from "./handle-firewall";

const PROTOCOLS: Record<FirewallRule["protocol"], string> = {
	any: "All protocols",
	tcp: "TCP",
	udp: "UDP",
	icmp: "ICMP",
};

const peerText = (rule: FirewallRule) =>
	rule.peer.type === "object"
		? FIREWALL_OBJECT_LABELS[rule.peer.object]
		: rule.peer.addresses.join(", ");

const RulesTable = ({ firewall }: { firewall: FirewallRow }) => {
	const directions = (["outbound", "inbound"] as const).map((direction) => ({
		direction,
		policy:
			direction === "outbound"
				? firewall.outboundPolicy
				: firewall.inboundPolicy,
		rules: firewall.rules.filter((rule) => rule.direction === direction),
	}));
	return (
		<div className="grid gap-3 md:grid-cols-2">
			{directions.map(({ direction, policy, rules }) => (
				<div key={direction} className="rounded-lg border p-3 text-sm">
					<div className="mb-2 flex items-center justify-between gap-2">
						<span className="font-medium capitalize">{direction}</span>
						<Badge variant={policy === "deny" ? "default" : "outline"}>
							{policy === "deny" ? "denied" : "allowed"} unless a rule says
							otherwise
						</Badge>
					</div>
					{rules.length ? (
						<ol className="grid gap-1 text-xs">
							{rules.map((rule, index) => (
								<li key={rule.id} className="flex flex-wrap gap-x-2">
									<span className="text-muted-foreground">{index + 1}.</span>
									<span
										className={
											rule.action === "allow"
												? "text-green-600"
												: "text-destructive"
										}
									>
										{rule.action === "allow" ? "Allow" : "Deny"}
									</span>
									<span>
										{PROTOCOLS[rule.protocol]}
										{rule.ports ? ` ${rule.ports}` : ""}
									</span>
									<span className="text-muted-foreground">
										{direction === "outbound" ? "to" : "from"} {peerText(rule)}
									</span>
									{rule.description && (
										<span className="text-muted-foreground">
											· {rule.description}
										</span>
									)}
								</li>
							))}
						</ol>
					) : (
						<p className="text-xs text-muted-foreground">No rule.</p>
					)}
				</div>
			))}
		</div>
	);
};

const STATE_TEXT = {
	applied: "applied",
	applying: "being applied",
	error: "not applied",
	inactive: "applied once the machine runs",
} as const;

/** Where the rules stand on one machine, inside the card of the firewall. */
const MachineState = ({
	state,
	error,
}: {
	state: keyof typeof STATE_TEXT;
	error: string | null;
}) => {
	const Icon =
		state === "applied"
			? ShieldCheck
			: state === "error"
				? ShieldAlert
				: ShieldEllipsis;
	return (
		<span
			className={`inline-flex items-start gap-1 ${state === "error" ? "text-destructive" : "text-muted-foreground"}`}
		>
			<Icon className="mt-0.5 size-3.5 shrink-0" />
			{STATE_TEXT[state]}
			{error ? `: ${error}` : ""}
		</span>
	);
};

const DetachButton = ({
	target,
}: {
	target: { type: FirewallTargetType; id: string; name: string };
}) => {
	const utils = api.useUtils();
	const detach = api.firewall.detach.useMutation();
	return (
		<Button
			size="icon"
			variant="ghost"
			className="size-7"
			aria-label={`Detach ${target.name}`}
			disabled={detach.isPending}
			onClick={async () => {
				try {
					await detach.mutateAsync({
						target: { type: target.type, id: target.id },
					});
					await Promise.all([
						utils.firewall.list.invalidate(),
						utils.githubRunner.overview.invalidate(),
					]);
					toast.success(`${target.name} no longer uses this firewall`);
				} catch (error) {
					toast.error(errorText(error, "The firewall could not be detached"));
				}
			}}
		>
			{detach.isPending ? (
				<Loader2 className="size-3.5 animate-spin" />
			) : (
				<Unlink className="size-3.5" />
			)}
		</Button>
	);
};

const Targets = ({
	firewall,
	canUpdate,
}: {
	firewall: FirewallRow;
	canUpdate: boolean;
}) => {
	if (!firewall.targets.length) {
		return (
			<p className="text-sm text-muted-foreground">
				It applies to nothing yet.
			</p>
		);
	}
	return (
		<ul className="grid gap-2">
			{firewall.targets.map((target) => (
				<li
					key={`${target.type}:${target.id}`}
					className="rounded-lg border p-3"
				>
					<div className="flex items-center justify-between gap-2 text-sm">
						<span>
							<span className="text-muted-foreground">
								{target.type === "githubRunnerPool"
									? "Runner pool"
									: "Runner machine"}
							</span>{" "}
							<span className="font-medium">{target.name}</span>
						</span>
						{canUpdate && <DetachButton target={target} />}
					</div>
					{target.machines.length > 0 && (
						<ul className="mt-2 grid gap-1 text-xs">
							{target.machines.map((machine) => (
								<li key={machine.githubRunnerNodeId} className="flex gap-2">
									<span className="w-24 shrink-0 truncate">{machine.name}</span>
									<MachineState state={machine.state} error={machine.error} />
								</li>
							))}
						</ul>
					)}
				</li>
			))}
		</ul>
	);
};

const FirewallCard = ({
	firewall,
	canUpdate,
	canDelete,
}: {
	firewall: FirewallRow;
	canUpdate: boolean;
	canDelete: boolean;
}) => {
	const utils = api.useUtils();
	const remove = api.firewall.remove.useMutation();
	const [dialog, setDialog] = useState<"edit" | "attach" | null>(null);
	const notes = [
		...firewall.notes.macos.map((note) => `Macs: ${note}`),
		...firewall.notes.linux.map((note) => `Linux: ${note}`),
	];
	return (
		<Card className="bg-transparent">
			<CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
				<div className="space-y-1">
					<CardTitle className="flex items-center gap-2 text-lg">
						<Shield className="size-4" />
						{firewall.name}
					</CardTitle>
					{firewall.description && (
						<CardDescription>{firewall.description}</CardDescription>
					)}
				</div>
				<div className="flex shrink-0 gap-1">
					{canUpdate && (
						<>
							<Button
								size="sm"
								variant="outline"
								onClick={() => setDialog("attach")}
							>
								<Plus className="size-4" />
								Apply to…
							</Button>
							<Button
								size="icon"
								variant="ghost"
								aria-label="Edit"
								onClick={() => setDialog("edit")}
							>
								<Pencil className="size-4" />
							</Button>
						</>
					)}
					{canDelete && (
						<DialogAction
							title={`Delete ${firewall.name}?`}
							description="The pools and machines it applies to lose it: their jobs reach the network without this filtering."
							type="destructive"
							onClick={async () => {
								try {
									await remove.mutateAsync({ firewallId: firewall.firewallId });
									await Promise.all([
										utils.firewall.list.invalidate(),
										utils.githubRunner.overview.invalidate(),
									]);
									toast.success(`${firewall.name} deleted`);
								} catch (error) {
									toast.error(
										errorText(error, "The firewall could not be deleted"),
									);
								}
							}}
						>
							<Button size="icon" variant="ghost" aria-label="Delete">
								<Trash2 className="size-4 text-destructive" />
							</Button>
						</DialogAction>
					)}
				</div>
			</CardHeader>
			<CardContent className="grid gap-4">
				<RulesTable firewall={firewall} />
				<div className="grid gap-2">
					<p className="text-sm font-medium">Applies to</p>
					<Targets firewall={firewall} canUpdate={canUpdate} />
				</div>
				{notes.length > 0 && (
					<AlertBlock type="info">
						<ul className="grid gap-1">
							{notes.map((note) => (
								<li key={note}>{note}</li>
							))}
						</ul>
					</AlertBlock>
				)}
			</CardContent>
			<HandleFirewall
				firewall={firewall}
				open={dialog === "edit"}
				onOpenChange={(open) => setDialog(open ? "edit" : null)}
			/>
			<AttachTargetDialog
				firewall={firewall}
				open={dialog === "attach"}
				onOpenChange={(open) => setDialog(open ? "attach" : null)}
			/>
		</Card>
	);
};

export const ShowFirewalls = () => {
	const { data: permissions } = api.user.getPermissions.useQuery();
	const {
		data: firewalls,
		isPending,
		error,
	} = api.firewall.list.useQuery(undefined, { refetchInterval: 10_000 });
	const [creating, setCreating] = useState(false);
	const canCreate = Boolean(permissions?.firewall.create);
	const canUpdate = Boolean(permissions?.firewall.update);
	const canDelete = Boolean(permissions?.firewall.delete);

	return (
		<div className="w-full">
			<Card className="h-full bg-sidebar p-2.5 rounded-xl">
				<div className="rounded-xl bg-background shadow-md">
					<CardHeader className="flex flex-row items-start justify-between gap-4">
						<div className="space-y-1">
							<CardTitle className="flex items-center gap-2 text-xl">
								<Shield className="size-5" />
								Firewalls
							</CardTitle>
							<CardDescription>
								Filter the network traffic of your resources, like the firewalls
								of a cloud provider. GitHub runner pools and machines use them
								today: the jobs reach what the rules allow, and nothing else.
							</CardDescription>
						</div>
						{canCreate && (
							<Button onClick={() => setCreating(true)}>
								<Plus className="size-4" />
								Create firewall
							</Button>
						)}
					</CardHeader>
					<CardContent className="grid gap-4">
						{error && (
							<AlertBlock type="error">
								{errorText(error, "The firewalls could not be loaded")}
							</AlertBlock>
						)}
						{isPending && (
							<div className="flex items-center gap-2 text-sm text-muted-foreground">
								<Loader2 className="size-4 animate-spin" /> Loading
							</div>
						)}
						{firewalls?.length === 0 && (
							<div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
								No firewall yet. "Internet only" keeps the jobs of your runners
								away from your LAN, your tailnet, and your Dokploy server when
								it sits on a private address; add a rule denying "Dokploy
								server" to keep them off its public address too.
							</div>
						)}
						{firewalls?.map((firewall) => (
							<FirewallCard
								key={firewall.firewallId}
								firewall={firewall}
								canUpdate={canUpdate}
								canDelete={canDelete}
							/>
						))}
					</CardContent>
				</div>
			</Card>
			<HandleFirewall
				firewall={null}
				open={creating}
				onOpenChange={setCreating}
			/>
		</div>
	);
};
