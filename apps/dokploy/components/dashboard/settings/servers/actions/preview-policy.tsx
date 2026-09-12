import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api } from "@/utils/api";

export function PreviewWorkerPolicy({ serverId }: { serverId: string }) {
	const { data: servers } = api.server.all.useQuery();
	const [managerId, setManagerId] = useState("");
	const { data } = api.server.one.useQuery({ serverId });
	const utils = api.useUtils();
	const [previewOnly, setPreviewOnly] = useState(false);
	const [capacity, setCapacity] = useState(3);
	useEffect(() => {
		if (data) {
			setPreviewOnly(data.previewOnly);
			setCapacity(data.previewCapacity);
			setManagerId(data.swarmManagerId || "");
		}
	}, [data]);
	const mutation = api.server.updatePreviewPolicy.useMutation({
		onSuccess: async () => {
			await Promise.all([
				utils.server.one.invalidate({ serverId }),
				utils.server.all.invalidate(),
				utils.server.withSSHKey.invalidate(),
			]);
			toast.success("Preview worker settings saved");
		},
		onError: (error) => toast.error(error.message),
	});
	if (data?.serverType !== "deploy") return null;
	return (
		<form
			className="col-span-2 space-y-4 border-t pt-4"
			onSubmit={(event) => {
				event.preventDefault();
				mutation.mutate({
					serverId,
					previewOnly,
					previewCapacity: capacity,
					swarmManagerId: managerId || null,
				});
			}}
		>
			<div className="space-y-2">
				<Label htmlFor="preview-manager">Swarm manager</Label>
				<select
					id="preview-manager"
					className="h-10 w-full rounded-md border bg-background px-3"
					value={managerId}
					onChange={(event) => setManagerId(event.target.value)}
				>
					<option value="">This Dokploy controller</option>
					{servers
						?.filter(
							(item) =>
								item.serverId !== serverId &&
								item.serverType === "deploy" &&
								!item.previewOnly,
						)
						.map((item) => (
							<option key={item.serverId} value={item.serverId}>
								{item.name}
							</option>
						))}
				</select>
				<p className="text-sm text-muted-foreground">
					The server must already be a worker in this Swarm. Its node ID is
					detected through SSH when saving.
				</p>
			</div>
			<div className="flex items-center justify-between gap-4">
				<Label htmlFor="preview-only">
					Reserve this server for Compose previews
				</Label>
				<Switch
					id="preview-only"
					checked={previewOnly}
					onCheckedChange={setPreviewOnly}
				/>
			</div>
			<p className="text-sm text-muted-foreground">
				Reserved workers are excluded from regular service creation. Existing
				services must be moved first. Swarm placement also excludes this node
				from regular services.
			</p>
			<div className="space-y-2">
				<Label htmlFor="preview-capacity">
					Maximum simultaneous preview environments
				</Label>
				<Input
					id="preview-capacity"
					type="number"
					min={1}
					max={50}
					required
					value={capacity}
					onChange={(event) => setCapacity(Number(event.target.value))}
				/>
			</div>
			<Button type="submit" disabled={mutation.isPending}>
				Save preview settings
			</Button>
		</form>
	);
}
