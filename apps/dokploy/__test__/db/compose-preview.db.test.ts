import { db } from "@dokploy/server/db";
import {
	compose,
	composePreviews,
	environments,
	projects,
	server,
} from "@dokploy/server/db/schema";
import {
	acquirePreviewLease,
	releasePreviewLease,
	requestComposePreview,
} from "@dokploy/server/services/compose-preview";
import { haveActiveServices } from "@dokploy/server/services/server";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reconcileCandidates } from "@/server/queues/compose-previews";
import {
	createOrganization,
	type Person,
	pgErrorCode,
	removeCreatedRows,
} from "./fixtures";

const FOREIGN_KEY_VIOLATION = "23503";
const INVALID_ENUM_VALUE = "22P02";

let owner: Person;
let sourceId: string;
let childId: string;
let managerId: string;
let workerId: string;

const insertServer = async (name: string, swarmManagerId?: string) => {
	const [row] = await db
		.insert(server)
		.values({
			name,
			ipAddress: "100.64.0.10",
			port: 22,
			createdAt: new Date().toISOString(),
			organizationId: owner.organizationId,
			swarmManagerId,
		})
		.returning();
	if (!row) throw new Error("server not inserted");
	return row.serverId;
};

beforeAll(async () => {
	owner = await createOrganization("compose-preview");
	const [project] = await db
		.insert(projects)
		.values({ name: "previews", organizationId: owner.organizationId })
		.returning();
	const [environment] = await db
		.insert(environments)
		.values({ name: "production", projectId: project!.projectId })
		.returning();
	const [source] = await db
		.insert(compose)
		.values({ name: "monorepo", environmentId: environment!.environmentId })
		.returning();
	const [child] = await db
		.insert(compose)
		.values({
			name: "monorepo · PR #7",
			environmentId: environment!.environmentId,
			previewParentId: source!.composeId,
		})
		.returning();
	sourceId = source!.composeId;
	childId = child!.composeId;
	managerId = await insertServer("manager");
	workerId = await insertServer("worker", managerId);
});

afterAll(async () => {
	await db
		.delete(composePreviews)
		.where(eq(composePreviews.sourceComposeId, sourceId));
	await db.delete(compose).where(eq(compose.composeId, childId));
	await db.delete(server).where(eq(server.serverId, workerId));
	await removeCreatedRows();
});

const previewOf = async (pullRequestNumber: number) =>
	(await db.query.composePreviews.findFirst({
		where: sql`${composePreviews.sourceComposeId} = ${sourceId} and ${composePreviews.pullRequestNumber} = ${pullRequestNumber}`,
	}))!;

describe("Compose PR environment requests", () => {
	it("records one row per PR and keeps it across requests", async () => {
		const first = await requestComposePreview(sourceId, 1);
		const again = await requestComposePreview(sourceId, 1);
		expect(again.previewId).toBe(first.previewId);
		expect(again.requestedAt >= first.requestedAt).toBe(true);
	});

	it("lets PR activity bring back an expired environment, never a running one's lifetime", async () => {
		const future = new Date(Date.now() + 3_600_000).toISOString();
		const removed = await requestComposePreview(sourceId, 2);
		await db
			.update(composePreviews)
			.set({ expiresAt: "2000-01-01T00:00:00.000Z" })
			.where(eq(composePreviews.previewId, removed.previewId));
		await requestComposePreview(sourceId, 2, "activity");
		expect((await previewOf(2)).expiresAt).toBeNull();

		const running = await requestComposePreview(sourceId, 3);
		await db
			.update(composePreviews)
			.set({ composeId: childId, expiresAt: future })
			.where(eq(composePreviews.previewId, running.previewId));
		await requestComposePreview(sourceId, 3, "activity");
		expect((await previewOf(3)).expiresAt).toBe(future);
		await db
			.update(composePreviews)
			.set({ composeId: null })
			.where(eq(composePreviews.previewId, running.previewId));
	});

	it("keeps a push that arrives while an expired environment is being removed", async () => {
		const expiring = await requestComposePreview(sourceId, 6);
		await db
			.update(composePreviews)
			.set({ composeId: childId, expiresAt: "2000-01-01T00:00:00.000Z" })
			.where(eq(composePreviews.previewId, expiring.previewId));
		await requestComposePreview(sourceId, 6, "activity");
		expect((await previewOf(6)).expiresAt).toBeNull();
		await db
			.update(composePreviews)
			.set({ composeId: null })
			.where(eq(composePreviews.previewId, expiring.previewId));
	});

	it("clears a manual removal only on a manual deploy", async () => {
		const preview = await requestComposePreview(sourceId, 4);
		await db
			.update(composePreviews)
			.set({ manualCleanup: true })
			.where(eq(composePreviews.previewId, preview.previewId));
		await requestComposePreview(sourceId, 4, "activity");
		expect((await previewOf(4)).manualCleanup).toBe(true);
		await requestComposePreview(sourceId, 4, "manual");
		expect((await previewOf(4)).manualCleanup).toBe(false);
	});

	it("rejects an unknown status", async () => {
		const preview = await requestComposePreview(sourceId, 5);
		expect(
			await pgErrorCode(
				db.execute(
					sql`update "composePreview" set status = 'paused' where "previewId" = ${preview.previewId}`,
				),
			),
		).toBe(INVALID_ENUM_VALUE);
	});
});

describe("lifecycle lease", () => {
	it("lets one run at a time hold a preview, and recovers an expired lease", async () => {
		const { previewId } = await requestComposePreview(sourceId, 10);
		const token = await acquirePreviewLease(previewId);
		expect(token).toBeTruthy();
		expect(await acquirePreviewLease(previewId)).toBeNull();

		// A wrong token cannot release someone else's lease.
		await releasePreviewLease(previewId, "not-the-owner");
		expect(await acquirePreviewLease(previewId)).toBeNull();

		await releasePreviewLease(previewId, token!);
		const next = await acquirePreviewLease(previewId);
		expect(next).toBeTruthy();

		// A crashed process: its lease expires on its own.
		await db
			.update(composePreviews)
			.set({ lockedUntil: "2000-01-01T00:00:00.000Z" })
			.where(eq(composePreviews.previewId, previewId));
		expect(await acquirePreviewLease(previewId)).toBeTruthy();
	});

	it("never hands the lease to two concurrent runs", async () => {
		const { previewId } = await requestComposePreview(sourceId, 11);
		const tokens = await Promise.all(
			Array.from({ length: 8 }, () => acquirePreviewLease(previewId)),
		);
		expect(tokens.filter(Boolean)).toHaveLength(1);
	});
});

describe("reconciler candidates", () => {
	const states = {
		unhandled: { status: "ready", reconciled: false },
		deploying: { status: "deploying", reconciled: true },
		ready: { status: "ready", reconciled: true },
		closed: { status: "closed", reconciled: true },
		waiting: {
			status: "error",
			reconciled: true,
			error: "Waiting for capacity: worker w already runs 3 of 3",
		},
		forbidden: {
			status: "error",
			reconciled: true,
			error: "@someone needs write access to the repository",
		},
		expired: {
			status: "ready",
			reconciled: true,
			expiresAt: "2000-01-01T00:00:00.000Z",
		},
	} as const;
	const ids: Record<string, string> = {};

	beforeAll(async () => {
		let number = 100;
		for (const [name, state] of Object.entries(states)) {
			const preview = await requestComposePreview(sourceId, number++);
			ids[name] = preview.previewId;
			await db
				.update(composePreviews)
				.set({
					status: state.status,
					error: "error" in state ? state.error : null,
					expiresAt: "expiresAt" in state ? state.expiresAt : null,
					reconciledAt: state.reconciled ? preview.requestedAt : null,
				})
				.where(eq(composePreviews.previewId, preview.previewId));
		}
	});

	const selected = async (settledToo: boolean) => {
		const rows = await db.query.composePreviews.findMany({
			columns: { previewId: true },
			where: sql`${reconcileCandidates(new Date().toISOString(), settledToo)} and ${inArray(composePreviews.previewId, Object.values(ids))}`,
		});
		const names = Object.entries(ids)
			.filter(([, id]) => rows.some((row) => row.previewId === id))
			.map(([name]) => name);
		return names.sort();
	};

	it("checks unhandled, in-flight, waiting and expired previews every minute", async () => {
		expect(await selected(false)).toEqual(
			["deploying", "expired", "unhandled", "waiting"].sort(),
		);
	});

	it("adds settled previews on the slower pass, never closed ones", async () => {
		expect(await selected(true)).toEqual(
			[
				"deploying",
				"expired",
				"forbidden",
				"ready",
				"unhandled",
				"waiting",
			].sort(),
		);
	});
});

describe("referential safety", () => {
	it("keeps a Swarm manager while preview workers depend on it", async () => {
		expect(
			await pgErrorCode(
				db.delete(server).where(eq(server.serverId, managerId)),
			),
		).toBe(FOREIGN_KEY_VIOLATION);
		expect(await haveActiveServices(managerId)).toBe(true);
	});

	it("keeps a source Compose while it has PR instances", async () => {
		expect(
			await pgErrorCode(
				db.delete(compose).where(eq(compose.composeId, sourceId)),
			),
		).toBe(FOREIGN_KEY_VIOLATION);
	});
});
