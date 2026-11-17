import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/utils/api";

export function PreviewFirewallSettings({ serverId }: { serverId: string }) {
	const { data: server } = api.server.one.useQuery({ serverId });
	const { data, isLoading } = api.server.previewFirewall.useQuery(
		{ serverId },
		{ enabled: !!server?.swarmNodeId, refetchInterval: 10000 },
	);
	const [admins, setAdmins] = useState("");
	const [blocked, setBlocked] = useState("");
	const initialized = useRef<string | null>(null);
	const utils = api.useUtils();
	useEffect(() => {
		if (data?.policy && initialized.current !== serverId) {
			setAdmins(data.policy.sshAdmins.join("\n"));
			setBlocked(
				(
					data.policy.operatorBlockedAddresses ?? data.policy.blockedAddresses
				).join("\n"),
			);
			initialized.current = serverId;
		}
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
	const addresses = (value: string) => value.split(/[\s,]+/).filter(Boolean);
	return (
		<form
			className="col-span-2 space-y-4 border-t pt-4"
			onSubmit={(event) => {
				event.preventDefault();
				mutation.mutate({
					serverId,
					sshAdmins: addresses(admins),
					blockedAddresses: addresses(blocked),
				});
			}}
		>
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
			<p className="text-sm text-muted-foreground">
				Swarm and proxy access is limited to the manager. Preview workloads
				cannot initiate connections to private networks or cloud metadata.
				Dockerized firewall agents must be installed and healthy before a
				preview can deploy.
			</p>
			<div className="space-y-2">
				<Label htmlFor="preview-ssh-admins">
					Additional SSH administrator IPv4 addresses
				</Label>
				<Textarea
					id="preview-ssh-admins"
					value={admins}
					onChange={(event) => setAdmins(event.target.value)}
					placeholder="One Tailscale address per line"
				/>
				<p className="text-xs text-muted-foreground">
					The manager always retains SSH access. These addresses only gain
					access to the dedicated SSH port.
				</p>
			</div>
			<div className="space-y-2">
				<Label htmlFor="preview-blocked-addresses">
					Additional destination IPv4 addresses to block
				</Label>
				<Textarea
					id="preview-blocked-addresses"
					value={blocked}
					onChange={(event) => setBlocked(event.target.value)}
					placeholder="Production databases, internal APIs, the worker host's public address"
				/>
				<p className="text-xs text-muted-foreground">
					Private, tailnet, link-local (cloud metadata) and multicast ranges are
					always blocked, and so is every server registered in Dokploy. Add the
					worker host's own public address here: Dokploy only knows its Swarm
					address.
				</p>
			</div>
			<Button type="submit" disabled={mutation.isPending}>
				Apply firewall policy
			</Button>
		</form>
	);
}
