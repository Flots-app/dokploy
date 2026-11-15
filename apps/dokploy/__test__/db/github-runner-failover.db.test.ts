/**
 * Machine health on a real PostgreSQL: the controller counts the jobs a machine
 * lost within the pool's failover window, sets it aside (stored, with an
 * event), and brings it back once the cooldown ends without new losses.
 */
import { db } from "@dokploy/server/db";
import {
	githubRunnerJobs,
	githubRunnerNodes,
	githubRunnerPools,
} from "@dokploy/server/db/schema";
import { refreshMachineHealth } from "@dokploy/server/utils/github-runners/controller";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createOrganization,
	insertNode,
	insertPool,
	removeCreatedRows,
} from "./fixtures";

const now = Date.now();
const minutesAgo = (minutes: number) =>
	new Date(now - minutes * 60_000).toISOString();

describe("machine health", () => {
	let pool: Awaited<ReturnType<typeof insertPool>>;
	let nodeId: string;
	let organizationId: string;
	let slot = 0;

	const lose = (
		finishedMinutesAgo: number,
		values: Partial<typeof githubRunnerJobs.$inferInsert> = {},
	) =>
		db.insert(githubRunnerJobs).values({
			organizationId,
			githubRunnerNodeId: nodeId,
			githubRunnerPoolId: pool.githubRunnerPoolId,
			runnerName: `dkp-health-m4-${++slot}-${now}`,
			slot: 1,
			repository: "example/ci",
			workflow: "CI",
			job: `job ${slot}`,
			runId: `${slot}`,
			runAttempt: "1",
			outcome: "interrupted",
			startedAt: minutesAgo(finishedMinutesAgo + 5),
			finishedAt: minutesAgo(finishedMinutesAgo),
			durationSeconds: 300,
			rerunStatus: "pending",
			...values,
		});

	const machine = async () => {
		const node = await db.query.githubRunnerNodes.findFirst({
			where: eq(githubRunnerNodes.githubRunnerNodeId, nodeId),
			with: { pool: true },
		});
		if (!node) throw new Error("machine gone");
		return node;
	};

	beforeAll(async () => {
		const owner = await createOrganization("health");
		organizationId = owner.organizationId;
		pool = await insertPool(organizationId, "health");
		nodeId = (await insertNode(pool, "health-m4")).githubRunnerNodeId;
	});

	afterAll(removeCreatedRows);

	it("defaults the pool to automatic failover", () => {
		expect(pool.failover).toEqual({
			interruptions: 2,
			windowMinutes: 10,
			cooldownMinutes: 30,
			mode: "auto",
		});
	});

	it("does not count a job lost outside the window, or one that succeeded", async () => {
		await lose(25);
		await lose(2, {
			rerunStatus: "skipped",
			rerunNote: "the job succeeded",
		});
		// Ended on its own, nothing killed for memory meanwhile.
		await lose(2, { outcome: "completed", rerunStatus: null });
		const events: { at: string; message: string }[] = [];
		expect(await refreshMachineHealth(await machine(), now, events)).toBeNull();
		expect(events).toEqual([]);
	});

	it("sets the machine aside once it lost enough jobs, and stores it", async () => {
		await lose(3);
		// Ended while the kernel killed processes for memory, and found failed.
		await lose(1, { outcome: "completed", rerunStatus: "requested" });
		const events: { at: string; message: string }[] = [];
		const health = await refreshMachineHealth(await machine(), now, events);
		expect(health).toEqual({
			degradedSince: new Date(now).toISOString(),
			degradedUntil: new Date(now + 30 * 60_000).toISOString(),
			reason: "2 jobs lost within 10 minutes",
		});
		expect((await machine()).health).toEqual(health);
		expect(events.map((event) => event.message)).toEqual([
			expect.stringMatching(/^Set aside until \d\d:\d\d UTC: 2 jobs lost/),
		]);
	});

	it("brings it back once the cooldown ends without new losses", async () => {
		const later = now + 31 * 60_000;
		const events: { at: string; message: string }[] = [];
		expect(
			await refreshMachineHealth(await machine(), later, events),
		).toBeNull();
		expect((await machine()).health).toBeNull();
		expect(events.map((event) => event.message)).toEqual([
			"Back in the pool: no job lost during the cooldown",
		]);
	});

	it("never sets it aside when the pool keeps its jobs", async () => {
		await db
			.update(githubRunnerPools)
			.set({ failover: { ...pool.failover, mode: "pool" } })
			.where(eq(githubRunnerPools.githubRunnerPoolId, pool.githubRunnerPoolId));
		await lose(1);
		await lose(1);
		expect(await refreshMachineHealth(await machine(), now, [])).toBeNull();
	});
});
