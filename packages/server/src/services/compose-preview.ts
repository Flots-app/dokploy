import { randomBytes } from "node:crypto";
import { db } from "@dokploy/server/db";
import {
	compose,
	composePreviews,
	domains,
	environments,
	server,
} from "@dokploy/server/db/schema";
import { and, count, eq, isNotNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { composePreviewSettingsSchema } from "../db/validations/compose-preview";
import { previewAppName, previewHost } from "../utils/docker/compose-preview";
import {
	authGithub,
	checkUserRepositoryPermissions,
} from "../utils/providers/github";
import { findComposeById, updateCompose } from "./compose";
import {
	cleanupComposePreviewStack,
	deployComposePreviewStack,
} from "./compose-preview-stack";
import { findGithubById } from "./github";

export type ComposePreview = typeof composePreviews.$inferSelect;

export async function requestComposePreview(
	sourceComposeId: string,
	pullRequestNumber: number,
	resume = false,
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
				...(resume
					? { manualCleanup: false, expiresAt: null, deployedSha: null }
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
	if (!preview) throw new Error("Compose preview not found");
	return preview;
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
			throw new Error("Preview ownership mismatch");
		await cleanupComposePreviewStack(instance, preview.previewId);
	}
	await db.transaction(async (tx) => {
		await tx
			.update(composePreviews)
			.set({
				composeId: null,
				environmentId: null,
				serverId: null,
				status: "closed",
				error: null,
				reconciledAt: preview.requestedAt,
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
			!worker.swarmNodeId
		)
			throw new Error("Preview worker is unavailable");
		const current = await tx.query.composePreviews.findFirst({
			where: eq(composePreviews.previewId, preview.previewId),
		});
		if (current?.composeId) return current;
		const [used] = await tx
			.select({ count: count() })
			.from(composePreviews)
			.where(
				and(
					eq(composePreviews.serverId, worker.serverId),
					isNotNull(composePreviews.composeId),
				),
			);
		const [sourceUsed] = await tx
			.select({ count: count() })
			.from(composePreviews)
			.where(
				and(
					eq(composePreviews.sourceComposeId, source.composeId),
					isNotNull(composePreviews.composeId),
				),
			);
		if (
			(used?.count || 0) >= worker.previewCapacity ||
			(sourceUsed?.count || 0) >= settings.limit
		)
			throw new Error(
				"Preview capacity reached; close an existing preview or increase the limit",
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
				throw new Error("Preview domains need a Compose service name");
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
			throw new Error(
				"Add a domain to the source Compose so previews have a route",
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

// The deployment queue serializes work by preview id. This process-wide guard
// also covers direct callers and duplicate module instances in development.
const globalPreviews = globalThis as unknown as {
	dokployComposePreviewLocks?: Map<string, Promise<void>>;
};
globalPreviews.dokployComposePreviewLocks ??= new Map();
const locks = globalPreviews.dokployComposePreviewLocks;

export async function reconcileComposePreview(
	previewId: string,
): Promise<void> {
	const previous = locks.get(previewId) || Promise.resolve();
	const operation = previous
		.catch(() => {})
		.then(() =>
			db.transaction(async (tx) => {
				const [lock] = await tx.execute<{ acquired: boolean }>(
					sql`select pg_try_advisory_xact_lock(hashtext('dokploy-compose-preview'), hashtext(${previewId})) as acquired`,
				);
				if (lock?.acquired) await reconcile(previewId);
			}),
		);
	locks.set(previewId, operation);
	try {
		await operation;
	} finally {
		if (locks.get(previewId) === operation) locks.delete(previewId);
	}
}

async function reconcile(previewId: string) {
	let preview = await findComposePreview(previewId);
	try {
		const source = await findComposeById(preview.sourceComposeId);
		const settings = source.previewSettings;
		const expired =
			!!preview.expiresAt && preview.expiresAt <= new Date().toISOString();
		if (preview.manualCleanup || expired || !settings?.enabled) {
			await cleanupComposePreview(preview);
			return;
		}
		if (
			!source.githubId ||
			source.sourceType !== "github" ||
			source.previewParentId ||
			!source.owner ||
			!source.repository
		)
			throw new Error("Compose previews require a GitHub source");
		const provider = await findGithubById(source.githubId);
		const octokit = authGithub(provider);
		// Query authoritative state. Webhook deliveries can be duplicated, delayed
		// or reordered; never deploy their branch/SHA blindly.
		const { data: pr } = await octokit.rest.pulls.get({
			owner: source.owner,
			repo: source.repository,
			pull_number: preview.pullRequestNumber,
		});
		const hasLabel =
			!settings.labels.length ||
			pr.labels.some((label) => settings.labels.includes(label.name));
		if (
			pr.state !== "open" ||
			pr.draft ||
			pr.base.ref !== settings.baseBranch ||
			!hasLabel
		) {
			await cleanupComposePreview(preview);
			return;
		}
		if (pr.head.repo?.id !== pr.base.repo.id || !pr.user)
			throw new Error("Compose previews require a PR from the same repository");
		const permission = await checkUserRepositoryPermissions(
			provider,
			source.owner,
			source.repository,
			pr.user.login,
		);
		if (!permission.hasWriteAccess)
			throw new Error(
				"The PR author needs write access to deploy a Compose preview",
			);
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
		await updatePreview(previewId, {
			branch: pr.head.ref,
			url: pr.html_url,
			error: null,
		});
		if (
			preview.deployedSha === pr.head.sha &&
			preview.composeId &&
			preview.status === "ready"
		) {
			await updatePreview(previewId, { reconciledAt: preview.requestedAt });
			return;
		}
		if (!preview.composeId)
			preview = await allocatePreview(
				preview,
				source,
				pr.head.ref,
				pr.head.sha,
			);
		if (!preview.composeId) throw new Error("Preview has no Compose instance");
		await updatePreview(previewId, {
			status: "deploying",
			...(!preview.expiresAt
				? {
						expiresAt: new Date(
							Date.now() + settings.ttlHours * 3600000,
						).toISOString(),
					}
				: {}),
		});
		await updateCompose(preview.composeId, {
			branch: pr.head.ref,
			previewCommitSha: pr.head.sha,
		});
		await deployComposePreviewStack(preview.composeId, preview.previewId);
		await updatePreview(previewId, {
			status: "ready",
			deployedSha: pr.head.sha,
			error: null,
			reconciledAt: preview.requestedAt,
		});
	} catch (error) {
		// Full diagnostics remain in deployment logs; do not persist command text
		// here because providers/SSH errors may include credentials.
		const message =
			error instanceof Error
				? /^(Preview |Compose previews |The PR author |Add a domain |Configure this server)/.test(
						error.message,
					) && !error.message.includes("\n")
					? error.message.slice(0, 300)
					: "Compose preview failed; see deployment logs"
				: "Compose preview failed";
		await updatePreview(previewId, {
			status: "error",
			error: message || "Compose preview failed",
			reconciledAt: preview.requestedAt,
		});
		throw error;
	}
}
