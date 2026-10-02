import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/utils/api";

export function PreviewFirewallSettings({ serverId }: { serverId: string }) {
	const { data: server } = api.server.one.useQuery({ serverId });
	const { data } = api.server.previewFirewall.useQuery(
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
			setBlocked(data.policy.blockedAddresses.join("\n"));
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
				<Badge variant={data?.healthy ? "secondary" : "destructive"}>
					{data?.healthy ? "All agents healthy" : "Agents need attention"}
				</Badge>
			</div>
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
					placeholder="Production server public addresses"
				/>
			</div>
			<Button type="submit" disabled={mutation.isPending}>
				Apply firewall policy
			</Button>
		</form>
	);
}
