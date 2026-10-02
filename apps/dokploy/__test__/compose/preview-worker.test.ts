import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findServer: vi.fn(), getDocker: vi.fn() }));
vi.mock("@dokploy/server/services/server", () => ({
	findServerById: mocks.findServer,
}));
vi.mock("@dokploy/server/utils/servers/remote-docker", () => ({
	getRemoteDocker: mocks.getDocker,
}));

import {
	configurePreviewWorker,
	REGULAR_NODE_CONSTRAINT,
} from "@dokploy/server/services/preview-worker";

describe("preview worker reservation never rolls existing services", () => {
	let update: ReturnType<typeof vi.fn>;
	let manager: any;
	beforeEach(() => {
		vi.clearAllMocks();
		update = vi.fn();
		const node = {
			inspect: vi.fn().mockResolvedValue({
				Version: { Index: 3 },
				Spec: {
					Role: "worker",
					Availability: "pause",
					Labels: { existing: "kept" },
				},
				Status: { State: "ready" },
			}),
			update,
		};
		manager = {
			info: vi.fn().mockResolvedValue({ Swarm: { ControlAvailable: true } }),
			getNode: vi.fn().mockReturnValue(node),
			listServices: vi.fn(),
			getService: vi.fn(),
		};
		mocks.findServer.mockResolvedValue({ sshKeyId: "key" });
		mocks.getDocker.mockImplementation(async (id) =>
			id === "worker"
				? {
						info: async () => ({
							Swarm: { NodeID: "node", ControlAvailable: false },
						}),
					}
				: manager,
		);
	});
	it("rejects an unprotected existing service before any mutation", async () => {
		manager.listServices.mockResolvedValue([
			{ ID: "prod", Spec: { Name: "production", TaskTemplate: {} } },
		]);
		await expect(
			configurePreviewWorker("worker", "manager", true),
		).rejects.toThrow("No existing service was changed");
		expect(update).not.toHaveBeenCalled();
		expect(manager.getService).not.toHaveBeenCalled();
	});
	it("labels and activates only the worker when all existing services exclude it", async () => {
		manager.listServices.mockResolvedValue([
			{
				ID: "prod",
				Spec: {
					TaskTemplate: {
						Placement: { Constraints: ["node.role == manager"] },
					},
				},
			},
			{
				ID: "stage",
				Spec: {
					TaskTemplate: {
						Placement: { Constraints: [REGULAR_NODE_CONSTRAINT] },
					},
				},
			},
		]);
		await expect(
			configurePreviewWorker("worker", "manager", true),
		).resolves.toBe("node");
		expect(update).toHaveBeenCalledExactlyOnceWith({
			version: 3,
			Role: "worker",
			Availability: "active",
			Labels: { existing: "kept", "com.dokploy.preview-only": "true" },
		});
		expect(manager.getService).not.toHaveBeenCalled();
	});
});
