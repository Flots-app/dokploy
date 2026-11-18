import { type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api, type RouterOutputs } from "@/utils/api";

type Firewall = RouterOutputs["server"]["previewFirewall"];
type Lists = {
	admins: string;
	blocked: string;
	joining: string;
	resolvers: string;
};

const addresses = (value: string) => value.split(/[\s,]+/).filter(Boolean);

function AddressList({
	id,
	label,
	value,
	onChange,
	placeholder,
	hint,
}: {
	id: string;
	label: string;
	value: string;
	onChange: (value: string) => void;
	placeholder: string;
	hint: ReactNode;
}) {
	return (
		<div className="space-y-2">
			<Label htmlFor={id}>{label}</Label>
			<Textarea
				id={id}
				value={value}
				onChange={(event) => onChange(event.target.value)}
				placeholder={placeholder}
			/>
			<p className="text-xs text-muted-foreground">{hint}</p>
		</div>
	);
}

function FirewallHealth({
	data,
	isLoading,
}: {
	data?: Firewall;
	isLoading: boolean;
}) {
	return (
		<>
			<div className="flex items-center justify-between gap-3">
				<h3 className="font-medium">Preview network firewall</h3>
				{isLoading || !data ? (
					<Badge variant="outline">Checking…</Badge>
				) : data.healthy ? (
					<Badge variant="secondary">All agents healthy</Badge>
				) : (
					<Badge variant="destructive">
						{data.configured ? "Agents need attention" : "Not installed"}
					</Badge>
				)}
			</div>
			{data?.reason && (
				<output className="block text-sm text-destructive">
					{data.reason}
				</output>
			)}
			{data?.agents && (
				<ul className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-3">
					{Object.entries(data.agents).map(([name, agent]) => (
						<li key={name}>
							<span className={agent.healthy ? "" : "text-destructive"}>
								{agent.healthy ? "●" : "○"} {name} agent
							</span>
							{agent.appliedAt && (
								<> · applied {agent.appliedAt.slice(11, 19)} UTC</>
							)}
						</li>
					))}
				</ul>
			)}
		</>
	);
}

export function PreviewFirewallSettings({ serverId }: { serverId: string }) {
	const { data: server } = api.server.one.useQuery({ serverId });
	const { data, isLoading } = api.server.previewFirewall.useQuery(
		{ serverId },
		{ enabled: !!server?.swarmNodeId, refetchInterval: 10000 },
	);
	const [lists, setLists] = useState<Lists>({
		admins: "",
		blocked: "",
		joining: "",
		resolvers: "",
	});
	const set = (key: keyof Lists) => (value: string) =>
		setLists((previous) => ({ ...previous, [key]: value }));
	const initialized = useRef<string | null>(null);
	const utils = api.useUtils();
	useEffect(() => {
		const policy = data?.policy;
		if (!policy || initialized.current === serverId) return;
		setLists({
			admins: policy.sshAdmins.join("\n"),
			blocked: (
				policy.operatorBlockedAddresses ?? policy.blockedAddresses
			).join("\n"),
			joining: (policy.operatorJoiningNodes ?? []).join("\n"),
			resolvers: (policy.operatorDnsResolvers ?? []).join("\n"),
		});
		initialized.current = serverId;
	}, [data, serverId]);
	const mutation = api.server.updatePreviewFirewall.useMutation({
		onSuccess: async () => {
			await utils.server.previewFirewall.invalidate({ serverId });
			toast.success(
				"Firewall policy saved; agents apply changes within ten seconds",
			);
		},
		onError: (error) => toast.error(error.message),
	});
	if (!server?.swarmNodeId) return null;
	return (
		<form
			className="col-span-2 space-y-4 border-t pt-4"
			onSubmit={(event) => {
				event.preventDefault();
				mutation.mutate({
					serverId,
					sshAdmins: addresses(lists.admins),
					blockedAddresses: addresses(lists.blocked),
					joiningNodes: addresses(lists.joining),
					dnsResolvers: addresses(lists.resolvers),
				});
			}}
		>
			<FirewallHealth data={data} isLoading={isLoading} />
			<p className="text-sm text-muted-foreground">
				Swarm control (2377), SSH and the preview proxy are limited to the
				manager; gossip and overlay traffic (7946, 4789) are allowed from every
				node of the cluster. Preview workloads cannot initiate connections to
				private networks or cloud metadata. The firewall agents must be healthy
				before a preview can deploy.
			</p>
			<AddressList
				id="preview-ssh-admins"
				label="Additional SSH administrator IPv4 addresses"
				value={lists.admins}
				onChange={set("admins")}
				placeholder="One Tailscale address per line"
				hint="The manager always retains SSH access. These addresses only gain access to the dedicated SSH port."
			/>
			<AddressList
				id="preview-blocked-addresses"
				label="Additional destination IPv4 addresses to block"
				value={lists.blocked}
				onChange={set("blocked")}
				placeholder="Production databases, internal APIs, the worker host's public address"
				hint="Private, tailnet, link-local (cloud metadata) and multicast ranges are always blocked, and so is every server of this organization. Add the worker host's own public address here: Dokploy only knows its Swarm address."
			/>
			<AddressList
				id="preview-joining-nodes"
				label="Nodes about to join the Swarm"
				value={lists.joining}
				onChange={set("joining")}
				placeholder="Address a new node will join from"
				hint="The manager only accepts Swarm traffic from nodes already in `docker node ls`. List a new node here and apply before running `docker swarm join`; it can be removed once the node is listed."
			/>
			<AddressList
				id="preview-dns-resolvers"
				label="Private DNS resolvers for PR builds"
				value={lists.resolvers}
				onChange={set("resolvers")}
				placeholder="e.g. a cloud VPC resolver"
				hint="Allowed on port 53 only. Needed when the network blocks public DNS: the worker's Docker hides its upstream resolvers, so Dokploy cannot detect them."
			/>
			<Button type="submit" disabled={mutation.isPending}>
				Apply firewall policy
			</Button>
		</form>
	);
}
