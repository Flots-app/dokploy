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
	feedback: vi.fn(),
}));
vi.mock("@dokploy/server/db", () => {
	// The lifecycle lease: an UPDATE ... RETURNING that only matches when no
	// other run holds it. `acquired = false` simulates another controller.
	let leaseRejected = false;
	const chain: any = {
		set: (v: any) => {
			leaseRejected = false;
			if (v.lockedBy && (m.preview.lockedBy || !m.acquired)) {
				leaseRejected = true;
				return chain;
			}
			m.changes.push(v);
			Object.assign(m.preview, v);
			return chain;
		},
		where: () => chain,
		returning: async () => (leaseRejected ? [] : [{ previewId: "preview" }]),
		// biome-ignore lint/suspicious/noThenProperty: Drizzle query builders are awaitable.
		then: (resolve: any) => resolve([]),
	};
	const tx: any = {
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
vi.mock("@dokploy/server/services/compose-preview-feedback", () => ({
	publishComposePreviewFeedback: m.feedback,
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
			commentId: null,
			authorizedSha: null,
			lockedBy: null,
		};
		m.source = {
			composeId: "source",
			name: "monorepo",
			environmentId: "source-environment",
			environment: { projectId: "project" },
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
			environmentId: "environment",
			domains: [
				{
					serviceName: "web",
					host: "web.preview.example.com",
					https: true,
					path: "/",
				},
			],
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
		m.get.mockImplementation(async () => ({ data: m.pr, headers: {} }));
		m.feedback.mockResolvedValue(undefined);
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
		// The lease is released and the lifetime restarted for the new commit.
		expect(m.preview.lockedBy).toBeNull();
		expect(m.preview.expiresAt > new Date().toISOString()).toBe(true);
	});
	it("keeps the developer informed on the pull request", async () => {
		await reconcileComposePreview("preview");
		const states = m.feedback.mock.calls.map(([input]) => input.state);
		expect(states).toEqual(["deploying", "ready"]);
		expect(m.feedback.mock.calls[1]?.[0]).toMatchObject({
			pullRequestNumber: 7,
			sha: "new",
			urls: [{ service: "web", url: "https://web.preview.example.com" }],
		});
	});
	it("reports a failed deploy on the pull request without leaking internals", async () => {
		m.deploy.mockRejectedValue(new Error("ssh root@10.0.0.1 token=secret"));
		await expect(reconcileComposePreview("preview")).rejects.toThrow();
		const failure = m.feedback.mock.calls.at(-1)?.[0];
		expect(failure.state).toBe("error");
		expect(failure.error).not.toContain("secret");
		expect(m.preview.lockedBy).toBeNull();
	});
	it("shows actionable preview errors as they are", async () => {
		const { ComposePreviewError } = await import(
			"@dokploy/server/utils/docker/compose-preview"
		);
		m.deploy.mockRejectedValue(
			new ComposePreviewError("Preview service api: cap_add is not supported"),
		);
		await expect(reconcileComposePreview("preview")).rejects.toThrow();
		expect(m.preview.error).toBe(
			"Preview service api: cap_add is not supported",
		);
	});
	it("never leaves a running environment without a lifetime", async () => {
		m.preview.deployedSha = "new";
		m.preview.expiresAt = null;
		await reconcileComposePreview("preview");
		expect(m.deploy).not.toHaveBeenCalled();
		expect(m.preview.expiresAt > new Date().toISOString()).toBe(true);
	});
	it("tells the PR about a blocked preview once, not on every retry", async () => {
		// Failures before "Deploying" (permission, capacity) repeat every poll.
		m.permission.mockResolvedValue({ hasWriteAccess: false });
		await expect(reconcileComposePreview("preview")).rejects.toThrow();
		await expect(reconcileComposePreview("preview")).rejects.toThrow();
		const states = m.feedback.mock.calls.map(([input]) => input.state);
		expect(states).toEqual(["error"]);
	});
	it("reports a failed new commit even when the error text repeats", async () => {
		const { ComposePreviewError } = await import(
			"@dokploy/server/utils/docker/compose-preview"
		);
		const failure = "Preview failed during image build; see the deployment log";
		m.preview.status = "error";
		m.preview.error = failure;
		m.preview.reconciledAt = "older";
		m.deploy.mockRejectedValue(new ComposePreviewError(failure));
		await expect(reconcileComposePreview("preview")).rejects.toThrow();
		// "Deploying" was posted, so the comment must end on the failure.
		expect(m.feedback.mock.calls.map(([input]) => input.state)).toEqual([
			"deploying",
			"error",
		]);
	});
	it("checks the author's permission once per commit", async () => {
		m.preview.authorizedSha = "new";
		await reconcileComposePreview("preview");
		expect(m.permission).not.toHaveBeenCalled();
		expect(m.deploy).toHaveBeenCalledOnce();
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
			expect(m.feedback.mock.calls.at(-1)?.[0].state).toBe("removed");
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
	it("does no work when another controller holds the lease", async () => {
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
