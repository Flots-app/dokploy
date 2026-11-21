import { db } from "@dokploy/server/db";
import { auditLog } from "@dokploy/server/db/schema";
import {
	createAuditLog,
	getAuditLogs,
	purgeAuditLogs,
} from "@dokploy/server/services/audit-log";
import { count, inArray, lt } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { auditLogRouter } from "@/server/api/routers/audit-log";
import {
	addMember,
	contextOf,
	createOrganization,
	type Person,
	removeCreatedRows,
} from "./fixtures";

type Context = Parameters<typeof auditLogRouter.createCaller>[0];
const callerOf = (person: Person) =>
	auditLogRouter.createCaller(contextOf(person) as unknown as Context);

let a: Person;
let b: Person;

const record = (
	person: Person,
	overrides: Partial<Parameters<typeof createAuditLog>[0]> = {},
) =>
	createAuditLog({
		organizationId: person.organizationId,
		userId: person.userId,
		userEmail: person.email,
		userRole: person.role,
		action: "create",
		resourceType: "project",
		resourceName: "web",
		...overrides,
	});

beforeAll(async () => {
	a = await createOrganization("audit-a");
	b = await createOrganization("audit-b");
});

afterAll(async () => {
	// The rows survive their organization (set null), so delete them first.
	await db
		.delete(auditLog)
		.where(
			inArray(auditLog.organizationId, [a.organizationId, b.organizationId]),
		);
	await removeCreatedRows();
});

describe("audit log against PostgreSQL", () => {
	it("records an entry and reads it back with its parsed metadata", async () => {
		await record(a, {
			action: "update",
			resourceType: "user",
			resourceId: "member-1",
			resourceName: "someone@example.test",
			metadata: { before: "member", after: "admin" },
		});

		const { items, total } = await getAuditLogs({
			organizationId: a.organizationId,
			resourceType: "user",
		});

		expect(total).toBe(1);
		expect(items[0]).toMatchObject({
			userEmail: a.email,
			userRole: "owner",
			action: "update",
			resourceId: "member-1",
			metadata: { before: "member", after: "admin" },
		});
	});

	it("keeps another organization's entries out of the result and the total", async () => {
		await record(b, { resourceName: "secret-project-of-b" });

		const result = await getAuditLogs({ organizationId: a.organizationId });

		expect(
			result.items.some((e) => e.resourceName === "secret-project-of-b"),
		).toBe(false);
		const ofB = await getAuditLogs({ organizationId: b.organizationId });
		expect(ofB.total).toBe(1);
	});

	it("redacts sensitive metadata before it reaches the table", async () => {
		await record(a, {
			resourceType: "registry",
			resourceName: "ghcr",
			metadata: { username: "bot", password: "hunter2" },
		});

		const [row] = await db
			.select()
			.from(auditLog)
			.where(inArray(auditLog.resourceName, ["ghcr"]));

		expect(row?.metadata).not.toContain("hunter2");
		expect(JSON.parse(row?.metadata ?? "{}")).toEqual({
			username: "bot",
			password: "[redacted]",
		});
	});

	it("filters by action, resource type, e-mail and name", async () => {
		await record(a, {
			action: "delete",
			resourceType: "domain",
			resourceName: "api.example.test",
		});

		const byAction = await getAuditLogs({
			organizationId: a.organizationId,
			action: "delete",
		});
		const byType = await getAuditLogs({
			organizationId: a.organizationId,
			resourceType: "domain",
		});
		const byEmail = await getAuditLogs({
			organizationId: a.organizationId,
			userEmail: a.email.slice(2, 12).toUpperCase(),
		});
		const byName = await getAuditLogs({
			organizationId: a.organizationId,
			resourceName: "API.EXAMPLE",
		});

		expect(byAction.items.map((e) => e.resourceName)).toEqual([
			"api.example.test",
		]);
		expect(byType.total).toBe(1);
		expect(byEmail.total).toBeGreaterThan(0);
		expect(byName.items.map((e) => e.resourceName)).toEqual([
			"api.example.test",
		]);
	});

	it("matches % and _ in a search term literally", async () => {
		await record(a, { resourceName: "100%_done" });
		await record(a, { resourceName: "1000xdone" });

		const result = await getAuditLogs({
			organizationId: a.organizationId,
			resourceName: "100%_done",
		});

		expect(result.items.map((e) => e.resourceName)).toEqual(["100%_done"]);
	});

	it("filters by date range, both ends included", async () => {
		const { items } = await getAuditLogs({ organizationId: a.organizationId });
		const times = items.map((entry) => entry.createdAt.getTime());
		const newest = new Date(Math.max(...times));
		const oldest = new Date(Math.min(...times));
		const msAfter = new Date(newest.getTime() + 1);
		const msBefore = new Date(oldest.getTime() - 1);

		const all = await getAuditLogs({
			organizationId: a.organizationId,
			from: oldest,
			to: newest,
		});
		const afterTheNewest = await getAuditLogs({
			organizationId: a.organizationId,
			from: msAfter,
		});
		const beforeTheOldest = await getAuditLogs({
			organizationId: a.organizationId,
			to: msBefore,
		});

		expect(all.total).toBe(items.length);
		expect(afterTheNewest.total).toBe(0);
		expect(beforeTheOldest.total).toBe(0);
	});

	it("pages newest first without losing or repeating an entry", async () => {
		const paged = await createOrganization("audit-paged");
		for (let i = 0; i < 5; i++) {
			await record(paged, { resourceName: `entry-${i}` });
		}

		const first = await getAuditLogs({
			organizationId: paged.organizationId,
			limit: 2,
			offset: 0,
		});
		const second = await getAuditLogs({
			organizationId: paged.organizationId,
			limit: 2,
			offset: 2,
		});
		const third = await getAuditLogs({
			organizationId: paged.organizationId,
			limit: 2,
			offset: 4,
		});

		const names = [...first.items, ...second.items, ...third.items].map(
			(e) => e.resourceName,
		);
		expect(first.total).toBe(5);
		expect(names).toHaveLength(5);
		expect(new Set(names).size).toBe(5);
		expect(names[0]).toBe("entry-4");
		await db
			.delete(auditLog)
			.where(inArray(auditLog.organizationId, [paged.organizationId]));
	});

	it("does not throw when the entry cannot be stored", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(
			record(a, { organizationId: "organization-that-does-not-exist" }),
		).resolves.toBeUndefined();

		expect(error).toHaveBeenCalled();
		// Neither the e-mail nor the metadata may reach the logs.
		const logged = JSON.stringify(error.mock.calls);
		expect(logged).not.toContain(a.email);
		expect(logged).toContain("23503");
		error.mockRestore();
	});
});

describe("retention", () => {
	it("removes only the entries older than the cutoff, in batches", async () => {
		const retained = await createOrganization("audit-retention");
		const day = 24 * 60 * 60 * 1000;
		const entry = (name: string, ageInDays: number) => ({
			organizationId: retained.organizationId,
			userId: retained.userId,
			userEmail: retained.email,
			userRole: "owner",
			action: "create",
			resourceType: "project",
			resourceName: name,
			createdAt: new Date(Date.now() - ageInDays * day),
		});
		await db
			.insert(auditLog)
			.values([
				entry("old-1", 400),
				entry("old-2", 399),
				entry("old-3", 398),
				entry("recent", 1),
			]);

		// The purge is global: count the old rows other files may have left behind.
		const cutoff = new Date(Date.now() - 365 * day);
		const [expiredRow] = await db
			.select({ value: count() })
			.from(auditLog)
			.where(lt(auditLog.createdAt, cutoff));
		const expired = expiredRow?.value ?? 0;

		// Batches of 2 over the expired entries: the loop must go round twice.
		const purged = await purgeAuditLogs(cutoff, 2);

		const { items } = await getAuditLogs({
			organizationId: retained.organizationId,
		});
		expect(expired).toBeGreaterThanOrEqual(3);
		expect(purged).toBe(expired);
		expect(items.map((e) => e.resourceName)).toEqual(["recent"]);
		await db
			.delete(auditLog)
			.where(inArray(auditLog.organizationId, [retained.organizationId]));
	});

	it("purges nothing when everything is recent", async () => {
		expect(await purgeAuditLogs(new Date(0))).toBe(0);
	});
});

describe("auditLog router", () => {
	it("lets the owner and an admin read, and only their own organization", async () => {
		const admin = await addMember(a.organizationId, "admin");

		const asOwner = await callerOf(a).all({ limit: 50, offset: 0 });
		const asAdmin = await callerOf(admin).all({ limit: 50, offset: 0 });

		expect(asOwner.total).toBeGreaterThan(0);
		expect(asAdmin.total).toBe(asOwner.total);
		expect(
			asOwner.items.every((e) => e.resourceName !== "secret-project-of-b"),
		).toBe(true);
	});

	it("keeps a plain member out", async () => {
		const plain = await addMember(a.organizationId, "member");

		await expect(
			callerOf(plain).all({ limit: 50, offset: 0 }),
		).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
	});

	it("rejects an unknown action and an oversized page", async () => {
		await expect(
			callerOf(a).all({ action: "nuke" as never, limit: 50, offset: 0 }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			callerOf(a).all({ limit: 5_000, offset: 0 }),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
	});
});
