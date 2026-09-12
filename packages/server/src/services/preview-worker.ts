import { getRemoteDocker } from "../utils/servers/remote-docker";
import { findServerById } from "./server";

export const PREVIEW_NODE_LABEL = "com.dokploy.preview-only";
export const REGULAR_NODE_CONSTRAINT = `node.labels.${PREVIEW_NODE_LABEL}!=true`;

/** Reserve only the worker after checking that existing services exclude it. */
export async function configurePreviewWorker(
	serverId: string,
	managerId: string | null,
	previewOnly: boolean,
) {
	const worker = await findServerById(serverId);
	const engine = await getRemoteDocker(serverId);
	const info = await engine.info();
	const nodeId = info.Swarm?.NodeID;
	if (!worker.sshKeyId || !nodeId || info.Swarm?.ControlAvailable)
		throw new Error("Select an SSH endpoint running a joined Swarm worker");
	const manager = await getRemoteDocker(managerId);
	const managerInfo = await manager.info();
	if (!managerInfo.Swarm?.ControlAvailable)
		throw new Error("The selected manager does not control a Swarm cluster");
	const node = manager.getNode(nodeId);
	const current = await node.inspect();
	if (current.Spec.Role !== "worker" || current.Status.State !== "ready")
		throw new Error(
			"The worker must be ready in the selected manager's cluster",
		);
	// Updating a service's placement can restart its tasks. Reservation must
	// never silently roll existing applications: require a safe cluster first.
	if (previewOnly) {
		for (const service of await manager.listServices()) {
			if (
				!service.ID ||
				!service.Spec ||
				service.Spec.Labels?.["com.dokploy.compose-preview"]
			)
				continue;
			const constraints =
				service.Spec.TaskTemplate?.Placement?.Constraints || [];
			if (
				constraints.includes(REGULAR_NODE_CONSTRAINT) ||
				constraints.some((constraint) =>
					/^node.role\s*==\s*manager$/.test(constraint),
				)
			)
				continue;
			throw new Error(
				`Service ${service.Spec.Name || service.ID} can run on this worker. Apply and persist the preview exclusion constraint during an approved deployment before reserving the worker. No existing service was changed.`,
			);
		}
	}
	await node.update({
		version: current.Version.Index,
		...current.Spec,
		Labels: {
			...current.Spec.Labels,
			[PREVIEW_NODE_LABEL]: String(previewOnly),
		},
		Availability: current.Spec.Availability === "drain" ? "drain" : "active",
	});
	return nodeId;
}
