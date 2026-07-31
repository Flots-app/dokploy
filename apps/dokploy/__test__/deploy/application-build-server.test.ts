import {
	apiCreateApplication,
	apiDeployApplication,
	apiRedeployApplication,
} from "@dokploy/server/db/schema";
import {
	assertBuildServerAvailable,
	assertBuildServerSelection,
	getRunningBuildServerId,
	getSourceBuildServerId,
	isBuildServerOverridden,
	resolveBuildServerOverride,
} from "@dokploy/server/utils/builders/build-server";
import { describe, expect, it } from "vitest";

const stored = {
	buildServerId: "stored-server",
	buildRegistryId: "stored-registry",
};

describe("Application Build Server selection", () => {
	it("keeps the configured Build Server when no override is sent", () => {
		expect(resolveBuildServerOverride(stored)).toEqual(stored);
		expect(resolveBuildServerOverride(stored, {})).toEqual(stored);
		expect(
			resolveBuildServerOverride({
				buildServerId: null,
				buildRegistryId: null,
			}),
		).toEqual({ buildServerId: null, buildRegistryId: null });
	});

	it("uses the Build Server chosen for this deployment", () => {
		expect(
			resolveBuildServerOverride(stored, { buildServerId: "other-server" }),
		).toEqual({
			buildServerId: "other-server",
			buildRegistryId: "stored-registry",
		});
	});

	it("builds on the deploy server when the override is explicitly empty", () => {
		expect(resolveBuildServerOverride(stored, { buildServerId: null })).toEqual(
			{
				buildServerId: null,
				buildRegistryId: "stored-registry",
			},
		);
	});

	it("never moves the registry, which the deploy server pulls from", () => {
		expect(
			resolveBuildServerOverride(
				{ buildServerId: null, buildRegistryId: "stored-registry" },
				{ buildServerId: "other-server" },
			).buildRegistryId,
		).toBe("stored-registry");
		expect(
			resolveBuildServerOverride(
				{ buildServerId: null, buildRegistryId: null },
				{ buildServerId: "other-server" },
			),
		).toEqual({ buildServerId: "other-server", buildRegistryId: null });
	});

	it("detects whether a deployment carries an override", () => {
		expect(isBuildServerOverridden()).toBe(false);
		expect(isBuildServerOverridden({})).toBe(false);
		expect(isBuildServerOverridden({ buildServerId: undefined })).toBe(false);
		expect(isBuildServerOverridden({ buildServerId: null })).toBe(true);
		expect(isBuildServerOverridden({ buildServerId: "server-1" })).toBe(true);
	});
});

describe("Build Server holding the downloaded source", () => {
	const deployment = (
		createdAt: string,
		buildServerId: string | null,
		status = "done",
	) => ({ createdAt, buildServerId, status });

	it("is unknown until the application has deployed once", () => {
		expect(getSourceBuildServerId([])).toBeUndefined();
	});

	it("is the Build Server of the last deployment, not the configured one", () => {
		// Configured default is A, but a one-off deployment ran on B: the
		// checkout only exists on B, so a rebuild belongs there.
		expect(
			getSourceBuildServerId([
				deployment("2026-01-01T00:00:00.000Z", "server-a"),
				deployment("2026-01-02T00:00:00.000Z", "server-b"),
			]),
		).toBe("server-b");
	});

	it("is the deploy server when the last deployment built locally", () => {
		expect(
			getSourceBuildServerId([
				deployment("2026-01-02T00:00:00.000Z", null),
				deployment("2026-01-01T00:00:00.000Z", "server-a"),
			]),
		).toBeNull();
	});

	it("kills the build on the machine the running deployment was sent to", () => {
		expect(
			getRunningBuildServerId(
				[
					deployment("2026-01-01T00:00:00.000Z", "server-a"),
					deployment("2026-01-02T00:00:00.000Z", "server-b", "running"),
				],
				"deploy-server",
			),
		).toBe("server-b");
	});

	it("falls back to the last deployment, then to the deploy server", () => {
		expect(
			getRunningBuildServerId(
				[deployment("2026-01-02T00:00:00.000Z", "server-b")],
				"deploy-server",
			),
		).toBe("server-b");
		expect(
			getRunningBuildServerId(
				[deployment("2026-01-02T00:00:00.000Z", null, "running")],
				"deploy-server",
			),
		).toBe("deploy-server");
		expect(getRunningBuildServerId([], "deploy-server")).toBe("deploy-server");
		expect(getRunningBuildServerId([], null)).toBeNull();
	});
});

describe("Application Build Server authorization", () => {
	const organizationId = "org-1";
	const buildServer = {
		serverId: "server-1",
		organizationId,
		serverStatus: "active" as const,
		serverType: "build" as const,
		sshKeyId: "ssh-1",
	};
	const registry = { organizationId };
	const selection = {
		organizationId,
		accessibleServerIds: new Set(["server-1"]),
		server: buildServer,
		registry,
	};

	it("accepts an active build server the member can reach", () => {
		expect(() => assertBuildServerSelection(selection)).not.toThrow();
	});

	it("rejects servers outside the member's scope", () => {
		expect(() =>
			assertBuildServerSelection({
				...selection,
				accessibleServerIds: new Set<string>(),
			}),
		).toThrow("not authorized");
	});

	it("checks the server alone when a deployment picks one", () => {
		expect(() =>
			assertBuildServerAvailable({ organizationId, server: buildServer }),
		).not.toThrow();
		expect(() =>
			assertBuildServerAvailable({
				organizationId,
				server: { ...buildServer, organizationId: "org-2" },
			}),
		).toThrow("active Build Server");
		expect(() =>
			assertBuildServerAvailable({ organizationId, server: undefined }),
		).toThrow("active Build Server");
	});

	it("still rejects a stored Build Server that went inactive or lost its key", () => {
		const stored = { requireBuildServerType: false };
		expect(() =>
			assertBuildServerAvailable(
				{
					organizationId,
					server: { ...buildServer, serverStatus: "inactive" },
				},
				stored,
			),
		).toThrow("active Build Server");
		expect(() =>
			assertBuildServerAvailable(
				{ organizationId, server: { ...buildServer, sshKeyId: null } },
				stored,
			),
		).toThrow("active Build Server");
		// A configuration predating the serverType filter keeps deploying.
		expect(() =>
			assertBuildServerAvailable(
				{ organizationId, server: { ...buildServer, serverType: "deploy" } },
				stored,
			),
		).not.toThrow();
	});

	it("rejects deploy servers, inactive servers and foreign registries", () => {
		expect(() =>
			assertBuildServerSelection({
				...selection,
				server: { ...buildServer, serverType: "deploy" },
			}),
		).toThrow("active Build Server");
		expect(() =>
			assertBuildServerSelection({
				...selection,
				server: { ...buildServer, serverStatus: "inactive" },
			}),
		).toThrow("active Build Server");
		expect(() =>
			assertBuildServerSelection({
				...selection,
				server: { ...buildServer, sshKeyId: null },
			}),
		).toThrow("active Build Server");
		expect(() =>
			assertBuildServerSelection({
				...selection,
				registry: { organizationId: "org-2" },
			}),
		).toThrow("same organization");
	});
});

describe("Application Build Server API schemas", () => {
	it("accepts a Build Server chosen for a single deployment", () => {
		expect(
			apiDeployApplication.safeParse({
				applicationId: "app-1",
				buildServerId: "server-1",
			}).success,
		).toBe(true);
		expect(
			apiRedeployApplication.safeParse({
				applicationId: "app-1",
				buildServerId: null,
			}).success,
		).toBe(true);
	});

	it("keeps the application settings when no Build Server is sent", () => {
		const parsed = apiDeployApplication.parse({ applicationId: "app-1" });
		expect(parsed.buildServerId).toBeUndefined();
	});

	it("does not move the registry from a deployment", () => {
		const parsed = apiDeployApplication.parse({
			applicationId: "app-1",
			buildServerId: "server-1",
			buildRegistryId: "registry-1",
		});
		expect(parsed).not.toHaveProperty("buildRegistryId");
	});

	it("requires the Build Server and its registry together on creation", () => {
		expect(
			apiCreateApplication.safeParse({
				name: "app",
				environmentId: "env-1",
				buildServerId: "server-1",
				buildRegistryId: null,
			}).success,
		).toBe(false);
		expect(
			apiCreateApplication.safeParse({
				name: "app",
				environmentId: "env-1",
				buildRegistryId: "registry-1",
			}).success,
		).toBe(false);
	});

	it("creates an application with a Build Server", () => {
		expect(
			apiCreateApplication.safeParse({
				name: "app",
				environmentId: "env-1",
				buildServerId: "server-1",
				buildRegistryId: "registry-1",
			}).success,
		).toBe(true);
		expect(
			apiCreateApplication.safeParse({
				name: "app",
				environmentId: "env-1",
			}).success,
		).toBe(true);
	});
});
