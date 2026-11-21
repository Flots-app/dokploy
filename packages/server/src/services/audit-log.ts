import { db } from "@dokploy/server/db";
import type { AuditAction, AuditResourceType } from "@dokploy/server/db/schema";
import { auditLog } from "@dokploy/server/db/schema";
import {
	and,
	count,
	desc,
	eq,
	gte,
	ilike,
	inArray,
	lt,
	type SQL,
} from "drizzle-orm";

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

export const REDACTED = "[redacted]";
const MAX_METADATA_LENGTH = 8_000;
const MAX_METADATA_DEPTH = 6;
/** Keys whose value must never reach the audit trail, whatever a call site passes. */
const SENSITIVE_KEY =
	/pass(word|phrase|wd)|secret|token|api[-_]?key|private[-_]?key|credential|authorization|cookie/i;

/** A copy of the metadata with every sensitive value replaced. */
export const redactMetadata = (value: unknown, depth = 0): unknown => {
	if (depth >= MAX_METADATA_DEPTH) return REDACTED;
	if (Array.isArray(value)) {
		return value.map((item) => redactMetadata(item, depth + 1));
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [
				key,
				SENSITIVE_KEY.test(key) ? REDACTED : redactMetadata(item, depth + 1),
			]),
		);
	}
	return value;
};

const serializeMetadata = (metadata?: Record<string, unknown>) => {
	if (!metadata) return undefined;
	const json = JSON.stringify(redactMetadata(metadata));
	if (json.length <= MAX_METADATA_LENGTH) return json;
	return JSON.stringify({ truncated: true, size: json.length });
};

const parseMetadata = (metadata: string | null) => {
	if (!metadata) return null;
	try {
		const parsed: unknown = JSON.parse(metadata);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
};

/**
 * What is safe to log about a failed query. drizzle wraps the driver error and
 * puts the whole statement, parameters included, in its own message: here that
 * would write the user's e-mail and the entry's metadata to the server logs, so
 * only the driver's own error is reported.
 */
export const failureOf = (error: unknown) => {
	const cause = error instanceof Error && error.cause ? error.cause : error;
	const code =
		cause && typeof cause === "object" && "code" in cause
			? String(cause.code)
			: undefined;
	return {
		code,
		reason: cause instanceof Error ? cause.message : String(cause),
	};
};

/**
 * Records one entry of the audit trail. It never throws: a failing audit write
 * must not break the operation being audited, so the failure is only logged.
 */
export const createAuditLog = async (input: CreateAuditLogInput) => {
	try {
		await db.insert(auditLog).values({
			organizationId: input.organizationId,
			userId: input.userId,
			userEmail: input.userEmail,
			userRole: input.userRole,
			action: input.action,
			resourceType: input.resourceType,
			resourceId: input.resourceId,
			resourceName: input.resourceName,
			metadata: serializeMetadata(input.metadata),
		});
	} catch (error) {
		console.error("[audit-log] could not record an entry", {
			organizationId: input.organizationId,
			action: input.action,
			resourceType: input.resourceType,
			...failureOf(error),
		});
	}
};

export interface GetAuditLogsInput {
	organizationId: string;
	userEmail?: string;
	resourceName?: string;
	action?: AuditAction;
	resourceType?: AuditResourceType;
	from?: Date;
	to?: Date;
	limit?: number;
	offset?: number;
}

const MAX_PAGE_SIZE = 200;

/** LIKE treats % and _ as wildcards: a search term must match them literally. */
const containing = (term: string) => `%${term.replace(/[\\%_]/g, "\\$&")}%`;

/** One page of an organization's audit trail, newest first, and the total it is cut from. */
export const getAuditLogs = async (input: GetAuditLogsInput) => {
	const limit = Math.min(Math.max(input.limit ?? 50, 1), MAX_PAGE_SIZE);
	const offset = Math.max(input.offset ?? 0, 0);

	const conditions: SQL[] = [eq(auditLog.organizationId, input.organizationId)];
	if (input.userEmail) {
		conditions.push(ilike(auditLog.userEmail, containing(input.userEmail)));
	}
	if (input.resourceName) {
		conditions.push(
			ilike(auditLog.resourceName, containing(input.resourceName)),
		);
	}
	if (input.action) conditions.push(eq(auditLog.action, input.action));
	if (input.resourceType) {
		conditions.push(eq(auditLog.resourceType, input.resourceType));
	}
	if (input.from) conditions.push(gte(auditLog.createdAt, input.from));
	// Timestamps keep microseconds but a Date stops at the millisecond: `to` must
	// cover that whole millisecond, which `<= to` would cut at its first instant.
	if (input.to) {
		conditions.push(lt(auditLog.createdAt, new Date(input.to.getTime() + 1)));
	}
	const where = and(...conditions);

	const [rows, [totalRow]] = await Promise.all([
		db
			.select()
			.from(auditLog)
			.where(where)
			.orderBy(desc(auditLog.createdAt), desc(auditLog.id))
			.limit(limit)
			.offset(offset),
		db.select({ value: count() }).from(auditLog).where(where),
	]);

	return {
		items: rows.map((row) => ({
			id: row.id,
			createdAt: row.createdAt,
			userId: row.userId,
			userEmail: row.userEmail,
			userRole: row.userRole,
			action: row.action,
			resourceType: row.resourceType,
			resourceId: row.resourceId,
			resourceName: row.resourceName,
			metadata: parseMetadata(row.metadata),
		})),
		total: totalRow?.value ?? 0,
	};
};

const DEFAULT_RETENTION_DAYS = 365;
const PURGE_BATCH_SIZE = 5_000;

/**
 * How long entries are kept, from `AUDIT_LOG_RETENTION_DAYS`: a positive number
 * of days, 365 when unset or invalid, `null` (keep everything) when set to 0.
 */
export const getAuditLogRetentionDays = (
	value = process.env.AUDIT_LOG_RETENTION_DAYS,
): number | null => {
	if (value === undefined || value.trim() === "") return DEFAULT_RETENTION_DAYS;
	const days = Number(value);
	if (!Number.isInteger(days) || days < 0) return DEFAULT_RETENTION_DAYS;
	return days === 0 ? null : days;
};

/** Deletes the entries older than `olderThan`, in batches, and returns how many went. */
export const purgeAuditLogs = async (
	olderThan: Date,
	batchSize = PURGE_BATCH_SIZE,
) => {
	let purged = 0;
	for (;;) {
		const batch = await db
			.delete(auditLog)
			.where(
				inArray(
					auditLog.id,
					db
						.select({ id: auditLog.id })
						.from(auditLog)
						.where(lt(auditLog.createdAt, olderThan))
						.limit(batchSize),
				),
			)
			.returning({ id: auditLog.id });
		purged += batch.length;
		if (batch.length < batchSize) return purged;
	}
};
