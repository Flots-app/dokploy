import { IS_CLOUD } from "@dokploy/server/constants";
import { db } from "@dokploy/server/db";
import { compose, composePreviews } from "@dokploy/server/db/schema";
import {
	type ComposePreviewRequest,
	requestComposePreview,
} from "@dokploy/server/services/compose-preview";
import {
	and,
	eq,
	inArray,
	isNotNull,
	isNull,
	like,
	lt,
	ne,
	or,
} from "drizzle-orm";
import { myQueue } from "./queueSetup";

/** How often the reconciler wakes up. */
const RECONCILE_TICK_MS = 60_000;
/** Settled previews (ready or failed) are re-checked every N ticks only;
 * webhooks bring changes in real time, polling only catches missed ones. */
const SETTLED_EVERY_TICKS = 5;
/** Closed previews are kept as tombstones this long, then purged. */
const TOMBSTONE_RETENTION_MS = 30 * 24 * 3_600_000;

export async function enqueueComposePreview(previewId: string) {
	if (IS_CLOUD)
		throw new Error(
			"Compose preview workers currently require self-hosted Dokploy",
		);
	const preview = await db.query.composePreviews.findFirst({
		where: eq(composePreviews.previewId, previewId),
		with: { source: { columns: { previewSettings: true } } },
	});
	if (!preview) return;
	// Only a waiting job makes a new one redundant. A job already running may
	// have read the PR before this request (a push during a deploy), so a
	// follow-up run is queued and converges on the latest commit.
	const waiting = await myQueue.getJobs(["waiting"]);
	if (
		waiting.some(
			(job) =>
				job.data.applicationType === "compose-preview" &&
				job.data.previewId === previewId,
		)
	)
		return;
	await myQueue.add("compose-preview", {
		applicationType: "compose-preview",
		previewId,
		serverId: preview.serverId || preview.source.previewSettings?.serverId,
		type: "deploy",
		titleLog: "Compose preview",
		descriptionLog: "",
	});
}

/** pull_request actions that bring new code: an expired environment comes
 * back on them. A title edit or a label only re-checks eligibility. */
const ACTIVITY_ACTIONS = new Set(["opened", "reopened", "synchronize"]);

export async function handleComposePreviewWebhook(input: {
	githubId: string;
	owner: string;
	repository: string;
	pullRequestNumber: number;
	action?: string;
	baseRef?: string;
	fromFork?: boolean;
	draft?: boolean;
}) {
	if (
		IS_CLOUD ||
		!Number.isSafeInteger(input.pullRequestNumber) ||
		input.pullRequestNumber < 1
	)
		return;
	const sources = await db.query.compose.findMany({
		where: and(
			eq(compose.githubId, input.githubId),
			eq(compose.owner, input.owner),
			eq(compose.repository, input.repository),
			isNotNull(compose.previewSettings),
			isNull(compose.previewParentId),
		),
		columns: { composeId: true, previewSettings: true },
	});
	const reason: ComposePreviewRequest = ACTIVITY_ACTIONS.has(input.action ?? "")
		? "activity"
		: "sync";
	await Promise.all(
		sources.map(async (source) => {
			const existing = await db.query.composePreviews.findFirst({
				where: and(
					eq(composePreviews.sourceComposeId, source.composeId),
					eq(composePreviews.pullRequestNumber, input.pullRequestNumber),
				),
				columns: { previewId: true },
			});
			// Do not record PRs that can never get an environment. The reconciler
			// still re-reads GitHub before acting on anything recorded here.
			const settings = source.previewSettings;
			const eligible =
				!!settings?.enabled &&
				input.action !== "closed" &&
				!input.fromFork &&
				!input.draft &&
				(!input.baseRef || input.baseRef === settings.baseBranch);
			if (!existing && !eligible) return;
			const preview = await requestComposePreview(
				source.composeId,
				input.pullRequestNumber,
				reason,
			);
			await enqueueComposePreview(preview.previewId);
		}),
	);
}

/** Previews the reconciler re-checks on a tick (see RECONCILE_TICK_MS). */
export function reconcileCandidates(now: string, settledToo: boolean) {
	return or(
		// Unhandled requests, whatever their state (restarts land here).
		ne(composePreviews.reconciledAt, composePreviews.requestedAt),
		isNull(composePreviews.reconciledAt),
		// In-flight states, and PRs waiting for a free slot. Other failures
		// (fork, permission, invalid file) wait for the settled poll or a
		// new commit, so they do not call GitHub every minute.
		inArray(composePreviews.status, ["pending", "deploying", "removing"]),
		and(
			eq(composePreviews.status, "error"),
			isNull(composePreviews.composeId),
			like(composePreviews.error, "Waiting for capacity%"),
		),
		// Expired environments.
		and(
			ne(composePreviews.status, "closed"),
			lt(composePreviews.expiresAt, now),
		),
		...(settledToo
			? [inArray(composePreviews.status, ["ready", "error"])]
			: []),
	);
}

const timers = globalThis as unknown as {
	dokployComposePreviewTimer?: ReturnType<typeof setInterval>;
};

/** Persisted requests survive restarts. Periodic reconciliation also detects
 * closed PRs when GitHub cannot deliver a webhook and enforces preview TTLs. */
export function startComposePreviewReconciler() {
	if (IS_CLOUD || timers.dokployComposePreviewTimer) return;
	let running = false;
	let ticks = 0;
	const tick = async () => {
		if (running) return;
		running = true;
		const settledToo = ticks++ % SETTLED_EVERY_TICKS === 0;
		try {
			const now = new Date().toISOString();
			const previews = await db.query.composePreviews.findMany({
				columns: { previewId: true },
				where: reconcileCandidates(now, settledToo),
			});
			// Distinct previews: enqueueing them in parallel cannot duplicate a job.
			await Promise.all(
				previews.map((preview) => enqueueComposePreview(preview.previewId)),
			);
			if (settledToo) {
				const purged = await db
					.delete(composePreviews)
					.where(
						and(
							eq(composePreviews.status, "closed"),
							isNull(composePreviews.composeId),
							lt(
								composePreviews.requestedAt,
								new Date(Date.now() - TOMBSTONE_RETENTION_MS).toISOString(),
							),
						),
					)
					.returning({ previewId: composePreviews.previewId });
				if (purged.length)
					console.info(
						`Compose PR environments: purged ${purged.length} closed record(s) older than 30 days`,
					);
			}
		} catch (error) {
			console.error(
				`Unable to reconcile Compose PR environments; retrying on next tick: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			running = false;
		}
	};
	timers.dokployComposePreviewTimer = setInterval(
		() => void tick(),
		RECONCILE_TICK_MS,
	);
	timers.dokployComposePreviewTimer.unref();
	void tick();
}
