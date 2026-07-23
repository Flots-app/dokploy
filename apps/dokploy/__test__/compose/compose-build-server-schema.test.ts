import {
	apiUpdateCompose,
	apiUpdateComposeBuildServer,
} from "@dokploy/server/db/schema";
import { describe, expect, it } from "vitest";

describe("Compose Build Server API schemas", () => {
	it("requires Build Server and registry together", () => {
		expect(
			apiUpdateComposeBuildServer.safeParse({
				composeId: "compose-1",
				buildServerId: "server-1",
				buildRegistryId: null,
			}).success,
		).toBe(false);
		expect(
			apiUpdateComposeBuildServer.safeParse({
				composeId: "compose-1",
				buildServerId: null,
				buildRegistryId: null,
			}).success,
		).toBe(true);
	});

	it("does not expose Build Server fields through the generic update", () => {
		const parsed = apiUpdateCompose.parse({
			composeId: "compose-1",
			buildServerId: "server-1",
			buildRegistryId: "registry-1",
		});
		expect(parsed).not.toHaveProperty("buildServerId");
		expect(parsed).not.toHaveProperty("buildRegistryId");
	});
});
