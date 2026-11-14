import { createGithubRunnerClient } from "@dokploy/server/utils/github-runners/github-api";
import {
	durationStats,
	MAX_WORKFLOWS,
	pipelineDuration,
	pipelineStats,
} from "@dokploy/server/utils/github-runners/pipelines";
import { describe, expect, it } from "vitest";

describe("durationStats", () => {
	it("averages and takes the 90th percentile by nearest rank", () => {
		expect(
			durationStats([60, 120, 180, 240, 300, 360, 420, 480, 540, 600]),
		).toEqual({
			count: 10,
			averageSeconds: 330,
			p90Seconds: 540,
		});
		expect(durationStats([45])).toEqual({
			count: 1,
			averageSeconds: 45,
			p90Seconds: 45,
		});
	});

	it("has nothing to say without durations, and skips impossible ones", () => {
		expect(durationStats([])).toEqual({
			count: 0,
			averageSeconds: null,
			p90Seconds: null,
		});
		expect(durationStats([Number.NaN, -5, 30]).count).toBe(1);
	});
});

describe("pipelineDuration", () => {
	const attempt = {
		status: "completed",
		conclusion: "success",
		name: "CI Pipeline",
		event: "pull_request",
		startedAt: "2026-11-14T10:00:00Z",
		updatedAt: "2026-11-14T10:12:34Z",
	};

	it("measures a completed run attempt from its start to its last update", () => {
		expect(pipelineDuration(attempt)).toEqual({
			startedAt: "2026-11-14T10:00:00.000Z",
			completedAt: "2026-11-14T10:12:34.000Z",
			durationSeconds: 754,
		});
	});

	it("waits for the run to complete, and for its times", () => {
		expect(pipelineDuration({ ...attempt, status: "in_progress" })).toBeNull();
		expect(pipelineDuration({ ...attempt, startedAt: null })).toBeNull();
		expect(
			pipelineDuration({ ...attempt, updatedAt: "not a date" }),
		).toBeNull();
		// A clock glitch never yields a negative duration.
		expect(
			pipelineDuration({ ...attempt, updatedAt: "2026-11-14T09:59:00Z" })
				?.durationSeconds,
		).toBe(0);
	});
});

describe("pipelineStats", () => {
	const row = (
		workflow: string,
		durationSeconds: number,
		conclusion: string | null = "success",
		repository = "Flots-app/monorepo",
	) => ({ repository, workflow, conclusion, durationSeconds });

	it("averages successful runs only, and counts every run", () => {
		const stats = pipelineStats([
			row("CI Pipeline", 600),
			row("CI Pipeline", 900),
			// Failed early, cancelled midway: neither says how long a pipeline takes.
			row("CI Pipeline", 60, "failure"),
			row("CI Pipeline", 30, "cancelled"),
			row("Plumber", 120),
		]);
		expect(stats).toMatchObject({
			runs: 5,
			succeeded: 3,
			count: 3,
			averageSeconds: 540,
		});
		expect(stats.workflows).toEqual([
			{
				repository: "Flots-app/monorepo",
				workflow: "CI Pipeline",
				runs: 4,
				succeeded: 2,
				count: 2,
				averageSeconds: 750,
				p90Seconds: 900,
			},
			{
				repository: "Flots-app/monorepo",
				workflow: "Plumber",
				runs: 1,
				succeeded: 1,
				count: 1,
				averageSeconds: 120,
				p90Seconds: 120,
			},
		]);
	});

	it("keeps workflows of different repositories apart, the busiest first", () => {
		const rows = Array.from({ length: MAX_WORKFLOWS + 3 }, (_, index) =>
			row(`Workflow ${index}`, 60),
		);
		rows.push(
			row("Workflow 0", 60),
			row("CI", 60, "success", "Flots-app/website"),
		);
		const stats = pipelineStats(rows);
		expect(stats.workflows).toHaveLength(MAX_WORKFLOWS);
		expect(stats.workflows[0]).toMatchObject({
			workflow: "Workflow 0",
			runs: 2,
		});
		expect(
			pipelineStats([
				row("CI", 60),
				row("CI", 60, "success", "Flots-app/website"),
			]).workflows,
		).toHaveLength(2);
	});
});

describe("getRunAttempt", () => {
	const target = {
		scope: "organization" as const,
		owner: "Flots-app",
		repository: null,
		runnerGroup: "Default",
		apiUrl: "https://api.github.com",
	};

	it("reads one attempt of a run, with its start and last update", async () => {
		const urls: string[] = [];
		const client = createGithubRunnerClient(
			target,
			{ type: "token", token: "t" },
			{
				fetch: async (url) => {
					urls.push(String(url));
					return new Response(
						JSON.stringify({
							status: "completed",
							conclusion: "success",
							name: "CI Pipeline",
							event: "pull_request",
							run_started_at: "2026-11-14T10:00:00Z",
							updated_at: "2026-11-14T10:12:34Z",
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					);
				},
			},
		);
		await expect(
			client.getRunAttempt("Flots-app/monorepo", "43584667888", "2"),
		).resolves.toEqual({
			status: "completed",
			conclusion: "success",
			name: "CI Pipeline",
			event: "pull_request",
			startedAt: "2026-11-14T10:00:00Z",
			updatedAt: "2026-11-14T10:12:34Z",
		});
		expect(urls).toEqual([
			"https://api.github.com/repos/Flots-app/monorepo/actions/runs/43584667888/attempts/2",
		]);
		await expect(
			client.getRunAttempt("Flots-app/monorepo", "43584667888", "2;x"),
		).rejects.toThrow("Invalid run attempt");
	});
});
