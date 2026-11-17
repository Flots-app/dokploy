import {
	composePreviewCommentMarker,
	renderComposePreviewComment,
} from "@dokploy/server/services/compose-preview-feedback";
import { describe, expect, it } from "vitest";

const base = {
	previewId: "preview",
	sourceComposeId: "source",
	sourceName: "monorepo",
	projectId: "project",
	environmentId: "environment",
	pullRequestNumber: 7,
};
const now = new Date("2026-11-17T10:00:00Z");

describe("sticky PR comment", () => {
	it("lists every service URL, the commit, the expiry and the links", () => {
		const body = renderComposePreviewComment(
			{
				...base,
				state: "ready",
				sha: "0123456789abcdef",
				expiresAt: "2026-11-20T10:00:00.000Z",
				urls: [
					{ service: "api", url: "https://api.preview.example.com" },
					{ service: "web", url: "https://web.preview.example.com" },
				],
				logsPath: "/dashboard/project/project/environment/e/services/compose/c",
			},
			"https://dokploy.example.com/",
			now,
		);
		expect(body.startsWith(composePreviewCommentMarker("source"))).toBe(true);
		expect(body).toContain("✅ Ready");
		expect(body).toContain("`0123456`");
		expect(body).toContain("| api | https://api.preview.example.com |");
		expect(body).toContain("Expires 2026-11-20 10:00 UTC");
		expect(body).toContain(
			"[Previews in Dokploy](https://dokploy.example.com/dashboard/project/project/environment/environment/services/compose/source?tab=previews)",
		);
		expect(body).toContain(
			"[Build and deploy logs](https://dokploy.example.com/dashboard/project/project/environment/e/services/compose/c)",
		);
	});
	it("quotes the failure reason and cannot break the table", () => {
		const body = renderComposePreviewComment(
			{
				...base,
				state: "error",
				error: "Compose validation: a | b\nnext line",
			},
			"https://dokploy.example.com",
			now,
		);
		expect(body).toContain("❌ Failed");
		expect(body).toContain("> Compose validation: a \\| b next line");
	});
	it("drops URLs once the environment is removed", () => {
		const body = renderComposePreviewComment(
			{
				...base,
				state: "removed",
				urls: [{ service: "api", url: "https://api.preview.example.com" }],
				logsPath: "/x",
			},
			"https://dokploy.example.com",
			now,
		);
		expect(body).toContain("🗑️ Removed");
		expect(body).not.toContain("api.preview.example.com");
		expect(body).not.toContain("Build and deploy logs");
	});
});

describe("removal reason", () => {
	it("tells the developer why the environment went away", () => {
		const body = renderComposePreviewComment(
			{
				...base,
				state: "removed",
				error:
					"Expired after its lifetime without new commits. Push a commit to recreate it.",
			},
			"https://dokploy.example.com",
			now,
		);
		expect(body).toContain("> Expired after its lifetime");
	});
});
