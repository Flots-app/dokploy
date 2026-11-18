import { randomBytes } from "node:crypto";
import { db } from "@dokploy/server/db";
import {
	compose,
	composePreviews,
	domains,
	environments,
	server,
} from "@dokploy/server/db/schema";
import { and, count, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { composePreviewSettingsSchema } from "../db/validations/compose-preview";
import {
	ComposePreviewError,
	isComposePreviewError,
	previewAppName,
	previewHost,
} from "../utils/docker/compose-preview";
import { formatDeploymentError } from "../utils/process/deployment-error";
import {
	authGithub,
	checkUserRepositoryPermissions,
} from "../utils/providers/github";
import { findComposeById, updateCompose } from "./compose";
import {
	type ComposePreviewFeedback,
	type ComposePreviewFeedbackState,
	publishComposePreviewFeedback,
} from "./compose-preview-feedback";
import {
	cleanupComposePreviewStack,
	deployComposePreviewStack,
	isPreviewWorkerReachable,
} from "./compose-preview-stack";
import { findGithubById } from "./github";

export type ComposePreview = typeof composePreviews.$inferSelect;

/**
 * Why a preview is (re)requested:
 * - `manual`: someone deployed it from Dokploy; clears a manual removal and
 *   restarts its lifetime.
 * - `activity`: new code on the PR (opened, reopened, pushed). Lets an expired (already
 *   removed) environment come back, but keeps a manual removal. A running
 *   environment's lifetime restarts only when a new commit is deployed.
 * - `sync`: anything else (closed PR, settings change, periodic check).
 */
export type ComposePreviewRequest = "manual" | "activity" | "sync";

export async function requestComposePreview(
	sourceComposeId: string,
	pullRequestNumber: number,
	reason: ComposePreviewRequest = "sync",
) {
	const now = new Date().toISOString();
	const [preview] = await db
		.insert(composePreviews)
		.values({ sourceComposeId, pullRequestNumber, requestedAt: now })
		.onConflictDoUpdate({
			target: [
				composePreviews.sourceComposeId,
				composePreviews.pullRequestNumber,
			],
			set: {
				requestedAt: now,
				...(reason === "manual"
					? { manualCleanup: false, expiresAt: null, deployedSha: null }
					: reason === "activity"
						? {
								// Only clear the expiry of a removed or expiring environment:
								// clearing it on a running one would disable its lifetime for
								// good, and keeping a past one would drop a push that arrives
								// while the expired environment is being removed.
								expiresAt: sql`case when ${composePreviews.composeId} is null or ${composePreviews.expiresAt} <= ${now} then null else ${composePreviews.expiresAt} end`,
							}
						: {}),
			},
		})
		.returning();
	if (!preview) throw new Error("Unable to request Compose preview");
	return preview;
}

export async function requestComposePreviewCleanup(previewId: string) {
	await db
		.update(composePreviews)
		.set({ manualCleanup: true, requestedAt: new Date().toISOString() })
		.where(eq(composePreviews.previewId, previewId));
}

export async function findComposePreview(previewId: string) {
	const preview = await db.query.composePreviews.findFirst({
		where: eq(composePreviews.previewId, previewId),
	});
	if (!preview) throw new ComposePreviewNotFoundError();
	return preview;
}

export class ComposePreviewNotFoundError extends Error {
	constructor() {
		super("Compose preview not found");
		this.name = "ComposePreviewNotFoundError";
	}
}

async function updatePreview(
	previewId: string,
	input: Partial<ComposePreview>,
) {
	await db
		.update(composePreviews)
		.set(input)
		.where(eq(composePreviews.previewId, previewId));
}

/** Cleanup only resources labelled with this exact project. Never prune the
 * host, reuse staging mounts, or forget the DB record after a failed cleanup. */
export async function cleanupComposePreview(preview: ComposePreview) {
	await updatePreview(preview.previewId, { status: "removing" });
	if (preview.composeId) {
		const instance = await findComposeById(preview.composeId);
		if (
			instance.previewParentId !== preview.sourceComposeId ||
			!instance.serverId ||
			instance.serverId !== preview.serverId
		)
			throw new ComposePreviewError("Preview ownership mismatch");
		await cleanupComposePreviewStack(instance, preview.previewId);
	}
	await releasePreviewRecords(preview);
}

/** Drop the instance rows and mark the preview closed (after a cleanup). */
async function releasePreviewRecords(
	preview: ComposePreview,
	extra: Partial<ComposePreview> = {},
) {
	await db.transaction(async (tx) => {
		await tx
			.update(composePreviews)
			.set({
				composeId: null,
				environmentId: null,
				serverId: null,
				status: "closed",
				error: null,
				deployedSha: null,
				reconciledAt: preview.requestedAt,
				...extra,
			})
			.where(eq(composePreviews.previewId, preview.previewId));
		if (preview.composeId)
			await tx.delete(compose).where(eq(compose.composeId, preview.composeId));
		if (preview.environmentId)
			await tx
				.delete(environments)
				.where(eq(environments.environmentId, preview.environmentId));
	});
}

/**
 * Last resort when a preview's worker or manager is gone for good and its
 * cleanup can never succeed: forget the records without contacting any
 * server, so the source, its project and the server can be deleted again.
 * Whatever still runs on the lost machine must be removed by hand. The
 * preview stays removed until someone redeploys it.
 */
export async function forgetComposePreview(previewId: string) {
	const token = await acquirePreviewLease(previewId);
	if (!token)
		throw new ComposePreviewError(
			"This PR environment is being deployed or removed; try again once that run ends",
		);
	try {
		const preview = await findComposePreview(previewId);
		if (preview.status !== "error")
			throw new ComposePreviewError(
				"Only a failed PR environment can be forgotten; remove it normally instead",
			);
		if (preview.serverId && (await isPreviewWorkerReachable(preview.serverId)))
			throw new ComposePreviewError(
				"The worker still answers: use Remove environment, which also stops its stack. Forget is only for a worker that is gone",
			);
		await releasePreviewRecords(preview, { manualCleanup: true });
		return preview;
	} finally {
		await releasePreviewLease(previewId, token);
	}
}

type Source = Awaited<ReturnType<typeof findComposeById>>;

async function allocatePreview(
	preview: ComposePreview,
	source: Source,
	branch: string,
	sha: string,
) {
	const settings = composePreviewSettingsSchema.parse(source.previewSettings);
	const appName = previewAppName(source.composeId, preview.pullRequestNumber);
	return db.transaction(async (tx) => {
		// Serialize capacity checks across all source apps targeting this worker.
		const [worker] = await tx
			.select()
			.from(server)
			.where(eq(server.serverId, settings.serverId))
			.for("update");
		if (
			!worker ||
			worker.organizationId !== source.environment.project.organizationId ||
			worker.serverType !== "deploy" ||
			worker.serverStatus !== "active" ||
			!worker.sshKeyId ||
			!worker.swarmNodeId ||
			// PR code never shares a server with regular services.
			!worker.previewOnly
		)
			throw new ComposePreviewError(
				"Preview worker is unavailable: it must be an active deployment server with an SSH key, a configured Swarm worker, and be reserved for previews",
			);
		const current = await tx.query.composePreviews.findFirst({
			where: eq(composePreviews.previewId, preview.previewId),
		});
		if (current?.composeId) return current;
		const [[used], [sourceUsed]] = await Promise.all([
			tx
				.select({ count: count() })
				.from(composePreviews)
				.where(
					and(
						eq(composePreviews.serverId, worker.serverId),
						isNotNull(composePreviews.composeId),
					),
				),
			tx
				.select({ count: count() })
				.from(composePreviews)
				.where(
					and(
						eq(composePreviews.sourceComposeId, source.composeId),
						isNotNull(composePreviews.composeId),
					),
				),
		]);
		// Retried on every reconciler tick, so it starts once a slot frees up.
		if ((used?.count || 0) >= worker.previewCapacity)
			throw new ComposePreviewError(
				`Waiting for capacity: worker ${worker.name} already runs ${used?.count} of ${worker.previewCapacity} PR environments. It starts when one closes.`,
			);
		if ((sourceUsed?.count || 0) >= settings.limit)
			throw new ComposePreviewError(
				`Waiting for capacity: ${source.name} already has ${sourceUsed?.count} of ${settings.limit} PR environments. It starts when one closes.`,
			);
		const [environment] = await tx
			.insert(environments)
			.values({
				name: `${source.name} · PR #${preview.pullRequestNumber}`,
				projectId: source.environment.projectId,
				description: "Ephemeral Compose preview",
				env: "",
			})
			.returning();
		if (!environment) throw new Error("Unable to create preview environment");
		const domainValues = source.domains.map((domain) => {
			if (!domain.serviceName)
				throw new ComposePreviewError(
					"Every domain of the source Compose needs a service name to be copied to PR environments",
				);
			return {
				host: previewHost(
					appName,
					domain.serviceName,
					settings.domain,
					String(domain.uniqueConfigKey),
				),
				serviceName: domain.serviceName,
				port: domain.port,
				path: domain.path,
				internalPath: domain.internalPath,
				stripPath: domain.stripPath,
				https: settings.https,
				certificateType: settings.certificateType,
				domainType: "compose" as const,
			};
		});
		if (!domainValues.length)
			throw new ComposePreviewError(
				"Add a domain to the source Compose: PR environments reuse its services and ports to build their URLs",
			);
		const generated: Record<string, string> = {
			DOKPLOY_PR_NUMBER: String(preview.pullRequestNumber),
			DOKPLOY_PR_BRANCH: branch,
			DOKPLOY_PREVIEW_PASSWORD: randomBytes(24).toString("hex"),
			DOKPLOY_DEPLOY_URL: `${settings.https ? "https" : "http"}://${domainValues[0]?.host}`,
		};
		for (const domain of domainValues) {
			const prefix = `DOKPLOY_PREVIEW_${domain.serviceName.replace(/[^a-z0-9]/gi, "_").toUpperCase()}`;
			const url = `${settings.https ? "https" : "http"}://${domain.host}`;
			generated[`${prefix}_URL`] ??= url;
			generated[`${prefix}_${domain.port}_URL`] ??= url;
			generated[`${prefix}_${domain.port}_WS_URL`] ??= url.replace(
				/^http/,
				"ws",
			);
		}

		const previewEnv = source.previewEnv.replace(
			/\$\{\{([A-Z0-9_]+)\}\}/g,
			(match, key: string) => generated[key] ?? match,
		);
		const [instance] = await tx
			.insert(compose)
			.values({
				composeId: nanoid(),
				name: `${source.name} · PR #${preview.pullRequestNumber}`,
				appName,
				environmentId: environment.environmentId,
				serverId: worker.serverId,
				sourceType: "github",
				owner: source.owner,
				repository: source.repository,
				githubId: source.githubId,
				branch,
				previewCommitSha: sha,
				composePath: settings.composePath,
				autoDeploy: false,
				composeType: "stack",
				previewParentId: source.composeId,
				previewSettings: { ...settings, enabled: false },
				previewComposeFile: source.previewComposeFile,
				env: `${previewEnv}\n${Object.entries(generated)
					.map(([key, value]) => `${key}=${JSON.stringify(value)}`)
					.join("\n")}`,
				enableSubmodules: source.enableSubmodules,
			})
			.returning();
		if (!instance) throw new Error("Unable to create preview Compose");
		await tx.insert(domains).values(
			domainValues.map((domain) => ({
				...domain,
				composeId: instance.composeId,
			})),
		);
		const [allocated] = await tx
			.update(composePreviews)
			.set({
				composeId: instance.composeId,
				environmentId: environment.environmentId,
				serverId: worker.serverId,
				branch,
				expiresAt: new Date(
					Date.now() + settings.ttlHours * 3600000,
				).toISOString(),
			})
			.where(eq(composePreviews.previewId, preview.previewId))
			.returning();
		if (!allocated) throw new Error("Unable to allocate preview");
		return allocated;
	});
}

/** A lifecycle lease outlives a crashed process by at most this long. */
const PREVIEW_LEASE_MS = 10 * 60_000;
const PREVIEW_LEASE_RENEW_MS = 2 * 60_000;

/**
 * Take the preview's lifecycle lease. A row lease, not a transaction-scoped
 * advisory lock: a deploy runs for minutes and must not pin a pooled
 * connection meanwhile. Returns null when another run holds it.
 */
export async function acquirePreviewLease(previewId: string) {
	const token = nanoid();
	const now = new Date();
	const [leased] = await db
		.update(composePreviews)
		.set({
			lockedBy: token,
			lockedUntil: new Date(now.getTime() + PREVIEW_LEASE_MS).toISOString(),
		})
		.where(
			and(
				eq(composePreviews.previewId, previewId),
				or(
					isNull(composePreviews.lockedUntil),
					lt(composePreviews.lockedUntil, now.toISOString()),
				),
			),
		)
		.returning({ previewId: composePreviews.previewId });
	return leased ? token : null;
}

export async function releasePreviewLease(previewId: string, token: string) {
	await db
		.update(composePreviews)
		.set({ lockedBy: null, lockedUntil: null })
		.where(
			and(
				eq(composePreviews.previewId, previewId),
				eq(composePreviews.lockedBy, token),
			),
		);
}

/**
 * Converge one preview to the state GitHub and its settings ask for. Safe to
 * call concurrently and repeatedly: runs for the same preview are serialized
 * by a lease, and a skipped run is picked up by the next reconciler tick
 * because its request stays unreconciled.
 */
export async function reconcileComposePreview(
	previewId: string,
): Promise<void> {
	const token = await acquirePreviewLease(previewId);
	if (!token) {
		console.info(
			`[compose-preview ${previewId}] another run holds the lifecycle lease; the next reconciler tick retries`,
		);
		return;
	}
	const renew = setInterval(() => {
		void db
			.update(composePreviews)
			.set({
				lockedUntil: new Date(Date.now() + PREVIEW_LEASE_MS).toISOString(),
			})
			.where(
				and(
					eq(composePreviews.previewId, previewId),
					eq(composePreviews.lockedBy, token),
				),
			)
			.catch((error) =>
				console.error(
					`[compose-preview ${previewId}] unable to renew the lifecycle lease: ${error instanceof Error ? error.message : String(error)}`,
				),
			);
	}, PREVIEW_LEASE_RENEW_MS);
	renew.unref();
	try {
		await reconcile(previewId);
	} finally {
		clearInterval(renew);
		await releasePreviewLease(previewId, token);
	}
}

type PullRequest = Awaited<
	ReturnType<ReturnType<typeof authGithub>["rest"]["pulls"]["get"]>
>["data"];

/**
 * Conditional `pulls.get`: GitHub does not count a 304 against the
 * installation rate limit, and the reconciler polls every open preview.
 */
const pullCache = new Map<string, { etag: string; data: PullRequest }>();

async function fetchPullRequest(
	octokit: ReturnType<typeof authGithub>,
	owner: string,
	repo: string,
	pullNumber: number,
) {
	const key = `${owner}/${repo}#${pullNumber}`;
	const cached = pullCache.get(key);
	try {
		const response = await octokit.rest.pulls.get({
			owner,
			repo,
			pull_number: pullNumber,
			headers: cached ? { "if-none-match": cached.etag } : {},
		});
		if (response.headers.etag)
			pullCache.set(key, { etag: response.headers.etag, data: response.data });
		return response.data;
	} catch (error) {
		if (cached && (error as { status?: number }).status === 304)
			return cached.data;
		throw error;
	}
}

function removalReason(
	preview: ComposePreview,
	expired: boolean,
	enabled: boolean,
	pr?: PullRequest,
) {
	if (preview.manualCleanup) return "Removed from Dokploy.";
	if (!enabled) return "PR environments were turned off for this service.";
	if (expired)
		return "Expired after its lifetime without new commits. Push a commit to recreate it.";
	if (pr?.merged) return "The PR was merged.";
	if (pr?.state === "closed") return "The PR was closed.";
	if (pr?.draft) return "The PR was converted to a draft.";
	return "The PR no longer matches the base branch or required labels.";
}

async function reconcile(previewId: string) {
	let preview = await findComposePreview(previewId);
	const source = await findComposeById(preview.sourceComposeId);
	const settings = source.previewSettings;
	const feedback = (
		state: ComposePreviewFeedbackState,
		extra: Partial<ComposePreviewFeedback> = {},
	) =>
		source.githubId && source.owner && source.repository
			? publishComposePreviewFeedback({
					previewId,
					sourceComposeId: source.composeId,
					sourceName: source.name,
					projectId: source.environment.projectId,
					environmentId: source.environmentId,
					githubId: source.githubId,
					owner: source.owner,
					repository: source.repository,
					pullRequestNumber: preview.pullRequestNumber,
					state,
					...extra,
				})
			: Promise.resolve();
	const remove = async (pr?: PullRequest) => {
		const wasActive = preview.status !== "closed";
		await cleanupComposePreview(preview);
		pullCache.delete(
			`${source.owner}/${source.repository}#${preview.pullRequestNumber}`,
		);
		if (wasActive)
			await feedback("removed", {
				error: removalReason(preview, expired, !!settings?.enabled, pr),
			});
	};
	const expired =
		!!preview.expiresAt && preview.expiresAt <= new Date().toISOString();
	let announced = false;
	try {
		if (preview.manualCleanup || expired || !settings?.enabled) {
			await remove();
			return;
		}
		if (
			!source.githubId ||
			source.sourceType !== "github" ||
			source.previewParentId ||
			!source.owner ||
			!source.repository
		)
			throw new ComposePreviewError("Compose previews require a GitHub source");
		const provider = await findGithubById(source.githubId);
		const octokit = authGithub(provider);
		// Query authoritative state. Webhook deliveries can be duplicated, delayed
		// or reordered; never deploy their branch/SHA blindly.
		const pr = await fetchPullRequest(
			octokit,
			source.owner,
			source.repository,
			preview.pullRequestNumber,
		);
		const requiredLabels = new Set(settings.labels);
		const hasLabel =
			!requiredLabels.size ||
			pr.labels.some((label) => requiredLabels.has(label.name));
		if (
			pr.state !== "open" ||
			pr.draft ||
			pr.base.ref !== settings.baseBranch ||
			!hasLabel
		) {
			await remove(pr);
			return;
		}
		if (pr.head.repo?.id !== pr.base.repo.id || !pr.user)
			throw new ComposePreviewError(
				"PRs from forks do not get an environment; push the branch to this repository",
			);
		// Up to date: nothing to rebuild. Checked before the permission call so
		// polling a ready preview costs a single (usually 304) GitHub request.
		if (
			preview.deployedSha === pr.head.sha &&
			preview.composeId &&
			preview.status === "ready"
		) {
			await updatePreview(previewId, {
				reconciledAt: preview.requestedAt,
				// Safety net: a running environment always has a lifetime.
				...(!preview.expiresAt
					? {
							expiresAt: new Date(
								Date.now() + settings.ttlHours * 3_600_000,
							).toISOString(),
						}
					: {}),
			});
			return;
		}
		// Keep polling PR closure/expiry, but do not rebuild a failing commit
		// every minute. A new SHA, webhook or explicit retry releases this guard.
		if (
			preview.status === "error" &&
			preview.composeId &&
			preview.reconciledAt === preview.requestedAt &&
			(await findComposeById(preview.composeId)).previewCommitSha ===
				pr.head.sha
		)
			return;
		if (preview.authorizedSha !== pr.head.sha) {
			const permission = await checkUserRepositoryPermissions(
				provider,
				source.owner,
				source.repository,
				pr.user.login,
			);
			if (!permission.hasWriteAccess)
				throw new ComposePreviewError(
					`@${pr.user.login} needs write access to the repository to get a PR environment`,
				);
		}
		await updatePreview(previewId, {
			branch: pr.head.ref,
			url: pr.html_url,
			authorizedSha: pr.head.sha,
			error: null,
		});
		if (!preview.composeId)
			preview = await allocatePreview(
				preview,
				source,
				pr.head.ref,
				pr.head.sha,
			);
		if (!preview.composeId)
			throw new ComposePreviewError("Preview has no Compose instance");
		const instanceId = preview.composeId;
		// Sliding lifetime: every deployed commit restarts it.
		const expiresAt = new Date(
			Date.now() + settings.ttlHours * 3_600_000,
		).toISOString();
		await updatePreview(previewId, { status: "deploying", expiresAt });
		await updateCompose(instanceId, {
			branch: pr.head.ref,
			previewCommitSha: pr.head.sha,
		});
		const instance = await findComposeById(instanceId);
		const urls = instance.domains.map((domain) => ({
			service: domain.serviceName || "",
			url: `${domain.https ? "https" : "http"}://${domain.host}${domain.path && domain.path !== "/" ? domain.path : ""}`,
		}));
		const logsPath = `/dashboard/project/${source.environment.projectId}/environment/${instance.environmentId}/services/compose/${instanceId}`;
		await feedback("deploying", { sha: pr.head.sha, urls, logsPath });
		announced = true;
		await deployComposePreviewStack(instanceId, preview.previewId);
		await updatePreview(previewId, {
			status: "ready",
			deployedSha: pr.head.sha,
			error: null,
			reconciledAt: preview.requestedAt,
		});
		await feedback("ready", { sha: pr.head.sha, urls, logsPath, expiresAt });
	} catch (error) {
		const message = isComposePreviewError(error)
			? error.message.slice(0, 500)
			: "Compose preview failed; see the deployment log";
		if (!isComposePreviewError(error))
			console.error(
				// Formatted: a local command error would otherwise carry the command.
				`[compose-preview ${previewId}] PR #${preview.pullRequestNumber} of ${source.name} failed: ${formatDeploymentError(error).split("\n")[0]}`,
			);
		await updatePreview(previewId, {
			status: "error",
			error: message,
			reconciledAt: preview.requestedAt,
		});
		const current = await findComposePreview(previewId);
		// Waiting previews are retried every minute: only tell the PR when the
		// reason changes, not on every attempt.
		// A run that already announced "Deploying" must always report back.
		if (announced || preview.status !== "error" || preview.error !== message)
			await feedback("error", {
				error: message,
				sha: current.authorizedSha,
				logsPath: current.composeId
					? `/dashboard/project/${source.environment.projectId}/environment/${current.environmentId}/services/compose/${current.composeId}`
					: null,
			});
		throw error;
	}
}
