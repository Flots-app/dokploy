import {
	apiSetDefaultBuildServer,
	apiUpdateApplication,
	apiUpdateApplicationBuildServer,
} from "@dokploy/server/db/schema";
import { describe, expect, it } from "vitest";

describe("Application Build Server API schemas", () => {
	it("requires a Build Server and registry in the dedicated mutation", () => {
		expect(
			apiUpdateApplicationBuildServer.safeParse({
				applicationId: "app-1",
				buildServerId: "build-1",
				buildRegistryId: "registry-1",
			}).success,
		).toBe(true);
		expect(
			apiUpdateApplicationBuildServer.safeParse({
				applicationId: "app-1",
				buildServerId: "",
				buildRegistryId: "registry-1",
			}).success,
		).toBe(false);
	});

	it("strips Build Server, registry and runtime server fields from generic updates", () => {
		const parsed = apiUpdateApplication.parse({
			applicationId: "app-1",
			serverId: "runtime-2",
			buildServerId: "deploy-1",
			buildRegistryId: "registry-1",
		});
		expect(parsed).not.toHaveProperty("serverId");
		expect(parsed).not.toHaveProperty("buildServerId");
		expect(parsed).not.toHaveProperty("buildRegistryId");
	});

	it("requires an explicit server when selecting an organization default", () => {
		expect(
			apiSetDefaultBuildServer.safeParse({ serverId: "build-1" }).success,
		).toBe(true);
		expect(apiSetDefaultBuildServer.safeParse({ serverId: "" }).success).toBe(
			false,
		);
	});
});
