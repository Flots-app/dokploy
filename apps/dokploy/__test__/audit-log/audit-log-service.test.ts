import {
	createAuditLog,
	failureOf,
	getAuditLogRetentionDays,
	redactMetadata,
} from "@dokploy/server/services/audit-log";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.hoisted(() => ({
	insert: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({ db: mockDb }));

const input = {
	organizationId: "org-1",
	userId: "user-1",
	userEmail: "a@example.test",
	userRole: "owner",
	action: "create" as const,
	resourceType: "project" as const,
};

const insertedValues = () => {
	const values = vi.fn().mockResolvedValue(undefined);
	mockDb.insert.mockReturnValue({ values });
	return values;
};

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("redactMetadata", () => {
	it("replaces the value of sensitive keys at any depth", () => {
		expect(
			redactMetadata({
				name: "web",
				password: "hunter2",
				nested: {
					apiKey: "k",
					privateKey: "p",
					token: "t",
					list: [{ secret: "s" }],
				},
			}),
		).toEqual({
			name: "web",
			password: "[redacted]",
			nested: {
				apiKey: "[redacted]",
				privateKey: "[redacted]",
				token: "[redacted]",
				list: [{ secret: "[redacted]" }],
			},
		});
	});

	it("keeps keys that only look similar", () => {
		const metadata = {
			passed: true,
			keyFingerprint: "SHA256:abc",
			hostKey: "x",
		};
		expect(redactMetadata(metadata)).toEqual(metadata);
	});

	it("does not follow an object nested deeper than the limit", () => {
		let deep: Record<string, unknown> = { leaf: "value" };
		for (let i = 0; i < 10; i++) deep = { next: deep };
		expect(JSON.stringify(redactMetadata(deep))).toContain("[redacted]");
		expect(JSON.stringify(redactMetadata(deep))).not.toContain("value");
	});
});

describe("createAuditLog", () => {
	it("stores the entry with redacted, serialized metadata", async () => {
		const values = insertedValues();

		await createAuditLog({
			...input,
			resourceName: "web",
			metadata: { before: "member", password: "hunter2" },
		});

		expect(values).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: "org-1",
				userEmail: "a@example.test",
				action: "create",
				resourceType: "project",
				resourceName: "web",
				metadata: JSON.stringify({ before: "member", password: "[redacted]" }),
			}),
		);
	});

	it("replaces oversized metadata with a marker", async () => {
		const values = insertedValues();

		await createAuditLog({ ...input, metadata: { blob: "x".repeat(20_000) } });

		const stored = values.mock.calls[0]?.[0].metadata as string;
		expect(JSON.parse(stored)).toMatchObject({ truncated: true });
		expect(stored.length).toBeLessThan(100);
	});

	it("never throws when the insert fails, and logs the reason", async () => {
		mockDb.insert.mockReturnValue({
			values: vi.fn().mockRejectedValue(new Error("connection lost")),
		});

		await expect(createAuditLog(input)).resolves.toBeUndefined();

		expect(console.error).toHaveBeenCalledWith(
			"[audit-log] could not record an entry",
			expect.objectContaining({
				organizationId: "org-1",
				reason: "connection lost",
				code: undefined,
			}),
		);
	});

	it("never throws when the metadata cannot be serialized", async () => {
		insertedValues();
		const circular: Record<string, unknown> = {};
		circular.self = circular;

		await expect(
			createAuditLog({ ...input, metadata: circular }),
		).resolves.toBeUndefined();
	});
});

describe("failureOf", () => {
	it("reports the driver error and never drizzle's statement with its parameters", () => {
		const driverError = Object.assign(
			new Error('violates foreign key constraint "audit_log_org_fk"'),
			{ code: "23503" },
		);
		const wrapped = new Error(
			"Failed query: insert into audit_log values ($1)\nparams: jane.doe@example.test",
			{ cause: driverError },
		);

		const failure = failureOf(wrapped);

		expect(failure).toEqual({
			code: "23503",
			reason: 'violates foreign key constraint "audit_log_org_fk"',
		});
		expect(JSON.stringify(failure)).not.toContain("jane.doe@example.test");
	});

	it("falls back to the error itself when it has no cause", () => {
		expect(failureOf(new Error("connection lost"))).toEqual({
			code: undefined,
			reason: "connection lost",
		});
		expect(failureOf("boom")).toEqual({ code: undefined, reason: "boom" });
	});
});

describe("getAuditLogRetentionDays", () => {
	it("keeps a year by default and when the value is invalid", () => {
		expect(getAuditLogRetentionDays(undefined)).toBe(365);
		expect(getAuditLogRetentionDays("")).toBe(365);
		expect(getAuditLogRetentionDays("abc")).toBe(365);
		expect(getAuditLogRetentionDays("-3")).toBe(365);
		expect(getAuditLogRetentionDays("1.5")).toBe(365);
	});

	it("uses a positive number of days, and 0 keeps everything", () => {
		expect(getAuditLogRetentionDays("90")).toBe(90);
		expect(getAuditLogRetentionDays("0")).toBeNull();
	});
});
