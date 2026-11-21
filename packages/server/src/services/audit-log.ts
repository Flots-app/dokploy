import type { AuditAction, AuditResourceType } from "@dokploy/server/db/schema";

export type { AuditAction, AuditResourceType };

export interface CreateAuditLogInput {
	organizationId: string;
	userId: string;
	userEmail: string;
	userRole: string;
	action: AuditAction;
	resourceType: AuditResourceType;
	resourceId?: string;
	resourceName?: string;
	metadata?: Record<string, unknown>;
}

/**
 * Seam for the audit trail. Every `audit()` call site and the better-auth
 * session hooks go through here.
 *
 * Intentionally a no-op for now: the previous implementation lived in a
 * `proprietary/` folder (Dokploy Source Available License) and was removed
 * together with the license system. The Flots implementation lands in a
 * follow-up and only has to fill this function in.
 */
export const createAuditLog = async (_input: CreateAuditLogInput) => {};
