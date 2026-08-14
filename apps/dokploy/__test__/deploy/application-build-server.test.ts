import {
	APPLICATION_DRAIN_NANOSECONDS,
	assertApplicationBuildServerDeploymentReady,
	assertApplicationBuildServerSelection,
	assertApplicationRuntimeServerSelection,
	getApplicationBuildPushCommand,
	getApplicationCancellationCheckCommand,
	getApplicationCancellationPath,
	getApplicationDeploymentImage,
	getApplicationRuntimePullCommand,
	getRollbackApplicationServiceCommand,
	getWaitApplicationServiceCommand,
} from "@dokploy/server/utils/builders/application-build-server";
import { getComposeRegistryLoginCommand } from "@dokploy/server/utils/builders/compose-build-server";
import { describe, expect, it } from "vitest";

const buildServer = {
	serverId: "build-1",
	organizationId: "org-1",
	serverType: "build" as const,
	serverStatus: "active" as const,
	sshKeyId: "ssh-1",
};

const registry = {
	registryId: "registry-1",
	registryName: "Registry",
	registryType: "selfHosted" as const,
	registryUrl: "registry.example.com",
	username: "builder",
	password: "secret-password",
	imagePrefix: "team",
	organizationId: "org-1",
	createdAt: "2026-08-14T00:00:00.000Z",
};

const readyApplication = {
	appName: "app-test",
	buildType: "dockerfile",
	sourceType: "github",
	serverId: "runtime-1",
	buildServerId: "build-1",
	buildRegistryId: "registry-1",
	healthCheckSwarm: { Test: ["CMD", "curl", "-f", "http://localhost/health"] },
	stopGracePeriodSwarm: APPLICATION_DRAIN_NANOSECONDS,
	ports: [],
	endpointSpecSwarm: { Ports: [] },
	mounts: [],
	labelsSwarm: {},
	networkSwarm: [{ Target: "dokploy-network" }],
	modeSwarm: { Replicated: { Replicas: 1 } },
	domains: [{ host: "app.example.com" }],
};

describe("Application Build Server selection", () => {
	it("accepts only an accessible, active, SSH-enabled Build Server in the same organization", () => {
		expect(
			assertApplicationBuildServerSelection({
				organizationId: "org-1",
				accessibleServerIds: new Set(["build-1"]),
				server: buildServer,
				registry,
			}),
		).toEqual(buildServer);

		for (const invalidServer of [
			{ ...buildServer, organizationId: "org-2" },
			{ ...buildServer, serverType: "deploy" as const },
			{ ...buildServer, serverStatus: "inactive" as const },
			{ ...buildServer, sshKeyId: null },
		]) {
			expect(() =>
				assertApplicationBuildServerSelection({
					organizationId: "org-1",
					accessibleServerIds: new Set(["build-1"]),
					server: invalidServer,
					registry,
				}),
			).toThrow();
		}
	});

	it("rejects inaccessible servers, foreign registries and Build Servers as runtime targets", () => {
		expect(() =>
			assertApplicationBuildServerSelection({
				organizationId: "org-1",
				accessibleServerIds: new Set(),
				server: buildServer,
				registry,
			}),
		).toThrow(/authorized/);
		expect(() =>
			assertApplicationBuildServerSelection({
				organizationId: "org-1",
				server: buildServer,
				registry: { ...registry, organizationId: "org-2" },
			}),
		).toThrow(/Registry/);
		expect(() =>
			assertApplicationRuntimeServerSelection({
				organizationId: "org-1",
				buildServerId: "build-1",
				runtimeServer: buildServer,
			}),
		).toThrow(/Deploy Server/);
		expect(() =>
			assertApplicationRuntimeServerSelection({
				organizationId: "org-1",
				buildServerId: "build-1",
				runtimeServer: {
					serverId: "runtime-1",
					organizationId: "org-2",
					serverType: "deploy",
					serverStatus: "active",
				},
			}),
		).toThrow(/organization/);
		expect(() =>
			assertApplicationRuntimeServerSelection({
				organizationId: "org-1",
				buildServerId: "build-1",
				runtimeServer: {
					serverId: "runtime-1",
					organizationId: "org-1",
					serverType: "deploy",
					serverStatus: "inactive",
				},
			}),
		).toThrow(/active Deploy Server/);
	});
});

describe("Dockerfile zero-downtime contract", () => {
	it("accepts the strict Git, Domain, health, drain and replicated-service contract", () => {
		expect(() =>
			assertApplicationBuildServerDeploymentReady(readyApplication),
		).not.toThrow();
	});

	it.each([
		["Build Server", { buildServerId: null }],
		["Build Registry", { buildRegistryId: null }],
		["Dockerfile", { buildType: "nixpacks" }],
		["Git-backed", { sourceType: "drop" }],
		["Domain", { domains: [] }],
		["health check", { healthCheckSwarm: null }],
		["stopGracePeriodSwarm", { stopGracePeriodSwarm: 1 }],
		["host ports", { ports: [{ publishedPort: 8080 }] }],
		["bind mounts", { mounts: [{ type: "bind" }] }],
		["volume mounts", { mounts: [{ type: "volume" }] }],
		["Traefik labels", { labelsSwarm: { "traefik.enable": "true" } }],
		["dokploy-network", { networkSwarm: [{ Target: "private" }] }],
		["VIP", { endpointSpecSwarm: { Mode: "dnsrr", Ports: [] } }],
		["replicated service mode", { modeSwarm: { Global: {} } }],
		["at least one replica", { modeSwarm: { Replicated: { Replicas: 0 } } }],
		["at least one replica", { modeSwarm: null, replicas: 0 }],
		["different machines", { serverId: "build-1" }],
	])("rejects a violation containing %s", (message, override) => {
		expect(() =>
			assertApplicationBuildServerDeploymentReady({
				...readyApplication,
				...override,
			}),
		).toThrow(message);
	});
});

describe("Application Build Server commands", () => {
	it("uses immutable deployment images and never embeds the registry password", () => {
		const image = getApplicationDeploymentImage(
			registry,
			"app-test",
			"deployment-123",
		);
		expect(image).toBe("registry.example.com/team/app-test:deployment-123");

		const login = getComposeRegistryLoginCommand(registry);
		expect(login).toContain('env HOME="$HOME" docker login');
		expect(login).toContain("--password-stdin");
		expect(login).not.toContain(registry.password);
		expect(getApplicationRuntimePullCommand(image)).toContain(
			"docker pull registry.example.com/team/app-test\\:deployment-123",
		);
		expect(getApplicationRuntimePullCommand(image)).not.toContain("--build");
		expect(
			getApplicationBuildPushCommand("app-test:deployment-123", image),
		).toContain(
			"docker push registry.example.com/team/app-test\\:deployment-123",
		);
	});

	it("generates cancellation, convergence and rollback guards around activation", () => {
		const cancellationPath = getApplicationCancellationPath("app-test", true);
		expect(getApplicationCancellationCheckCommand(cancellationPath)).toContain(
			"exit 130",
		);
		const wait = getWaitApplicationServiceCommand(
			"app-test",
			"registry.example.com/team/app-test:deployment-123",
		);
		expect(wait).toContain("rollback_started");
		expect(wait).toContain("Candidate release became unhealthy");
		expect(wait).toContain("docker service inspect --format '{{.ID}}'");
		expect(wait).toContain('docker service ls --filter "id=$service_id"');
		expect(wait).not.toContain('docker service ls --filter "name=^');
		const rollback = getRollbackApplicationServiceCommand(
			"app-test",
			"registry.example.com/team/app-test:deployment-123",
			"registry.example.com/team/app-test:deployment-122",
		);
		expect(rollback).toContain("docker service update --rollback");
		expect(rollback).toContain("rollback did not converge");
		expect(rollback).toContain("docker service inspect --format '{{.ID}}'");
		expect(rollback).toContain('docker service ls --filter "id=$service_id"');
		expect(rollback).not.toContain('docker service ls --filter "name=^');
	});
});
