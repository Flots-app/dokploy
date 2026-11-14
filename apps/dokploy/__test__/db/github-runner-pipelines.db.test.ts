/**
 * Pipeline durations on a real PostgreSQL: the controller's scan picks the
 * runs the pool's runners took part in (grouped, settled, not yet recorded,
 * recent), asks GitHub for each attempt, records the completed ones, and the
 * pool's KPIs read them back. GitHub is a fake answering per run attempt.
 */
import { db } from "@dokploy/server/db";
import {
	githubRunnerJobs,
	githubRunnerPipelines,
} from "@dokploy/server/db/schema";
import { getGithubRunnerDurationKpis } from "@dokploy/server/services/github-runner";
import { scanPipelines } from "@dokploy/server/utils/github-runners/controller";
import type { WorkflowRunAttempt } from "@dokploy/server/utils/github-runners/github-api";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	createOrganization,
	insertNode,
	insertPool,
	removeCreatedRows,
} from "./fixtures";

const asked: string[] = [];
const attempts = new Map<string, WorkflowRunAttempt>();

vi.mock(
	"@dokploy/server/utils/github-runners/github-api",
	async (importOriginal) => {
		const original =
			await importOriginal<
				typeof import("@dokploy/server/utils/github-runners/github-api")
			>();
		return {
			...original,
			createGithubRunnerClient: () => ({
				authorization: async () => "token test",
				getRunAttempt: async (
					repository: string,
					runId: string,
					attempt: string,
				) => {
					const key = `${repository}#${runId}/${attempt}`;
					asked.push(key);
					const found = attempts.get(key);
					if (!found) throw new Error(`no run ${key}`);
					return found;
				},
			}),
		};
	},
);

const minutesAgo = (minutes: number) =>
	new Date(Date.now() - minutes * 60_000).toISOString();

const completed = (
	name: string,
	startedMinutesAgo: number,
	durationSeconds: number,
	conclusion = "success",
): WorkflowRunAttempt => ({
	status: "completed",
	conclusion,
	name,
	event: "pull_request",
	startedAt: minutesAgo(startedMinutesAgo),
	updatedAt: new Date(
		Date.parse(minutesAgo(startedMinutesAgo)) + durationSeconds * 1000,
	).toISOString(),
});

describe("pipeline durations", () => {
	let pool: Awaited<ReturnType<typeof insertPool>>;
	let organizationId: string;

	beforeAll(async () => {
		const owner = await createOrganization("pipelines");
		organizationId = owner.organizationId;
		pool = await insertPool(organizationId, "pipelines");
		const node = await insertNode(pool, "pipe-m4");
		let slot = 0;
		const job = (
			runId: string,
			runAttempt: string,
			startedMinutesAgo: number,
			finishedMinutesAgo: number | null,
			durationSeconds: number | null = 120,
		) => ({
			organizationId,
			githubRunnerNodeId: node.githubRunnerNodeId,
			githubRunnerPoolId: pool.githubRunnerPoolId,
			runnerName: `dkp-pipe-m4-${++slot}-${runId}${runAttempt}`,
			slot: 1,
			repository: "example/ci",
			workflow: "CI",
			job: `job ${slot}`,
			runId,
			runAttempt,
			outcome:
				finishedMinutesAgo === null
					? ("running" as const)
					: ("completed" as const),
			startedAt: minutesAgo(startedMinutesAgo),
			finishedAt:
				finishedMinutesAgo === null ? null : minutesAgo(finishedMinutesAgo),
			durationSeconds: finishedMinutesAgo === null ? null : durationSeconds,
		});
		await db.insert(githubRunnerJobs).values([
			// Two jobs of a finished run.
			job("100", "1", 30, 20, 300),
			job("100", "1", 30, 18, 420),
			// A run whose job on the pool just ended: GitHub may not be done yet.
			job("200", "1", 5, 0.1),
			// A run already recorded.
			job("300", "1", 60, 50),
			// Two attempts of the same run.
			job("400", "1", 120, 110),
			job("400", "2", 100, 90),
			// Too old to look at.
			job("500", "1", 3 * 24 * 60, 3 * 24 * 60 - 10),
			// Still in progress on GitHub (another of its jobs runs elsewhere).
			job("600", "1", 40, 35),
			// No job of this run finished yet.
			job("700", "1", 10, null),
		]);
		await db.insert(githubRunnerPipelines).values({
			organizationId,
			githubRunnerPoolId: pool.githubRunnerPoolId,
			repository: "example/ci",
			runId: "300",
			runAttempt: "1",
			workflow: "CI",
			conclusion: "success",
			startedAt: minutesAgo(61),
			completedAt: minutesAgo(49),
			durationSeconds: 720,
		});
		attempts.set("example/ci#100/1", completed("CI", 31, 900));
		attempts.set("example/ci#400/1", completed("CI", 121, 200, "failure"));
		attempts.set("example/ci#400/2", completed("CI", 101, 600));
		attempts.set("example/ci#600/1", {
			...completed("Deploy", 41, 0),
			status: "in_progress",
		});
	});

	afterAll(removeCreatedRows);

	it("records the completed runs the pool took part in, once each", async () => {
		const withToken = { ...pool, token: "ghp_test" };
		expect(await scanPipelines(withToken)).toBe(3);
		// Settled, recent and not yet recorded only: never 200, 300, 500 or 700.
		expect([...asked].sort()).toEqual([
			"example/ci#100/1",
			"example/ci#400/1",
			"example/ci#400/2",
			"example/ci#600/1",
		]);
		const rows = await db.query.githubRunnerPipelines.findMany({
			where: eq(
				githubRunnerPipelines.githubRunnerPoolId,
				pool.githubRunnerPoolId,
			),
		});
		expect(
			rows
				.map(
					(row) =>
						`${row.runId}/${row.runAttempt} ${row.conclusion} ${row.durationSeconds}`,
				)
				.sort(),
		).toEqual([
			"100/1 success 900",
			"300/1 success 720",
			"400/1 failure 200",
			"400/2 success 600",
		]);

		// Next scan: only the run still in progress is asked again.
		asked.length = 0;
		expect(await scanPipelines(withToken)).toBe(0);
		expect(asked).toEqual(["example/ci#600/1"]);
	});

	it("gives the pool's job and pipeline KPIs of the last 24 hours", async () => {
		const kpis = await getGithubRunnerDurationKpis(
			pool.githubRunnerPoolId,
			organizationId,
		);
		// Completed jobs of the window (the 3-day-old one and the running one out).
		expect(kpis.jobs.count).toBe(7);
		expect(kpis.pipelines).toMatchObject({
			runs: 4,
			succeeded: 3,
			averageSeconds: 740,
			p90Seconds: 900,
		});
		expect(kpis.pipelines.workflows).toEqual([
			{
				repository: "example/ci",
				workflow: "CI",
				runs: 4,
				succeeded: 3,
				count: 3,
				averageSeconds: 740,
				p90Seconds: 900,
			},
		]);
	});
});
