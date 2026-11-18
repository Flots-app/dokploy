import { db } from "@dokploy/server/db";
import { composePreviews } from "@dokploy/server/db/schema";
import { eq } from "drizzle-orm";
import { authGithub } from "../utils/providers/github";
import { getDokployUrl } from "./admin";
import { findGithubById } from "./github";

/** States shown to developers on the pull request. */
export type ComposePreviewFeedbackState =
	| "deploying"
	| "ready"
	| "error"
	| "removed";

export interface ComposePreviewFeedback {
	previewId: string;
	sourceComposeId: string;
	sourceName: string;
	projectId: string;
	environmentId: string;
	githubId: string;
	owner: string;
	repository: string;
	pullRequestNumber: number;
	state: ComposePreviewFeedbackState;
	sha?: string | null;
	error?: string | null;
	expiresAt?: string | null;
	urls?: { service: string; url: string }[];
	/** Instance deployments tab, when the preview still has one. */
	logsPath?: string | null;
}

const STATE_LABEL: Record<ComposePreviewFeedbackState, string> = {
	deploying: "🔄 Deploying",
	ready: "✅ Ready",
	error: "❌ Failed",
	removed: "🗑️ Removed",
};

/** Hidden marker so humans and tools can tell which Compose owns the comment. */
export const composePreviewCommentMarker = (sourceComposeId: string) =>
	`<!-- dokploy-compose-preview:${sourceComposeId} -->`;

const escapeCell = (value: string) =>
	value.replaceAll("|", "\\|").replaceAll("\n", " ");

/** Render the sticky PR comment. Pure, so it is unit tested. */
export function renderComposePreviewComment(
	input: Omit<ComposePreviewFeedback, "githubId" | "owner" | "repository">,
	dokployUrl: string,
	now = new Date(),
) {
	const lines = [
		composePreviewCommentMarker(input.sourceComposeId),
		`### Dokploy PR environment · ${escapeCell(input.sourceName)}`,
		"",
		`**Status:** ${STATE_LABEL[input.state]}${input.sha ? ` · commit \`${input.sha.slice(0, 7)}\`` : ""}`,
	];
	// For "removed", `error` carries the reason (closed, expired, removed...).
	if ((input.state === "error" || input.state === "removed") && input.error)
		lines.push("", `> ${escapeCell(input.error)}`);
	if (input.state !== "removed" && input.urls?.length) {
		lines.push("", "| Service | URL |", "|---|---|");
		for (const entry of input.urls)
			lines.push(`| ${escapeCell(entry.service)} | ${entry.url} |`);
	}
	if (input.state === "ready" && input.expiresAt)
		lines.push(
			"",
			`Expires ${input.expiresAt.replace("T", " ").slice(0, 16)} UTC unless the PR is updated. Closing or merging the PR removes the environment and its data.`,
		);
	if (input.state === "removed")
		lines.push("", "The environment, its volumes and its images were removed.");
	const base = dokployUrl.replace(/\/+$/, "");
	const sourceLink = `${base}/dashboard/project/${input.projectId}/environment/${input.environmentId}/services/compose/${input.sourceComposeId}?tab=previews`;
	const links = [`[Previews in Dokploy](${sourceLink})`];
	if (input.logsPath && input.state !== "removed")
		links.push(`[Build and deploy logs](${base}${input.logsPath})`);
	lines.push(
		"",
		`<sub>${links.join(" · ")} · updated ${now.toISOString().slice(0, 16).replace("T", " ")} UTC</sub>`,
	);
	return lines.join("\n");
}

/**
 * Create or update the single sticky comment for this preview. GitHub feedback
 * is best effort: a GitHub outage or a missing App permission must never fail
 * or roll back the environment itself, so errors are logged and swallowed.
 */
export async function publishComposePreviewFeedback(
	input: ComposePreviewFeedback,
) {
	try {
		const provider = await findGithubById(input.githubId);
		const octokit = authGithub(provider);
		const body = renderComposePreviewComment(input, await getDokployUrl());
		// Read the id now: an earlier step of the same run may have created it.
		const current = await db.query.composePreviews.findFirst({
			where: eq(composePreviews.previewId, input.previewId),
			columns: { commentId: true },
		});
		if (current?.commentId) {
			try {
				await octokit.rest.issues.updateComment({
					owner: input.owner,
					repo: input.repository,
					comment_id: Number(current.commentId),
					body,
				});
				return;
			} catch (error) {
				// Someone deleted the comment: recreate it below.
				if ((error as { status?: number }).status !== 404) throw error;
			}
		}
		if (input.state === "removed") return;
		const { data } = await octokit.rest.issues.createComment({
			owner: input.owner,
			repo: input.repository,
			issue_number: input.pullRequestNumber,
			body,
		});
		await db
			.update(composePreviews)
			.set({ commentId: String(data.id) })
			.where(eq(composePreviews.previewId, input.previewId));
	} catch (error) {
		console.warn(
			`[compose-preview ${input.previewId}] unable to update the PR #${input.pullRequestNumber} comment on ${input.owner}/${input.repository}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
