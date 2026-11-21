import {
	auditActions,
	auditResourceTypes,
} from "@dokploy/server/db/schema/audit-log-values";
import { getAuditLogs } from "@dokploy/server/services/audit-log";
import { z } from "zod";
import { createTRPCRouter, withPermission } from "../trpc";

export const auditLogRouter = createTRPCRouter({
	all: withPermission("auditLog", "read")
		.input(
			z.object({
				userEmail: z.string().trim().max(254).optional(),
				resourceName: z.string().trim().max(200).optional(),
				action: z.enum(auditActions).optional(),
				resourceType: z.enum(auditResourceTypes).optional(),
				from: z.date().optional(),
				to: z.date().optional(),
				limit: z.number().int().min(1).max(200).default(50),
				offset: z.number().int().min(0).default(0),
			}),
		)
		.query(({ ctx, input }) =>
			getAuditLogs({
				...input,
				organizationId: ctx.session.activeOrganizationId,
			}),
		),
});
