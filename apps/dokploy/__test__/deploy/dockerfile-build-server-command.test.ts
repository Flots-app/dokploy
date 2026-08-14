import type { ApplicationNested } from "@dokploy/server/utils/builders";
import { getDockerCommand } from "@dokploy/server/utils/builders/docker-file";
import { describe, expect, it } from "vitest";

const application = {
	applicationId: "app-1",
	appName: "app-test",
	buildServerId: "build-1",
	serverId: "build-1",
	buildType: "dockerfile",
	sourceType: "github",
	buildPath: "services/api",
	dockerfile: "Dockerfile.prod",
	dockerContextPath: "services/api",
	dockerBuildStage: null,
	cleanCache: false,
	createEnvFile: false,
	publishDirectory: null,
	env: null,
	buildArgs: "DOKPLOY_DEPLOYMENT_ID=user-controlled\nPUBLIC_VALUE=hello world",
	buildSecrets: null,
	environment: {
		env: null,
		project: { env: null },
	},
} as unknown as ApplicationNested;

describe("Dockerfile Build Server command", () => {
	it("pins the local image and gives the reserved deployment argument priority", () => {
		const command = getDockerCommand(application, {
			image: "app-test:deployment-123",
			deploymentId: "deployment-123",
		});

		expect(command).toContain("docker build -t app-test\\:deployment-123");
		expect(command).toContain(
			"--build-arg DOKPLOY_DEPLOYMENT_ID\\=deployment-123",
		);
		expect(command).not.toContain("DOKPLOY_DEPLOYMENT_ID=user-controlled");
		expect(command).toContain("'PUBLIC_VALUE=hello world'");
		expect(command).toMatch(/Dockerfile\.prod[^\n]+ \. \|\|/);
	});
});
