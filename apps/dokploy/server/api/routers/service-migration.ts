import {
	analyzeServiceMigration,
	finalizeServiceMigration,
	findServiceMigrationById,
	findServiceMigrationsByService,
	getAccessibleServerIds,
	getWebServerSettings,
	IS_CLOUD,
	loadMigrationService,
	startServiceMigration,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import { checkServicePermissionAndAccess } from "@dokploy/server/services/permission";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { createTRPCRouter, protectedProcedure } from "@/server/api/trpc";
import { audit } from "@/server/api/utils/audit";
import {
	apiAnalyzeServiceMigration,
	apiFindServiceMigration,
	apiServiceMigrationHistory,
	apiServiceMigrationTargets,
	apiStartServiceMigration,
	server,
} from "@/server/db/schema";

type Ctx = Parameters<typeof checkServicePermissionAndAccess>[0] & {
	session: { userId: string; activeOrganizationId: string };
};

const authorize = async (ctx: Ctx, serviceId: string) => {
	// Same permission as moving a service between environments.
	await checkServicePermissionAndAccess(ctx, serviceId, {
		service: ["create"],
	});
};

const assertTargetAccess = async (ctx: Ctx, targetServerId: string | null) => {
	if (!targetServerId) return;
	const accessible = await getAccessibleServerIds(ctx.session);
	if (!accessible.has(targetServerId)) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You are not authorized to access this server",
		});
	}
};

export const serviceMigrationRouter = createTRPCRouter({
	targets: protectedProcedure
		.input(apiServiceMigrationTargets)
		.query(async ({ input, ctx }) => {
			await authorize(ctx, input.serviceId);
			const service = await loadMigrationService(
				input.serviceType,
				input.serviceId,
			);
			if (service.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to access this service",
				});
			}
			const accessible = await getAccessibleServerIds(ctx.session);
			const servers = await db.query.server.findMany({
				where: and(
					eq(server.organizationId, ctx.session.activeOrganizationId),
					eq(server.serverType, "deploy"),
					isNotNull(server.sshKeyId),
				),
				columns: {
					serverId: true,
					name: true,
					ipAddress: true,
					serverStatus: true,
				},
				orderBy: asc(server.name),
			});
			const settings = await getWebServerSettings();
			return {
				currentServerId: service.serverId,
				supportsZeroDowntime: service.supportsZeroDowntime,
				allowDokployServer:
					!IS_CLOUD &&
					!settings?.remoteServersOnly &&
					service.serverId !== null,
				servers: servers.filter(
					(item) =>
						accessible.has(item.serverId) &&
						item.serverId !== service.serverId &&
						item.serverId !== service.buildServerId,
				),
			};
		}),

	analyze: protectedProcedure
		.input(apiAnalyzeServiceMigration)
		.mutation(async ({ input, ctx }) => {
			await authorize(ctx, input.serviceId);
			await assertTargetAccess(ctx, input.targetServerId);
			const analysis = await analyzeServiceMigration({
				...input,
				organizationId: ctx.session.activeOrganizationId,
			});
			return {
				source: analysis.source,
				target: analysis.target,
				checks: analysis.checks,
				plan: analysis.plan,
				canMigrate: analysis.canMigrate,
				requiresDowntime: analysis.requiresDowntime,
				totalBytes: analysis.totalBytes,
			};
		}),

	start: protectedProcedure
		.input(apiStartServiceMigration)
		.mutation(async ({ input, ctx }) => {
			await authorize(ctx, input.serviceId);
			await assertTargetAccess(ctx, input.targetServerId);
			const migration = await startServiceMigration({
				...input,
				organizationId: ctx.session.activeOrganizationId,
				userId: ctx.user.id,
			});
			await audit(ctx, {
				action: "update",
				resourceType: input.serviceType === "compose" ? "compose" : "service",
				resourceId: input.serviceId,
				resourceName: migration.appName,
				metadata: {
					operation: "server-migration",
					from: migration.sourceServerName,
					to: migration.targetServerName,
				},
			});
			return { serviceMigrationId: migration.serviceMigrationId };
		}),

	finalize: protectedProcedure
		.input(apiFindServiceMigration)
		.mutation(async ({ input, ctx }) => {
			const migration = await findServiceMigrationById(
				input.serviceMigrationId,
			);
			if (migration.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to access this migration",
				});
			}
			await authorize(ctx, migration.serviceId);
			await finalizeServiceMigration(input.serviceMigrationId);
			await audit(ctx, {
				action: "update",
				resourceType:
					migration.serviceType === "compose" ? "compose" : "service",
				resourceId: migration.serviceId,
				resourceName: migration.appName,
				metadata: {
					operation: "server-migration-finalize",
					source: migration.sourceServerName,
				},
			});
			return true;
		}),

	one: protectedProcedure
		.input(apiFindServiceMigration)
		.query(async ({ input, ctx }) => {
			const migration = await findServiceMigrationById(
				input.serviceMigrationId,
			);
			if (migration.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to access this migration",
				});
			}
			await authorize(ctx, migration.serviceId);
			return migration;
		}),

	history: protectedProcedure
		.input(apiServiceMigrationHistory)
		.query(async ({ input, ctx }) => {
			await authorize(ctx, input.serviceId);
			const migrations = await findServiceMigrationsByService(input.serviceId);
			return migrations.filter(
				(migration) =>
					migration.organizationId === ctx.session.activeOrganizationId,
			);
		}),
});
