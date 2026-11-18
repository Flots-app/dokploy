import { describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock("@dokploy/server/db", () => ({ db: { update: m.update } }));
vi.mock("@dokploy/server/services/server", () => ({
	assertServerAllowsRegularService: async (serverId: string | null) => {
		if (serverId === "preview-worker")
			throw new Error(
				"This server is reserved for Compose preview environments",
			);
	},
}));

import { setServiceServerId } from "@dokploy/server/utils/service-migration/service";

describe("server migration and preview-only workers", () => {
	it("never moves a regular service onto a worker that runs PR code", async () => {
		await expect(
			setServiceServerId("compose", "compose-1", "preview-worker"),
		).rejects.toThrow("reserved for Compose preview environments");
		expect(m.update).not.toHaveBeenCalled();
	});
});
