import { getAccessibleServerIds } from "@dokploy/server/services/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.hoisted(() => ({
	query: {
		server: { findMany: vi.fn() },
		member: { findFirst: vi.fn() },
	},
}));

vi.mock("@dokploy/server/db", () => ({ db: mockDb }));

const ORG_ID = "org-1";
const session = { userId: "user-1", activeOrganizationId: ORG_ID };
const orgServers = [
	{ serverId: "srv-a" },
	{ serverId: "srv-b" },
	{ serverId: "srv-c" },
];

beforeEach(() => {
	vi.clearAllMocks();
	mockDb.query.server.findMany.mockResolvedValue(orgServers);
});

describe("getAccessibleServerIds", () => {
	it.each(["owner", "admin"])("gives a %s every server", async (role) => {
		mockDb.query.member.findFirst.mockResolvedValue({
			role,
			accessedServers: ["srv-a"],
		});

		const ids = await getAccessibleServerIds(session);

		expect(ids).toEqual(new Set(["srv-a", "srv-b", "srv-c"]));
	});

	it("keeps every server for a member without any assignment", async () => {
		// Existing members must not lose access when assignments get enabled.
		mockDb.query.member.findFirst.mockResolvedValue({
			role: "member",
			accessedServers: [],
		});

		const ids = await getAccessibleServerIds(session);

		expect(ids).toEqual(new Set(["srv-a", "srv-b", "srv-c"]));
	});

	it("keeps every server when the member record is missing", async () => {
		mockDb.query.member.findFirst.mockResolvedValue(null);

		const ids = await getAccessibleServerIds(session);

		expect(ids).toEqual(new Set(["srv-a", "srv-b", "srv-c"]));
	});

	it("restricts a member to the servers an admin assigned", async () => {
		mockDb.query.member.findFirst.mockResolvedValue({
			role: "member",
			accessedServers: ["srv-b"],
		});

		const ids = await getAccessibleServerIds(session);

		expect(ids).toEqual(new Set(["srv-b"]));
	});
});
