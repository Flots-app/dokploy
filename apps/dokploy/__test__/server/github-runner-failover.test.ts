import {
	apiCreateGithubRunnerPool,
	type GithubRunnerNode,
	type GithubRunnerNodeHealth,
	type GithubRunnerPool,
} from "@dokploy/server/db/schema";
import { runnerAlertConditions } from "@dokploy/server/utils/github-runners/alerts";
import {
	DEFAULT_FAILOVER,
	decideMachineHealth,
	LEADERSHIP_GRACE_MS,
	lostJob,
} from "@dokploy/server/utils/github-runners/health";
import { decideRerun } from "@dokploy/server/utils/github-runners/rerun";
import { decideRouting } from "@dokploy/server/utils/github-runners/routing";
import { describe, expect, it } from "vitest";

const at = (iso: string) => Date.parse(iso);
const job = (overrides: Partial<Parameters<typeof lostJob>[0]> = {}) => ({
	outcome: "interrupted",
	rerunStatus: "pending",
	rerunNote: null,
	finishedAt: "2026-11-14T15:56:32.970Z",
	...overrides,
});

describe("jobs a machine lost", () => {
	it("counts interrupted jobs and jobs that ended while the kernel killed for memory", () => {
		expect(lostJob(job(), null)).toBe(true);
		// oomRerun queued it: the machine ran out of memory during the job.
		expect(
			lostJob(job({ outcome: "completed", rerunStatus: "pending" }), null),
		).toBe(true);
		expect(
			lostJob(job({ outcome: "completed", rerunStatus: null }), null),
		).toBe(false);
	});

	it("does not count a job the re-run decision found successful", () => {
		for (const note of [
			"the job succeeded",
			"the job did not fail (success)",
		]) {
			expect(
				lostJob(job({ rerunStatus: "skipped", rerunNote: note }), null),
			).toBe(false);
		}
		// Skipped for another reason (attempts used up): it was lost all the same.
		expect(
			lostJob(
				job({
					rerunStatus: "skipped",
					rerunNote: "not re-run: already attempt 3",
				}),
				null,
			),
		).toBe(true);
	});

	it("does not count jobs marked interrupted right after this controller took the lead", () => {
		// 2026-11-14 18:06: a job ended while Dokploy restarted, autonomy armed
		// its slot again, and the new leader found it gone.
		const leaderSince = at("2026-11-14T18:08:14Z");
		const marked = (iso: string) =>
			lostJob(job({ finishedAt: iso }), leaderSince);
		expect(marked("2026-11-14T18:08:30Z")).toBe(false);
		expect(
			marked(new Date(leaderSince + LEADERSHIP_GRACE_MS + 1_000).toISOString()),
		).toBe(true);
		expect(marked("2026-11-14T18:00:00Z")).toBe(true);
	});
});

describe("machine health", () => {
	const now = at("2026-11-14T15:56:40Z");

	it("sets a machine aside once it lost enough jobs, for the cooldown", () => {
		expect(
			decideMachineHealth({
				previous: null,
				lost: 1,
				failover: DEFAULT_FAILOVER,
				now,
			}),
		).toBeNull();
		expect(
			decideMachineHealth({
				previous: null,
				lost: 4,
				failover: DEFAULT_FAILOVER,
				now,
			}),
		).toEqual({
			degradedSince: "2026-11-14T15:56:40.000Z",
			degradedUntil: "2026-11-14T16:26:40.000Z",
			reason: "4 jobs lost within 10 minutes",
		});
	});

	it("keeps it aside until the cooldown ends, longer while it keeps losing jobs", () => {
		const previous: GithubRunnerNodeHealth = {
			degradedSince: "2026-11-14T15:56:40.000Z",
			degradedUntil: "2026-11-14T16:26:40.000Z",
			reason: "4 jobs lost within 10 minutes",
		};
		const later = at("2026-11-14T16:10:00Z");
		// No new loss in the window: the cooldown runs on.
		expect(
			decideMachineHealth({
				previous,
				lost: 0,
				failover: DEFAULT_FAILOVER,
				now: later,
			}),
		).toBe(previous);
		// More losses: the end moves, the start stays.
		expect(
			decideMachineHealth({
				previous,
				lost: 2,
				failover: DEFAULT_FAILOVER,
				now: later,
			}),
		).toMatchObject({
			degradedSince: previous.degradedSince,
			degradedUntil: "2026-11-14T16:40:00.000Z",
		});
		// Over: back in the pool.
		expect(
			decideMachineHealth({
				previous,
				lost: 0,
				failover: DEFAULT_FAILOVER,
				now: at("2026-11-14T16:26:41Z"),
			}),
		).toBeNull();
	});

	it("never sets a machine aside when the pool turns it off or keeps its jobs", () => {
		for (const failover of [
			{ ...DEFAULT_FAILOVER, interruptions: 0 },
			{ ...DEFAULT_FAILOVER, mode: "pool" as const },
		]) {
			expect(
				decideMachineHealth({ previous: null, lost: 9, failover, now }),
			).toBeNull();
		}
	});

	it("defaults new pools to automatic failover", () => {
		const pool = apiCreateGithubRunnerPool.parse({
			name: "pool",
			scope: "organization",
			owner: "Flots-app",
			authType: "token",
			token: "ghp_example",
		});
		expect(pool.failover).toEqual(DEFAULT_FAILOVER);
		expect(() =>
			apiCreateGithubRunnerPool.parse({
				...pool,
				failover: { ...DEFAULT_FAILOVER, mode: "elsewhere" },
			}),
		).toThrow();
	});
});

describe("routing with failover", () => {
	const base = {
		previous: null,
		anyEnabled: true,
		labels: ["flots-dokploy"],
		fallbackLabels: ["ubuntu-24.04"],
		now: at("2026-11-14T16:00:00Z"),
	};

	it("follows a target the pool forces, whatever its runners do", () => {
		expect(
			decideRouting({ ...base, available: true, force: "fallback" }),
		).toMatchObject({ target: "fallback", value: '"ubuntu-24.04"' });
		expect(
			decideRouting({ ...base, available: false, force: "pool" }),
		).toMatchObject({
			target: "pool",
			value: '["self-hosted","flots-dokploy"]',
		});
		expect(decideRouting({ ...base, available: true })).toMatchObject({
			target: "pool",
		});
	});
});

describe("recovery of a job the machine lost track of", () => {
	it("leaves alone an interrupted job that GitHub reports successful", () => {
		expect(
			decideRerun(
				{
					runnerName: "dkp-m4-2-e4b588",
					runAttempt: "1",
					rerunStatus: "pending",
					outcome: "interrupted",
				},
				{ status: "completed", conclusion: "failure", runAttempt: 1 },
				[
					{
						name: "mac-static",
						status: "completed",
						conclusion: "success",
						runnerName: "dkp-m4-2-e4b588",
						labels: [],
						createdAt: null,
					},
				],
			),
		).toEqual({ action: "skip", note: "the job succeeded" });
	});
});

describe("alerts of a machine set aside", () => {
	it("name the machine, why and until when, alone and in the fallback alert", () => {
		const now = at("2026-11-14T16:00:00Z");
		const health: GithubRunnerNodeHealth = {
			degradedSince: "2026-11-14T15:56:40.000Z",
			degradedUntil: "2026-11-14T16:26:40.000Z",
			reason: "4 jobs lost within 10 minutes",
		};
		const pool = {
			githubRunnerPoolId: "pool",
			organizationId: "org",
			name: "Flots-app",
			authType: "app",
			token: null,
			runnerVersion: null,
			updatePolicy: { auto: true, window: null },
			routingVariable: "DOKPLOY_RUNS_ON",
			routing: {
				variable: "DOKPLOY_RUNS_ON",
				target: "fallback",
				value: '"ubuntu-24.04"',
				since: "2026-11-14T15:58:40.000Z",
				unavailableSince: "2026-11-14T15:56:40.000Z",
				syncedValue: '"ubuntu-24.04"',
				syncedAt: "2026-11-14T15:58:41.000Z",
				attemptedAt: "2026-11-14T15:58:41.000Z",
				error: null,
			},
			fallbackLabels: ["ubuntu-24.04"],
			x64FallbackLabels: ["ubuntu-24.04"],
		} as GithubRunnerPool;
		const node = (name: string, aside: GithubRunnerNodeHealth | null) =>
			({
				githubRunnerNodeId: name,
				githubRunnerPoolId: "pool",
				name,
				host: `${name}.tailnet.ts.net`,
				platform: "macos",
				enabled: true,
				phase: "ready",
				drain: null,
				lastSeenAt: new Date(now).toISOString(),
				lastError: null,
				updatePolicy: null,
				updateState: null,
				osReport: null,
				firewall: null,
				health: aside,
				observed: {
					at: new Date(now).toISOString(),
					reachable: true,
					admission: { ok: true },
					slots: [],
					runtime: { version: 18, runnerVersion: "2.338.2" },
				},
			}) as unknown as GithubRunnerNode;
		const conditions = runnerAlertConditions({
			pool,
			nodes: [
				node("m4", health),
				// Its cooldown ended: no alert left.
				node("m6", { ...health, degradedUntil: "2026-11-14T15:59:00.000Z" }),
			],
			now,
			runnerReleases: [
				{ version: "2.338.2", publishedAt: "2026-11-01T00:00:00.000Z" },
			],
			osReleases: () => [],
			token: null,
		});
		const asideAlerts = conditions.filter(
			(alert) => alert.kind === "set-aside",
		);
		expect(asideAlerts).toHaveLength(1);
		expect(asideAlerts[0]).toMatchObject({
			subject: "m4:set-aside",
			severity: "warning",
			message: expect.stringContaining(
				"m4 takes no new job until 16:26 UTC: 4 jobs lost within 10 minutes.",
			),
		});
		expect(
			conditions.find((alert) => alert.kind === "fallback")?.message,
		).toContain(
			"Set aside after losing jobs: m4 until 16:26 UTC (4 jobs lost within 10 minutes).",
		);
	});
});
