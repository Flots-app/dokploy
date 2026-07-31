import {
	createDatabaseAlertRule,
	disableManagedObservability,
	exportObservabilityArtifacts,
	findDatabaseDeployment,
	getActiveDatabaseAlerts,
	getCurrentMetricValue,
	getDatabaseAlertHistory,
	getDatabaseAlertStates,
	getMetricCatalog,
	getObservabilityState,
	installManagedObservability,
	listDatabaseAlertRules,
	reconcileManagedObservability,
	removeDatabaseAlertRule,
	setDatabaseMonitoringEnabled,
	updateDatabaseAlertRule,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import {
	checkPermission,
	checkServicePermissionAndAccess,
	findMemberByUserId,
} from "@dokploy/server/services/permission";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
	createTRPCRouter,
	protectedProcedure,
	withPermission,
} from "@/server/api/trpc";
import {
	DatabaseAlertRuleInput,
	databaseAlertRules,
	notifications,
	PrometheusDuration,
} from "@/server/db/schema";

const requireGlobalObservabilityAdmin = async (ctx: {
	user: { id: string };
	session: { activeOrganizationId: string };
}) => {
	const member = await findMemberByUserId(
		ctx.user.id,
		ctx.session.activeOrganizationId,
	);
	if (member.role !== "owner" && member.role !== "admin") {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: "Only organization owners and admins can manage the stack",
		});
	}
};

const requireService = async ({
	ctx,
	serviceId,
	action,
}: {
	ctx: {
		user: { id: string };
		session: { activeOrganizationId: string };
	};
	serviceId: string;
	action: "read" | "create" | "update" | "delete";
}) => {
	await checkServicePermissionAndAccess(ctx, serviceId, {
		monitoring: [action],
	});
	const database = await findDatabaseDeployment(serviceId);
	if (
		!database ||
		database.organizationId !== ctx.session.activeOrganizationId
	) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Database not found" });
	}
	return database;
};

export const observabilityRouter = createTRPCRouter({
	state: withPermission("monitoring", "read").query(async ({ ctx }) =>
		getObservabilityState(ctx.session.activeOrganizationId),
	),

	install: protectedProcedure
		.input(z.object({ publicUrl: z.string().url() }))
		.mutation(async ({ ctx, input }) => {
			await requireGlobalObservabilityAdmin(ctx);
			await checkPermission(ctx, { monitoring: ["create"] });
			return installManagedObservability({
				organizationId: ctx.session.activeOrganizationId,
				publicUrl: input.publicUrl,
			});
		}),

	reconcile: protectedProcedure.mutation(async ({ ctx }) => {
		await requireGlobalObservabilityAdmin(ctx);
		await checkPermission(ctx, { monitoring: ["update"] });
		return reconcileManagedObservability(ctx.session.activeOrganizationId);
	}),

	disable: protectedProcedure.mutation(async ({ ctx }) => {
		await requireGlobalObservabilityAdmin(ctx);
		await checkPermission(ctx, { monitoring: ["delete"] });
		await disableManagedObservability(ctx.session.activeOrganizationId);
		return true;
	}),

	setDatabaseEnabled: protectedProcedure
		.input(z.object({ serviceId: z.string().min(1), enabled: z.boolean() }))
		.mutation(async ({ ctx, input }) => {
			await requireService({
				ctx,
				serviceId: input.serviceId,
				action: "update",
			});
			return setDatabaseMonitoringEnabled(input);
		}),

	catalog: withPermission("monitoring", "read")
		.input(z.object({ serviceId: z.string().min(1) }))
		.query(async ({ ctx, input }) => {
			const database = await requireService({
				ctx,
				serviceId: input.serviceId,
				action: "read",
			});
			return getMetricCatalog(database.databaseType);
		}),

	currentValue: withPermission("monitoring", "read")
		.input(
			z.object({
				serviceId: z.string().min(1),
				metricKey: z.string().min(1),
				lookbackWindow: PrometheusDuration.optional(),
			}),
		)
		.query(async ({ ctx, input }) => {
			await requireService({
				ctx,
				serviceId: input.serviceId,
				action: "read",
			});
			return getCurrentMetricValue(input);
		}),

	destinations: withPermission("monitoring", "read").query(async ({ ctx }) =>
		db
			.select({
				notificationId: notifications.notificationId,
				name: notifications.name,
				notificationType: notifications.notificationType,
			})
			.from(notifications)
			.where(
				eq(notifications.organizationId, ctx.session.activeOrganizationId),
			),
	),

	rules: withPermission("monitoring", "read")
		.input(z.object({ serviceId: z.string().min(1) }))
		.query(async ({ ctx, input }) => {
			await requireService({
				ctx,
				serviceId: input.serviceId,
				action: "read",
			});
			return listDatabaseAlertRules({
				organizationId: ctx.session.activeOrganizationId,
				serviceId: input.serviceId,
			});
		}),

	createRule: protectedProcedure
		.input(DatabaseAlertRuleInput)
		.mutation(async ({ ctx, input }) => {
			await requireService({
				ctx,
				serviceId: input.serviceId,
				action: "create",
			});
			return createDatabaseAlertRule({
				organizationId: ctx.session.activeOrganizationId,
				input,
			});
		}),

	updateRule: protectedProcedure
		.input(
			z.object({
				ruleId: z.string().min(1),
				rule: DatabaseAlertRuleInput,
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const current = await db.query.databaseAlertRules.findFirst({
				where: and(
					eq(databaseAlertRules.databaseAlertRuleId, input.ruleId),
					eq(
						databaseAlertRules.organizationId,
						ctx.session.activeOrganizationId,
					),
				),
			});
			if (!current) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Alert rule not found",
				});
			}
			await requireService({
				ctx,
				serviceId: current.serviceId,
				action: "update",
			});
			if (current.serviceId !== input.rule.serviceId) {
				await requireService({
					ctx,
					serviceId: input.rule.serviceId,
					action: "update",
				});
			}
			return updateDatabaseAlertRule({
				organizationId: ctx.session.activeOrganizationId,
				ruleId: input.ruleId,
				input: input.rule,
			});
		}),

	removeRule: protectedProcedure
		.input(z.object({ ruleId: z.string().min(1) }))
		.mutation(async ({ ctx, input }) => {
			const rule = await db.query.databaseAlertRules.findFirst({
				where: and(
					eq(databaseAlertRules.databaseAlertRuleId, input.ruleId),
					eq(
						databaseAlertRules.organizationId,
						ctx.session.activeOrganizationId,
					),
				),
			});
			if (!rule) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Alert rule not found",
				});
			}
			await requireService({
				ctx,
				serviceId: rule.serviceId,
				action: "delete",
			});
			await removeDatabaseAlertRule({
				organizationId: ctx.session.activeOrganizationId,
				ruleId: input.ruleId,
			});
			return true;
		}),

	alertStates: withPermission("monitoring", "read")
		.input(z.object({ serviceId: z.string().min(1) }))
		.query(async ({ ctx, input }) => {
			await requireService({
				ctx,
				serviceId: input.serviceId,
				action: "read",
			});
			return getDatabaseAlertStates(input.serviceId);
		}),

	history: withPermission("monitoring", "read")
		.input(z.object({ serviceId: z.string().min(1) }))
		.query(async ({ ctx, input }) => {
			await requireService({
				ctx,
				serviceId: input.serviceId,
				action: "read",
			});
			return getDatabaseAlertHistory({
				organizationId: ctx.session.activeOrganizationId,
				serviceId: input.serviceId,
			});
		}),

	activeAlerts: withPermission("monitoring", "read").query(async ({ ctx }) => {
		const member = await findMemberByUserId(
			ctx.user.id,
			ctx.session.activeOrganizationId,
		);
		return getActiveDatabaseAlerts({
			organizationId: ctx.session.activeOrganizationId,
			allowedServiceIds:
				member.role === "owner" || member.role === "admin"
					? undefined
					: member.accessedServices,
		});
	}),

	exportArtifacts: withPermission("monitoring", "read")
		.input(z.object({ serviceId: z.string().min(1) }))
		.query(async ({ ctx, input }) => {
			await requireService({
				ctx,
				serviceId: input.serviceId,
				action: "read",
			});
			return exportObservabilityArtifacts(
				ctx.session.activeOrganizationId,
				input.serviceId,
			);
		}),
});
