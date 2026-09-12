import { IS_CLOUD } from "@dokploy/server/constants";
import { db } from "@dokploy/server/db";
import { compose, composePreviews, server } from "@dokploy/server/db/schema";
import { apiUpdateComposePreviewSettings } from "@dokploy/server/db/validations/compose-preview";
import { findComposeById } from "@dokploy/server/services/compose";
import {
	findComposePreview,
	requestComposePreview,
	requestComposePreviewCleanup,
} from "@dokploy/server/services/compose-preview";
import { assertPreviewSwarmWorker } from "@dokploy/server/services/compose-preview-stack";
import { canEditDeployGitSource } from "@dokploy/server/services/git-provider";
import {
	checkServiceAccess,
	checkServicePermissionAndAccess,
} from "@dokploy/server/services/permission";
import { findRegistryById } from "@dokploy/server/services/registry";
import { getAccessibleServerIds } from "@dokploy/server/services/server";
import {
	isolatePreviewCompose,
	previewAppName,
} from "@dokploy/server/utils/docker/compose-preview";
import { TRPCError } from "@trpc/server";
import { desc, eq } from "drizzle-orm";
import { parse } from "yaml";
import { z } from "zod";
import { enqueueComposePreview } from "@/server/queues/compose-previews";
import { createTRPCRouter, protectedProcedure } from "../trpc";
import { audit } from "../utils/audit";

const sourceInput = z.object({ composeId: z.string().min(1) });

async function sourceForOrganization(
	composeId: string,
	organizationId: string,
) {
	const source = await findComposeById(composeId);
	if (source.environment.project.organizationId !== organizationId)
		throw new TRPCError({ code: "NOT_FOUND", message: "Compose not found" });
	return source;
}

async function checkPreviewTargets(
	source: Awaited<ReturnType<typeof findComposeById>>,
	session: { userId: string; activeOrganizationId: string },
	settings: { serverId: string; registryId: string },
) {
	if (
		!source.github?.gitProviderId ||
		!(await canEditDeployGitSource(source.github.gitProviderId, session))
	)
		throw new TRPCError({
			code: "FORBIDDEN",
			message: "Git provider access is required to deploy previews",
		});
	const accessible = await getAccessibleServerIds(session);
	if (!accessible.has(settings.serverId))
		throw new TRPCError({
			code: "FORBIDDEN",
			message: "Preview worker access is required",
		});
	const registry = await findRegistryById(settings.registryId);
	if (registry.organizationId !== session.activeOrganizationId)
		throw new TRPCError({
			code: "FORBIDDEN",
			message: "Select a registry from this organization",
		});
}

export const composePreviewRouter = createTRPCRouter({
	settings: protectedProcedure
		.input(sourceInput)
		.query(async ({ ctx, input }) => {
			await checkServicePermissionAndAccess(ctx, input.composeId, {
				envVars: ["read"],
			});
			const source = await sourceForOrganization(
				input.composeId,
				ctx.session.activeOrganizationId,
			);
			return {
				settings: source.previewSettings,
				env: source.previewEnv,
				composeFile: source.previewComposeFile,
			};
		}),
	updateSettings: protectedProcedure
		.input(apiUpdateComposePreviewSettings)
		.mutation(async ({ ctx, input }) => {
			await checkServicePermissionAndAccess(ctx, input.composeId, {
				service: ["create"],
				envVars: ["write"],
			});
			const source = await sourceForOrganization(
				input.composeId,
				ctx.session.activeOrganizationId,
			);
			if (
				IS_CLOUD ||
				source.sourceType !== "github" ||
				source.composeType !== "docker-compose" ||
				source.previewParentId ||
				!source.githubId
			)
				throw new TRPCError({
					code: "BAD_REQUEST",
					message:
						"Previews require a self-hosted GitHub Docker Compose source",
				});
			const accessible = await getAccessibleServerIds(ctx.session);
			const worker = await db.query.server.findFirst({
				where: eq(server.serverId, input.settings.serverId),
			});
			if (
				!worker ||
				!accessible.has(worker.serverId) ||
				worker.organizationId !== source.environment.project.organizationId ||
				worker.serverType !== "deploy" ||
				worker.serverStatus !== "active" ||
				!worker.sshKeyId
			)
				throw new TRPCError({
					code: "BAD_REQUEST",
					message:
						"Select an accessible, active deployment worker with an SSH key",
				});
			await checkPreviewTargets(source, ctx.session, input.settings);
			if (input.settings.enabled)
				await assertPreviewSwarmWorker(input.settings.serverId);
			if (input.composeFile.trim())
				isolatePreviewCompose(
					parse(input.composeFile),
					previewAppName(source.composeId, 1),
					input.settings,
				);
			await db
				.update(compose)
				.set({
					previewSettings: input.settings,
					previewEnv: input.env,
					previewComposeFile: input.composeFile,
				})
				.where(eq(compose.composeId, input.composeId));
			const previews = await db.query.composePreviews.findMany({
				where: eq(composePreviews.sourceComposeId, input.composeId),
			});
			if (!input.settings.enabled)
				for (const preview of previews) {
					await requestComposePreview(
						source.composeId,
						preview.pullRequestNumber,
					);
					await enqueueComposePreview(preview.previewId);
				}
			await audit(ctx, {
				action: "update",
				resourceType: "compose",
				resourceId: source.composeId,
				resourceName: source.name,
			});
			return true;
		}),
	all: protectedProcedure.input(sourceInput).query(async ({ ctx, input }) => {
		await sourceForOrganization(
			input.composeId,
			ctx.session.activeOrganizationId,
		);
		await checkServiceAccess(ctx, input.composeId, "read");
		return db.query.composePreviews.findMany({
			where: eq(composePreviews.sourceComposeId, input.composeId),
			orderBy: desc(composePreviews.createdAt),
			with: {
				instance: {
					columns: { composeId: true, name: true, environmentId: true },
					with: { domains: true },
				},
				server: { columns: { name: true } },
			},
		});
	}),
	deploy: protectedProcedure
		.input(
			sourceInput.extend({
				pullRequestNumber: z.number().int().min(1).max(2147483647),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			await checkServicePermissionAndAccess(ctx, input.composeId, {
				deployment: ["create"],
			});
			const source = await sourceForOrganization(
				input.composeId,
				ctx.session.activeOrganizationId,
			);
			if (!source.previewSettings?.enabled || source.previewParentId)
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Enable Compose previews first",
				});
			await checkPreviewTargets(source, ctx.session, source.previewSettings);
			const preview = await requestComposePreview(
				input.composeId,
				input.pullRequestNumber,
				true,
			);
			await enqueueComposePreview(preview.previewId);
			await audit(ctx, {
				action: "deploy",
				resourceType: "compose",
				resourceId: input.composeId,
				resourceName: source.name,
			});
			return { previewId: preview.previewId };
		}),
	remove: protectedProcedure
		.input(z.object({ previewId: z.string().min(1) }))
		.mutation(async ({ ctx, input }) => {
			const preview = await findComposePreview(input.previewId);
			await sourceForOrganization(
				preview.sourceComposeId,
				ctx.session.activeOrganizationId,
			);
			await checkServicePermissionAndAccess(ctx, preview.sourceComposeId, {
				service: ["delete"],
			});
			await requestComposePreviewCleanup(preview.previewId);
			await enqueueComposePreview(preview.previewId);
			await audit(ctx, {
				action: "delete",
				resourceType: "compose",
				resourceId: preview.sourceComposeId,
				resourceName: `PR #${preview.pullRequestNumber}`,
			});
			return true;
		}),
});
