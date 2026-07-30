import {
	getDokployImageRepository,
	getDokployReleaseRepository,
	getDokployReleaseUrl,
	getDokployUpdateImage,
	getStableUpdateData,
} from "@dokploy/server";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("Dokploy update source", () => {
	it("keeps the official repositories as backwards-compatible defaults", () => {
		expect(getDokployImageRepository()).toBe("dokploy/dokploy");
		expect(getDokployReleaseRepository()).toBe("Dokploy/dokploy");
		expect(getDokployReleaseUrl()).toBe(
			"https://github.com/Dokploy/dokploy/releases",
		);
		expect(getDokployUpdateImage("v0.29.13")).toBe("dokploy/dokploy:v0.29.13");
	});

	it("uses the fork repositories embedded in a fork release image", () => {
		vi.stubEnv("DOKPLOY_IMAGE_REPOSITORY", "ghcr.io/flots-app/dokploy");
		vi.stubEnv("DOKPLOY_RELEASE_REPOSITORY", "Flots-app/dokploy");

		expect(getDokployImageRepository()).toBe("ghcr.io/flots-app/dokploy");
		expect(getDokployReleaseRepository()).toBe("Flots-app/dokploy");
		expect(getDokployUpdateImage("v0.29.14-flots.2")).toBe(
			"ghcr.io/flots-app/dokploy:v0.29.14-flots.2",
		);
	});

	it("ignores an invalid GitHub repository configuration", () => {
		vi.stubEnv("DOKPLOY_RELEASE_REPOSITORY", "Flots-app/dokploy?ref=untrusted");

		expect(getDokployReleaseRepository()).toBe("Dokploy/dokploy");
	});

	it("detects a newer stable fork release and returns its notes URL", async () => {
		vi.stubEnv("DOKPLOY_RELEASE_REPOSITORY", "Flots-app/dokploy");
		const fetcher = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					tag_name: "v0.29.14-flots.2",
					html_url:
						"https://github.com/Flots-app/dokploy/releases/tag/v0.29.14-flots.2",
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			);
		});

		const result = await getStableUpdateData(
			"v0.29.14-flots.1",
			fetcher as typeof fetch,
		);

		expect(result).toEqual({
			latestVersion: "v0.29.14-flots.2",
			updateAvailable: true,
			releaseUrl:
				"https://github.com/Flots-app/dokploy/releases/tag/v0.29.14-flots.2",
		});
		expect(fetcher).toHaveBeenCalledWith(
			"https://api.github.com/repos/Flots-app/dokploy/releases/latest",
			expect.objectContaining({
				headers: expect.objectContaining({
					Accept: "application/vnd.github+json",
				}),
			}),
		);
	});

	it("does not downgrade or repeatedly install the current release", async () => {
		const fetcher = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					tag_name: "v0.29.14-flots.1",
					html_url:
						"https://github.com/Flots-app/dokploy/releases/tag/v0.29.14-flots.1",
				}),
				{ status: 200 },
			);
		});

		await expect(
			getStableUpdateData("v0.29.14-flots.1", fetcher as typeof fetch),
		).resolves.toMatchObject({
			latestVersion: "v0.29.14-flots.1",
			updateAvailable: false,
		});
	});

	it("fails closed when GitHub releases cannot be read", async () => {
		vi.stubEnv("DOKPLOY_RELEASE_REPOSITORY", "Flots-app/dokploy");
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const fetcher = vi.fn(
			async () => new Response("rate limited", { status: 403 }),
		);

		await expect(
			getStableUpdateData("v0.29.14-flots.1", fetcher as typeof fetch),
		).resolves.toEqual({
			latestVersion: null,
			updateAvailable: false,
			releaseUrl: "https://github.com/Flots-app/dokploy/releases",
		});
	});
});
