import { IS_CLOUD } from "@dokploy/server/constants";
import { db } from "@dokploy/server/db";
import { compose, composePreviews } from "@dokploy/server/db/schema";
import { requestComposePreview } from "@dokploy/server/services/compose-preview";
import { and, eq, isNotNull } from "drizzle-orm";
import { myQueue } from "./queueSetup";

export async function enqueueComposePreview(previewId: string) {
	if (IS_CLOUD)
		throw new Error(
			"Compose preview workers currently require self-hosted Dokploy",
		);
	const preview = await db.query.composePreviews.findFirst({
		where: eq(composePreviews.previewId, previewId),
		with: { source: true },
	});
	if (!preview) return;
	const jobs = await myQueue.getJobs();
	if (
		jobs.some(
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

export async function handleComposePreviewWebhook(input: {
	githubId: string;
	owner: string;
	repository: string;
	pullRequestNumber: number;
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
		),
	});
	for (const source of sources) {
		if (source.previewParentId) continue;
		const existing = await db.query.composePreviews.findFirst({
			where: and(
				eq(composePreviews.sourceComposeId, source.composeId),
				eq(composePreviews.pullRequestNumber, input.pullRequestNumber),
			),
		});
		if (!source.previewSettings?.enabled && !existing) continue;
		const preview = await requestComposePreview(
			source.composeId,
			input.pullRequestNumber,
		);
		await enqueueComposePreview(preview.previewId);
	}
}

const timers = globalThis as unknown as {
	dokployComposePreviewTimer?: ReturnType<typeof setInterval>;
};

/** Persisted requests survive restarts. Periodic reconciliation also detects
 * closed PRs when GitHub cannot deliver a webhook and enforces preview TTLs. */
export function startComposePreviewReconciler() {
	if (IS_CLOUD || timers.dokployComposePreviewTimer) return;
	let running = false;
	const tick = async () => {
		if (running) return;
		running = true;
		try {
			const previews = await db.query.composePreviews.findMany();
			for (const preview of previews) {
				if (
					preview.status === "closed" &&
					preview.reconciledAt === preview.requestedAt
				)
					continue;
				await enqueueComposePreview(preview.previewId);
			}
		} catch {
			console.error(
				"Unable to reconcile Compose previews; retrying on next tick",
			);
		} finally {
			running = false;
		}
	};
	timers.dokployComposePreviewTimer = setInterval(() => void tick(), 60000);
	timers.dokployComposePreviewTimer.unref();
	void tick();
}
