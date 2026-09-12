import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	preview: {} as any,
	source: {} as any,
	child: {} as any,
	pr: {} as any,
	deploy: vi.fn(),
	cleanup: vi.fn(),
	updateCompose: vi.fn(),
	permission: vi.fn(),
	get: vi.fn(),
	changes: [] as any[],
	acquired: true,
}));
vi.mock("@dokploy/server/db", () => {
	const chain: any = {
		set: (v: any) => {
			m.changes.push(v);
			Object.assign(m.preview, v);
			return chain;
		},
		where: () => chain,
		returning: async () => [],
		// biome-ignore lint/suspicious/noThenProperty: Drizzle query builders are awaitable.
		then: (resolve: any) => resolve([]),
	};
	const tx: any = {
		execute: async () => [{ acquired: m.acquired }],
		update: () => chain,
		delete: () => chain,
	};
	return {
		db: {
			query: { composePreviews: { findFirst: async () => ({ ...m.preview }) } },
			update: () => chain,
			transaction: async (fn: any) => fn(tx),
		},
	};
});
vi.mock("@dokploy/server/services/compose", () => ({
	findComposeById: async (id: string) => (id === "source" ? m.source : m.child),
	updateCompose: m.updateCompose,
}));
vi.mock("@dokploy/server/services/compose-preview-stack", () => ({
	cleanupComposePreviewStack: m.cleanup,
	deployComposePreviewStack: m.deploy,
}));
vi.mock("@dokploy/server/services/github", () => ({
	findGithubById: async () => ({}),
}));
vi.mock("@dokploy/server/utils/providers/github", () => ({
	authGithub: () => ({ rest: { pulls: { get: m.get } } }),
	checkUserRepositoryPermissions: m.permission,
}));

import { reconcileComposePreview } from "@dokploy/server/services/compose-preview";

describe("Compose preview reconciliation against authoritative PR state", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		m.changes = [];
		m.acquired = true;
		m.preview = {
			previewId: "preview",
			sourceComposeId: "source",
			composeId: "child",
			environmentId: "environment",
			serverId: "worker",
			pullRequestNumber: 7,
			requestedAt: "2026-01-01",
			reconciledAt: null,
			status: "ready",
			deployedSha: "old",
			manualCleanup: false,
			expiresAt: "2999-01-01",
		};
		m.source = {
			composeId: "source",
			sourceType: "github",
			githubId: "github",
			owner: "owner",
			repository: "repo",
			previewSettings: {
				enabled: true,
				baseBranch: "main",
				labels: [],
				ttlHours: 24,
			},
		};
		m.child = {
			previewParentId: "source",
			serverId: "worker",
			previewCommitSha: "old",
		};
		m.pr = {
			state: "open",
			draft: false,
			base: { ref: "main", repo: { id: 1 } },
			head: { ref: "branch", sha: "new", repo: { id: 1 } },
			labels: [],
			user: { login: "author" },
			html_url: "https://github.com/owner/repo/pull/7",
		};
		m.get.mockImplementation(async () => ({ data: m.pr }));
		m.permission.mockResolvedValue({ hasWriteAccess: true });
		m.deploy.mockResolvedValue(undefined);
		m.cleanup.mockResolvedValue(undefined);
	});
	it("deploys the current GitHub SHA and records readiness", async () => {
		await reconcileComposePreview("preview");
		expect(m.updateCompose).toHaveBeenCalledWith("child", {
			branch: "branch",
			previewCommitSha: "new",
		});
		expect(m.deploy).toHaveBeenCalledOnce();
		expect(m.preview.status).toBe("ready");
		expect(m.preview.deployedSha).toBe("new");
	});
	it("does not rebuild a ready unchanged commit", async () => {
		m.preview.deployedSha = "new";
		await reconcileComposePreview("preview");
		expect(m.deploy).not.toHaveBeenCalled();
	});
	it.each(["closed", "draft", "base", "label"])(
		"cleans up when PR eligibility is lost: %s",
		async (reason) => {
			if (reason === "closed") m.pr.state = "closed";
			if (reason === "draft") m.pr.draft = true;
			if (reason === "base") m.pr.base.ref = "other";
			if (reason === "label") m.source.previewSettings.labels = ["preview"];
			await reconcileComposePreview("preview");
			expect(m.cleanup).toHaveBeenCalledWith(m.child, "preview");
			expect(m.deploy).not.toHaveBeenCalled();
			expect(m.preview.status).toBe("closed");
			expect(m.preview.composeId).toBeNull();
		},
	);
	it.each(["manual", "expired", "disabled"])(
		"cleans up without GitHub for %s",
		async (reason) => {
			if (reason === "manual") m.preview.manualCleanup = true;
			if (reason === "expired") m.preview.expiresAt = "2000-01-01";
			if (reason === "disabled") m.source.previewSettings.enabled = false;
			await reconcileComposePreview("preview");
			expect(m.get).not.toHaveBeenCalled();
			expect(m.cleanup).toHaveBeenCalledOnce();
		},
	);
	it("retains ownership and capacity after failed cleanup", async () => {
		m.preview.manualCleanup = true;
		m.cleanup.mockRejectedValue(
			new Error("remote command containing a secret"),
		);
		await expect(reconcileComposePreview("preview")).rejects.toThrow();
		expect(m.preview.composeId).toBe("child");
		expect(m.preview.serverId).toBe("worker");
		expect(m.preview.status).toBe("error");
		expect(m.preview.error).not.toContain("secret");
	});
	it.each(["fork", "permission"])(
		"rejects unauthorized PR code: %s",
		async (reason) => {
			if (reason === "fork") m.pr.head.repo.id = 2;
			else m.permission.mockResolvedValue({ hasWriteAccess: false });
			await expect(reconcileComposePreview("preview")).rejects.toThrow();
			expect(m.deploy).not.toHaveBeenCalled();
		},
	);
	it("checks closure while suppressing retries of an unchanged failed commit", async () => {
		m.preview.status = "error";
		m.preview.reconciledAt = m.preview.requestedAt;
		m.child.previewCommitSha = "new";
		await reconcileComposePreview("preview");
		expect(m.deploy).not.toHaveBeenCalled();
		expect(m.get).toHaveBeenCalledOnce();
		m.pr.state = "closed";
		await reconcileComposePreview("preview");
		expect(m.cleanup).toHaveBeenCalledOnce();
	});
	it("allows a new request to retry a failed commit", async () => {
		m.preview.status = "error";
		m.preview.reconciledAt = "older";
		m.child.previewCommitSha = "new";
		await reconcileComposePreview("preview");
		expect(m.deploy).toHaveBeenCalledOnce();
	});
	it("does no work when another controller owns the advisory lock", async () => {
		m.acquired = false;
		await reconcileComposePreview("preview");
		expect(m.get).not.toHaveBeenCalled();
		expect(m.deploy).not.toHaveBeenCalled();
		expect(m.cleanup).not.toHaveBeenCalled();
	});
	it("serializes duplicate requests and deploys only once", async () => {
		await Promise.all([
			reconcileComposePreview("preview"),
			reconcileComposePreview("preview"),
		]);
		expect(m.deploy).toHaveBeenCalledOnce();
	});
});
