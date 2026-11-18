/**
 * End to end on the Dokploy side: a signed `pull_request` delivery goes
 * through the real webhook handling, a real database, the real GitHub App
 * authentication (JWT, installation token) with Octokit, the real reconciler
 * and the real sticky comment. Only GitHub's network and the Docker deploy
 * (validated separately on a lab Swarm) are simulated.
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { db } from "@dokploy/server/db";
import {
	compose,
	composePreviews,
	domains,
	environments,
	github,
	gitProvider,
	projects,
	server,
	sshKeys,
} from "@dokploy/server/db/schema";
import { Webhooks } from "@octokit/webhooks";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createOrganization, type Person, removeCreatedRows } from "./fixtures";

const stack = vi.hoisted(() => ({ deploy: vi.fn(), cleanup: vi.fn() }));
vi.mock("@dokploy/server/services/compose-preview-stack", () => ({
	deployComposePreviewStack: stack.deploy,
	cleanupComposePreviewStack: stack.cleanup,
	assertPreviewSwarmWorker: vi.fn(),
	runPreviewManager: vi.fn(),
}));

import { forgetComposePreview } from "@dokploy/server/services/compose-preview";
import { handleComposePreviewWebhook } from "@/server/queues/compose-previews";
import { myQueue } from "@/server/queues/queueSetup";

const INSTALLATION_ID = "424242";
const WEBHOOK_SECRET = randomBytes(16).toString("hex");
const { privateKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	privateKeyEncoding: { type: "pkcs1", format: "pem" },
	publicKeyEncoding: { type: "spki", format: "pem" },
});

/** GitHub as seen by Octokit: every request is recorded. */
const gh = {
	pr: {} as Record<string, unknown>,
	requests: [] as { method: string; path: string; auth: string; body?: any }[],
	comments: new Map<number, string>(),
};

const json = (
	status: number,
	body: unknown,
	headers: Record<string, string> = {},
) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});

const fakeGitHub = async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = new URL(typeof input === "string" ? input : input.toString());
	const method = (init?.method || "GET").toUpperCase();
	const headers = new Headers(init?.headers);
	const body = init?.body ? JSON.parse(String(init.body)) : undefined;
	gh.requests.push({
		method,
		path: url.pathname,
		auth: headers.get("authorization") || "",
		body,
	});
	if (url.hostname !== "api.github.com") throw new Error(`unexpected ${url}`);
	if (
		method === "POST" &&
		url.pathname === `/app/installations/${INSTALLATION_ID}/access_tokens`
	)
		return json(201, {
			token: "ghs_installation_token",
			expires_at: new Date(Date.now() + 3_600_000).toISOString(),
			permissions: { contents: "read", pull_requests: "write" },
			repository_selection: "all",
		});
	if (method === "GET" && /^\/repos\/acme\/app\/pulls\/\d+$/.test(url.pathname))
		return json(200, gh.pr, { etag: `"${JSON.stringify(gh.pr).length}"` });
	if (
		method === "GET" &&
		url.pathname === "/repos/acme/app/collaborators/alice/permission"
	)
		return json(200, { permission: "write", user: { login: "alice" } });
	if (
		method === "POST" &&
		/^\/repos\/acme\/app\/issues\/\d+\/comments$/.test(url.pathname)
	) {
		const id = 9000 + gh.comments.size;
		gh.comments.set(id, body.body);
		return json(201, { id, body: body.body });
	}
	const update = url.pathname.match(
		/^\/repos\/acme\/app\/issues\/comments\/(\d+)$/,
	);
	if (method === "PATCH" && update) {
		const id = Number(update[1]);
		if (!gh.comments.has(id)) return json(404, { message: "Not Found" });
		gh.comments.set(id, body.body);
		return json(200, { id, body: body.body });
	}
	return json(404, { message: `no fake for ${method} ${url.pathname}` });
};

let owner: Person;
let sourceId: string;
let workerId: string;
let githubId: string;

beforeAll(async () => {
	vi.stubGlobal("fetch", vi.fn(fakeGitHub));
	owner = await createOrganization("compose-preview-webhook");
	const [provider] = await db
		.insert(gitProvider)
		.values({
			name: "GitHub App",
			providerType: "github",
			organizationId: owner.organizationId,
			userId: owner.userId,
		})
		.returning();
	const [app] = await db
		.insert(github)
		.values({
			githubAppName: "dokploy-test",
			githubAppId: 1234,
			githubInstallationId: INSTALLATION_ID,
			githubPrivateKey: privateKey,
			githubWebhookSecret: WEBHOOK_SECRET,
			gitProviderId: provider!.gitProviderId,
		})
		.returning();
	githubId = app!.githubId;
	const [key] = await db
		.insert(sshKeys)
		.values({
			name: "worker",
			publicKey: "ssh-ed25519 AAAA test",
			organizationId: owner.organizationId,
		})
		.returning();
	const [worker] = await db
		.insert(server)
		.values({
			name: "preview-worker",
			ipAddress: "100.64.0.20",
			port: 2222,
			createdAt: new Date().toISOString(),
			organizationId: owner.organizationId,
			sshKeyId: key!.sshKeyId,
			swarmNodeId: "node-1",
			previewOnly: true,
		})
		.returning();
	workerId = worker!.serverId;
	const [project] = await db
		.insert(projects)
		.values({ name: "app", organizationId: owner.organizationId })
		.returning();
	const [environment] = await db
		.insert(environments)
		.values({ name: "production", projectId: project!.projectId })
		.returning();
	const [source] = await db
		.insert(compose)
		.values({
			name: "app",
			environmentId: environment!.environmentId,
			sourceType: "github",
			composeType: "docker-compose",
			githubId,
			owner: "acme",
			repository: "app",
			branch: "main",
			previewSettings: {
				enabled: true,
				serverId: workerId,
				registryId: "registry",
				baseBranch: "main",
				composePath: "docker-compose.yml",
				limit: 3,
				ttlHours: 24,
				domain: "preview.example.com",
				https: true,
				certificateType: "letsencrypt",
				labels: [],
				cpuLimit: 1,
				memoryLimitMb: 512,
			},
			previewEnv: "API_URL=${{DOKPLOY_PREVIEW_WEB_URL}}",
		})
		.returning();
	sourceId = source!.composeId;
	await db.insert(domains).values({
		host: "app.example.com",
		serviceName: "web",
		port: 3000,
		path: "/",
		domainType: "compose",
		composeId: sourceId,
		uniqueConfigKey: 1,
	});
	gh.pr = {
		number: 7,
		state: "open",
		draft: false,
		merged: false,
		html_url: "https://github.com/acme/app/pull/7",
		labels: [],
		user: { login: "alice" },
		base: { ref: "main", repo: { id: 1 } },
		head: { ref: "feature/login", sha: "a".repeat(40), repo: { id: 1 } },
	};
	stack.deploy.mockResolvedValue(undefined);
	stack.cleanup.mockResolvedValue(undefined);
});

afterAll(async () => {
	vi.unstubAllGlobals();
	await db
		.delete(composePreviews)
		.where(eq(composePreviews.sourceComposeId, sourceId));
	await db.delete(compose).where(eq(compose.previewParentId, sourceId));
	await db.delete(server).where(eq(server.serverId, workerId));
	await removeCreatedRows();
});

const deliver = async (action: string) => {
	// What the webhook route does first: verify GitHub's signature.
	const payload = {
		action,
		number: 7,
		pull_request: gh.pr,
		repository: { name: "app", owner: { login: "acme" } },
		installation: { id: Number(INSTALLATION_ID) },
	};
	const webhooks = new Webhooks({ secret: WEBHOOK_SECRET });
	const signature = await webhooks.sign(JSON.stringify(payload));
	expect(await webhooks.verify(JSON.stringify(payload), signature)).toBe(true);
	await handleComposePreviewWebhook({
		githubId,
		owner: payload.repository.owner.login,
		repository: payload.repository.name,
		pullRequestNumber: payload.pull_request.number as number,
		action,
		baseRef: "main",
		fromFork: false,
		draft: false,
	});
	const preview = await db.query.composePreviews.findFirst({
		where: (row, { and }) =>
			and(
				eq(row.sourceComposeId, sourceId),
				eq(row.pullRequestNumber, payload.pull_request.number as number),
			),
	});
	return preview!;
};

/** Wait for the deployment queue (started by Dokploy on boot) to handle the
 * latest request: the real path, with no direct call to the reconciler. */
const settle = async (previewId: string) => {
	await myQueue.run();
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		const row = await db.query.composePreviews.findFirst({
			where: eq(composePreviews.previewId, previewId),
		});
		const jobs = await myQueue.getJobs(["waiting", "active"]);
		const queued = jobs.some(
			(job) =>
				job.data.applicationType === "compose-preview" &&
				job.data.previewId === previewId,
		);
		if (row && !queued && !row.lockedBy && row.reconciledAt === row.requestedAt)
			return row;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error("The deployment queue did not settle the preview");
};

describe("a pull request through Dokploy, end to end", () => {
	let commentId: number;

	it("authenticates as the GitHub App, deploys the PR head and comments once", async () => {
		const preview = await deliver("opened");
		expect(preview.pullRequestNumber).toBe(7);
		await settle(preview.previewId);

		const tokenCall = gh.requests.find((call) =>
			call.path.endsWith("/access_tokens"),
		);
		expect(tokenCall?.auth).toMatch(/^bearer ey/i);
		const prCall = gh.requests.find((call) => call.path.endsWith("/pulls/7"));
		expect(prCall?.auth).toBe("token ghs_installation_token");

		const ready = await db.query.composePreviews.findFirst({
			where: eq(composePreviews.previewId, preview.previewId),
		});
		expect(ready).toMatchObject({
			status: "ready",
			deployedSha: "a".repeat(40),
			branch: "feature/login",
			authorizedSha: "a".repeat(40),
		});
		expect(stack.deploy).toHaveBeenCalledOnce();

		const instance = await db.query.compose.findFirst({
			where: eq(compose.composeId, ready!.composeId!),
			with: { domains: true },
		});
		expect(instance?.previewCommitSha).toBe("a".repeat(40));
		const host = instance!.domains[0]!.host;
		expect(host).toMatch(
			/^preview-[0-9a-f]{12}-pr-7-web-[0-9a-f]{6}\.preview\.example\.com$/,
		);
		// The preview variables were resolved for this PR.
		expect(instance?.env).toContain(`API_URL=https://${host}`);

		expect(gh.comments.size).toBe(1);
		[commentId] = [...gh.comments.keys()] as [number];
		expect(String(ready!.commentId)).toBe(String(commentId));
		const body = gh.comments.get(commentId)!;
		expect(body).toContain("✅ Ready");
		expect(body).toContain(`https://${host}`);
		expect(body).toContain("`aaaaaaa`");
	});

	it("redeploys a push in place, on the same comment", async () => {
		gh.pr = {
			...gh.pr,
			head: { ref: "feature/login", sha: "b".repeat(40), repo: { id: 1 } },
		};
		const preview = await deliver("synchronize");
		await settle(preview.previewId);
		expect(stack.deploy).toHaveBeenCalledTimes(2);
		expect(gh.comments.size).toBe(1);
		expect(gh.comments.get(commentId)).toContain("`bbbbbbb`");
	});

	it("removes the environment when the PR is merged and says why", async () => {
		gh.pr = { ...gh.pr, state: "closed", merged: true };
		const preview = await deliver("closed");
		await settle(preview.previewId);
		expect(stack.cleanup).toHaveBeenCalledOnce();
		const closed = await db.query.composePreviews.findFirst({
			where: eq(composePreviews.previewId, preview.previewId),
		});
		expect(closed).toMatchObject({ status: "closed", composeId: null });
		const body = gh.comments.get(commentId)!;
		expect(body).toContain("🗑️ Removed");
		expect(body).toContain("The PR was merged.");
		expect(body).not.toContain("preview.example.com");
		expect(gh.comments.size).toBe(1);
	});

	it("never records a PR from a fork", async () => {
		await handleComposePreviewWebhook({
			githubId,
			owner: "acme",
			repository: "app",
			pullRequestNumber: 8,
			action: "opened",
			baseRef: "main",
			fromFork: true,
			draft: false,
		});
		const fork = await db.query.composePreviews.findFirst({
			where: (row, { and }) =>
				and(eq(row.sourceComposeId, sourceId), eq(row.pullRequestNumber, 8)),
		});
		expect(fork).toBeUndefined();
	});

	it("never runs PR code on a server that is not reserved for previews", async () => {
		await db
			.update(server)
			.set({ previewOnly: false })
			.where(eq(server.serverId, workerId));
		gh.pr = {
			...gh.pr,
			number: 9,
			state: "open",
			merged: false,
			head: { ref: "feature/billing", sha: "c".repeat(40), repo: { id: 1 } },
		};
		const deploys = stack.deploy.mock.calls.length;
		try {
			await handleComposePreviewWebhook({
				githubId,
				owner: "acme",
				repository: "app",
				pullRequestNumber: 9,
				action: "opened",
				baseRef: "main",
				fromFork: false,
				draft: false,
			});
			const requested = await db.query.composePreviews.findFirst({
				where: (row, { and }) =>
					and(eq(row.sourceComposeId, sourceId), eq(row.pullRequestNumber, 9)),
			});
			const failed = await settle(requested!.previewId);
			expect(failed.status).toBe("error");
			expect(failed.error).toContain("reserved for previews");
			expect(failed.composeId).toBeNull();
			expect(stack.deploy.mock.calls.length).toBe(deploys);
		} finally {
			await db
				.update(server)
				.set({ previewOnly: true })
				.where(eq(server.serverId, workerId));
		}
	});

	it("lets an admin forget a failed environment whose worker is gone", async () => {
		gh.pr = {
			...gh.pr,
			number: 7,
			state: "open",
			merged: false,
			head: { ref: "feature/login", sha: "d".repeat(40), repo: { id: 1 } },
		};
		const preview = await deliver("reopened");
		await settle(preview.previewId);
		const running = await db.query.composePreviews.findFirst({
			where: eq(composePreviews.previewId, preview.previewId),
		});
		expect(running?.composeId).toBeTruthy();
		// The worker is unreachable: every removal attempt fails.
		await db
			.update(composePreviews)
			.set({ status: "error", error: "Preview worker is unreachable over SSH" })
			.where(eq(composePreviews.previewId, preview.previewId));
		await forgetComposePreview(preview.previewId);
		const forgotten = await db.query.composePreviews.findFirst({
			where: eq(composePreviews.previewId, preview.previewId),
		});
		expect(forgotten).toMatchObject({
			status: "closed",
			composeId: null,
			environmentId: null,
			manualCleanup: true,
		});
		expect(
			await db.query.compose.findFirst({
				where: eq(compose.composeId, running!.composeId!),
			}),
		).toBeUndefined();
		// Forgetting never contacted a server.
		expect(stack.cleanup.mock.calls.length).toBe(1);
		await expect(forgetComposePreview(preview.previewId)).rejects.toThrow(
			"Only a failed PR environment can be forgotten",
		);
	});
});
