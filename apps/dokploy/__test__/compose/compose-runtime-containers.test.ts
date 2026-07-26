import {
	getComposeContainerCommand,
	getComposeContainerLabels,
	getDockerComposeContainersCommand,
	parseActiveComposeRuntimeContainerSelector,
} from "@dokploy/server";
import { describe, expect, test } from "vitest";

const runtimeSelector = {
	composeId: "compose-1",
	deploymentId: "deployment-1",
};

describe("Compose runtime container discovery", () => {
	test("lists only containers from the active blue/green release", () => {
		const command = getDockerComposeContainersCommand(
			"docker ps -a",
			"legacy-project",
			runtimeSelector,
		);

		expect(command).toContain(
			"--filter=label\\=com.dokploy.compose-id\\=compose-1",
		);
		expect(command).toContain(
			"--filter=label\\=com.dokploy.deployment-id\\=deployment-1",
		);
		expect(command).not.toContain("com.docker.compose.project");
		expect(command).not.toContain("legacy-project");
	});

	test("keeps the stable project selector for legacy Compose releases", () => {
		const command = getDockerComposeContainersCommand(
			"docker ps -a",
			"legacy-project",
		);

		expect(command).toContain(
			"--filter=label\\=com.docker.compose.project\\=legacy-project",
		);
		expect(command).not.toContain("com.dokploy.compose-id");
	});

	test("resolves service operations against the exact active deployment", () => {
		expect(
			getComposeContainerLabels(
				"legacy-project",
				"docker-compose",
				"backend",
				runtimeSelector,
			),
		).toEqual([
			"com.dokploy.compose-id=compose-1",
			"com.dokploy.deployment-id=deployment-1",
			"com.docker.compose.service=backend",
		]);
	});

	test("targets the active release for backup and restore commands", () => {
		const command = getComposeContainerCommand(
			"legacy-project",
			"database",
			"docker-compose",
			runtimeSelector,
		);

		expect(command).toContain(
			"--filter label\\=com.dokploy.compose-id\\=compose-1",
		);
		expect(command).toContain(
			"--filter label\\=com.dokploy.deployment-id\\=deployment-1",
		);
		expect(command).toContain(
			"--filter label\\=com.docker.compose.service\\=database",
		);
		expect(command).not.toContain("legacy-project");
	});

	test("accepts only runtime state belonging to the requested Compose", () => {
		expect(
			parseActiveComposeRuntimeContainerSelector(
				JSON.stringify(runtimeSelector),
				"compose-1",
				"/runtime/active-release.json",
			),
		).toEqual(runtimeSelector);
		expect(() =>
			parseActiveComposeRuntimeContainerSelector(
				JSON.stringify(runtimeSelector),
				"compose-2",
				"/runtime/active-release.json",
			),
		).toThrow("Invalid Dokploy runtime state");
		expect(() =>
			parseActiveComposeRuntimeContainerSelector(
				'{"composeId":"compose-1","deploymentId":""}',
				"compose-1",
				"/runtime/active-release.json",
			),
		).toThrow("Invalid Dokploy runtime state");
	});
});
