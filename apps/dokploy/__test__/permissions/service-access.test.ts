import { beforeEach, describe, expect, it, vi } from "vitest";

const mockMemberData = (
	role: string,
	accessedServices: string[] = [],
	accessedProjects: string[] = [],
) => ({
	id: "member-1",
	role,
	userId: "user-1",
	organizationId: "org-1",
	accessedProjects,
	accessedServices,
	accessedEnvironments: [] as string[],
	canCreateProjects: false,
	canDeleteProjects: false,
	canCreateServices: false,
	canDeleteServices: false,
	canCreateEnvironments: false,
	canDeleteEnvironments: false,
	canAccessToTraefikFiles: false,
	canAccessToDocker: false,
	canAccessToAPI: false,
	canAccessToSSHKeys: false,
	canAccessToGitProviders: false,
	user: { id: "user-1", email: "test@test.com" },
});

let previewToReturn:
	| {
			previewParentId: string;
			environment: { project: { organizationId: string } };
	  }
	| undefined;

let memberToReturn: ReturnType<typeof mockMemberData> =
	mockMemberData("member");

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			compose: { findFirst: vi.fn(() => Promise.resolve(previewToReturn)) },
			member: {
				findFirst: vi.fn(() => Promise.resolve(memberToReturn)),
				findMany: vi.fn(() => Promise.resolve([])),
			},
			organizationRole: {
				findFirst: vi.fn(),
				findMany: vi.fn(() => Promise.resolve([])),
			},
		},
	},
}));

vi.mock("@dokploy/server/services/proprietary/license-key", () => ({
	hasValidLicense: vi.fn(() => Promise.resolve(false)),
}));

const { checkServicePermissionAndAccess, checkServiceAccess } = await import(
	"@dokploy/server/services/permission"
);

const ctx = {
	user: { id: "user-1" },
	session: { activeOrganizationId: "org-1" },
};

beforeEach(() => {
	vi.clearAllMocks();
	previewToReturn = undefined;
});

describe("checkServicePermissionAndAccess", () => {
	it("owner bypasses accessedServices check", async () => {
		memberToReturn = mockMemberData("owner", []);
		await expect(
			checkServicePermissionAndAccess(ctx, "service-123", {
				deployment: ["read"],
			}),
		).resolves.toBeUndefined();
	});

	it("admin bypasses accessedServices check", async () => {
		memberToReturn = mockMemberData("admin", []);
		await expect(
			checkServicePermissionAndAccess(ctx, "service-123", {
				backup: ["create"],
			}),
		).resolves.toBeUndefined();
	});

	it("member with access to service passes", async () => {
		memberToReturn = mockMemberData("member", ["service-123"]);
		await expect(
			checkServicePermissionAndAccess(ctx, "service-123", {
				deployment: ["read"],
			}),
		).resolves.toBeUndefined();
	});

	it("member WITHOUT access to service fails", async () => {
		memberToReturn = mockMemberData("member", ["other-service"]);
		await expect(
			checkServicePermissionAndAccess(ctx, "service-123", {
				deployment: ["read"],
			}),
		).rejects.toThrow("You don't have access to this service");
	});

	it("member with empty accessedServices fails", async () => {
		memberToReturn = mockMemberData("member", []);
		await expect(
			checkServicePermissionAndAccess(ctx, "service-123", {
				domain: ["delete"],
			}),
		).rejects.toThrow("You don't have access to this service");
	});
});

describe("checkServiceAccess", () => {
	it("member with service access passes read check", async () => {
		memberToReturn = mockMemberData("member", ["app-1"]);
		await expect(
			checkServiceAccess(ctx, "app-1", "read"),
		).resolves.toBeUndefined();
	});

	it("member without service access fails read check", async () => {
		memberToReturn = mockMemberData("member", []);
		await expect(checkServiceAccess(ctx, "app-1", "read")).rejects.toThrow(
			"You don't have access to this service",
		);
	});

	it("owner bypasses all access checks", async () => {
		memberToReturn = mockMemberData("owner", [], []);
		await expect(
			checkServiceAccess(ctx, "project-1", "create"),
		).resolves.toBeUndefined();
	});
});

describe("managed Compose preview permissions", () => {
	beforeEach(() => {
		previewToReturn = {
			previewParentId: "source-compose",
			environment: { project: { organizationId: "org-1" } },
		};
	});
	it("inherits read access from the source", async () => {
		memberToReturn = mockMemberData("member", ["source-compose"]);
		await expect(
			checkServiceAccess(ctx, "preview-compose", "read"),
		).resolves.toBeUndefined();
		await expect(
			checkServicePermissionAndAccess(ctx, "preview-compose", {
				deployment: ["read"],
			}),
		).resolves.toBeUndefined();
	});
	it("revokes preview reads when source access is revoked", async () => {
		memberToReturn = mockMemberData("member", ["preview-compose"]);
		await expect(
			checkServiceAccess(ctx, "preview-compose", "read"),
		).rejects.toThrow("access");
	});
	it("prevents direct mutations even for owners", async () => {
		memberToReturn = mockMemberData("owner");
		await expect(
			checkServicePermissionAndAccess(ctx, "preview-compose", {
				deployment: ["create"],
			}),
		).rejects.toThrow("source Compose Previews");
	});
	it("denies cross-organization preview reads even for owners", async () => {
		memberToReturn = mockMemberData("owner");
		if (previewToReturn)
			previewToReturn.environment.project.organizationId = "other-org";
		await expect(
			checkServiceAccess(ctx, "preview-compose", "read"),
		).rejects.toThrow("access");
	});
});
