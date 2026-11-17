import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	row: { commentId: null as string | null },
	create: vi.fn(),
	update: vi.fn(),
}));
vi.mock("@dokploy/server/db", () => {
	const chain: any = {
		set: (value: any) => {
			Object.assign(m.row, value);
			return chain;
		},
		where: async () => [],
	};
	return {
		db: {
			query: { composePreviews: { findFirst: async () => ({ ...m.row }) } },
			update: () => chain,
		},
	};
});
vi.mock("@dokploy/server/services/admin", () => ({
	getDokployUrl: async () => "https://dokploy.example.com",
}));
vi.mock("@dokploy/server/services/github", () => ({
	findGithubById: async () => ({}),
}));
vi.mock("@dokploy/server/utils/providers/github", () => ({
	authGithub: () => ({
		rest: { issues: { createComment: m.create, updateComment: m.update } },
	}),
}));

import { publishComposePreviewFeedback } from "@dokploy/server/services/compose-preview-feedback";

const input = {
	previewId: "preview",
	sourceComposeId: "source",
	sourceName: "monorepo",
	projectId: "project",
	environmentId: "environment",
	githubId: "github",
	owner: "owner",
	repository: "repo",
	pullRequestNumber: 7,
};

describe("publishing PR feedback", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		m.row.commentId = null;
		m.create.mockResolvedValue({ data: { id: 42 } });
		m.update.mockResolvedValue({});
	});
	it("keeps a single comment across the deploy steps of one run", async () => {
		await publishComposePreviewFeedback({ ...input, state: "deploying" });
		await publishComposePreviewFeedback({ ...input, state: "ready" });
		expect(m.create).toHaveBeenCalledOnce();
		expect(m.update).toHaveBeenCalledWith(
			expect.objectContaining({ comment_id: 42 }),
		);
	});
	it("recreates a comment someone deleted", async () => {
		m.row.commentId = "41";
		m.update.mockRejectedValue(
			Object.assign(new Error("gone"), { status: 404 }),
		);
		await publishComposePreviewFeedback({ ...input, state: "ready" });
		expect(m.create).toHaveBeenCalledOnce();
		expect(m.row.commentId).toBe("42");
	});
	it("never fails the environment when GitHub is down", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		m.create.mockRejectedValue(new Error("502"));
		await expect(
			publishComposePreviewFeedback({ ...input, state: "deploying" }),
		).resolves.toBeUndefined();
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});
	it("does not open a comment just to say an unknown PR was removed", async () => {
		await publishComposePreviewFeedback({ ...input, state: "removed" });
		expect(m.create).not.toHaveBeenCalled();
	});
});
