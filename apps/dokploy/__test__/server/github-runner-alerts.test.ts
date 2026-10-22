import type {
	GithubRunnerNode,
	GithubRunnerPool,
} from "@dokploy/server/db/schema";
import {
	parseTokenExpiration,
	runnerAlertConditions,
} from "@dokploy/server/utils/github-runners/alerts";
import { checkToken } from "@dokploy/server/utils/github-runners/github-api";
import type { OsRelease } from "@dokploy/server/utils/github-runners/os";
import { runnerNoticeHeading } from "@dokploy/server/utils/notifications/github-runners";
import { describe, expect, it } from "vitest";

const now = Date.parse("2026-10-22T08:00:00.000Z");
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const DAY = 24 * 60 * 60_000;

const pool = (overrides: Partial<GithubRunnerPool> = {}) =>
	({
		githubRunnerPoolId: "pool",
		organizationId: "org",
		name: "Flots CI",
		authType: "app",
		token: null,
		runnerVersion: null,
		updatePolicy: { auto: true, window: null },
		routingVariable: null,
		routing: null,
		fallbackLabels: ["ubuntu-24.04"],
		...overrides,
	}) as GithubRunnerPool;

const node = (overrides: Partial<GithubRunnerNode> = {}) =>
	({
		githubRunnerNodeId: "m6",
		githubRunnerPoolId: "pool",
		name: "m6",
		host: "m6.tailnet.ts.net",
		platform: "macos",
		enabled: true,
		phase: "ready",
		drain: null,
		lastSeenAt: ago(0),
		lastError: null,
		updatePolicy: null,
		updateState: null,
		osReport: null,
		firewall: null,
		observed: {
			at: ago(0),
			reachable: true,
			admission: { ok: true },
			slots: [],
			runtime: { version: 6, runnerVersion: "2.331.0" },
		},
		...overrides,
	}) as GithubRunnerNode;

const releases = [
	{ version: "2.331.0", publishedAt: new Date(now - 40 * DAY).toISOString() },
];

const conditions = (
	nodes: GithubRunnerNode[],
	options: {
		pool?: GithubRunnerPool;
		token?: { valid: boolean; expiresAt: string | null } | null;
		osReleases?: OsRelease[];
	} = {},
) =>
	runnerAlertConditions({
		pool: options.pool ?? pool(),
		nodes,
		now,
		runnerReleases: releases,
		osReleases: () => options.osReleases ?? [],
		token: options.token ?? null,
	});

describe("runner alerts", () => {
	it("raises nothing for a healthy pool", () => {
		expect(conditions([node()])).toEqual([]);
	});

	it("flags an unreachable machine after three minutes", () => {
		const [alert] = conditions([
			node({
				lastSeenAt: "2026-10-22T07:50:00.000Z",
				observed: {
					at: ago(0),
					reachable: false,
					error: "connect ETIMEDOUT",
					admission: { ok: true },
					slots: [],
				},
			}),
		]);
		expect(alert).toMatchObject({
			subject: "m6:unreachable",
			nodeId: "m6",
			severity: "critical",
			title: "m6 is unreachable",
			delayMs: 3 * 60_000,
		});
		expect(alert?.message).toContain("since 2026-10-22 07:50 UTC");
		expect(alert?.message).toContain("connect ETIMEDOUT");
	});

	it("ignores machines being set up or disabled on purpose", () => {
		const unreachable = {
			at: ago(0),
			reachable: false,
			admission: { ok: false, reason: "low disk" },
			slots: [],
		};
		expect(
			conditions([
				node({ phase: "provisioning", observed: unreachable }),
				node({
					githubRunnerNodeId: "m4",
					enabled: false,
					phase: "stopped",
					observed: unreachable,
				}),
			]),
		).toEqual([]);
	});

	it("flags a machine that stopped taking jobs for its disk", () => {
		const [alert] = conditions([
			node({
				observed: {
					at: ago(0),
					reachable: true,
					admission: {
						ok: false,
						reason: "12.0 GiB free, below the 15 GiB reserve",
					},
					slots: [],
					runtime: { version: 6, runnerVersion: "2.331.0" },
				},
			}),
		]);
		expect(alert).toMatchObject({
			kind: "disk",
			severity: "warning",
			delayMs: 10 * 60_000,
		});
		expect(alert?.message).toContain("below the 15 GiB reserve");
	});

	it("flags a firewall that could not be applied", () => {
		const [alert] = conditions([
			node({
				firewall: {
					firewallId: "fw",
					revision: 1,
					hash: null,
					appliedAt: null,
					error: "The Mac has no firewall helper: run the setup script again",
					errorAt: ago(1),
				},
			}),
		]);
		expect(alert).toMatchObject({
			kind: "firewall",
			severity: "critical",
			title: "Firewall not applied on m6",
		});
	});

	it("reports a failed update once, not also as an outdated runner", () => {
		const alerts = runnerAlertConditions({
			pool: pool(),
			now,
			runnerReleases: [
				{
					version: "2.331.0",
					publishedAt: new Date(now - 2 * DAY).toISOString(),
				},
			],
			osReleases: () => [],
			token: null,
			nodes: [
				node({
					updateState: { error: "download failed", errorAt: ago(5) },
					observed: {
						at: ago(0),
						reachable: true,
						admission: { ok: true },
						slots: [],
						runtime: { version: 6, runnerVersion: "2.330.0" },
					},
				}),
			],
		});
		expect(alerts.map((alert) => alert.kind)).toEqual(["update-failed"]);
	});

	it("is critical once GitHub no longer queues jobs on the runner", () => {
		const [alert] = runnerAlertConditions({
			pool: pool({ runnerVersion: "2.330.0" }),
			nodes: [
				node({
					observed: {
						at: ago(0),
						reachable: true,
						admission: { ok: true },
						slots: [],
						runtime: { version: 6, runnerVersion: "2.330.0" },
					},
				}),
			],
			now,
			runnerReleases: [
				...releases,
				{
					version: "2.330.0",
					publishedAt: new Date(now - 80 * DAY).toISOString(),
				},
			],
			osReleases: () => [],
			token: null,
		});
		expect(alert).toMatchObject({
			kind: "runner-version",
			severity: "critical",
			title: "Runner too old on m6",
		});
	});

	it("raises OS alerts for the Mac and its VM separately", () => {
		const alerts = conditions(
			[
				node({
					osReport: {
						at: ago(60),
						host: {
							id: "macos",
							version: "27.0.1",
							build: null,
							kernel: "",
							updates: 0,
							security: 0,
							reboot: null,
							listsAt: null,
						},
						guest: {
							id: "ubuntu",
							version: "22.04",
							build: null,
							kernel: "",
							updates: 3,
							security: 2,
							reboot: true,
							listsAt: ago(60),
						},
					},
				}),
			],
			{
				osReleases: [
					{ name: "27", isEol: false, eolFrom: null, latest: "27.0.1" },
					{
						name: "22.04",
						isEol: false,
						eolFrom: "2027-06-01",
						latest: null,
					},
				],
			},
		);
		expect(alerts).toEqual([
			expect.objectContaining({
				subject: "m6:os-guest",
				severity: "warning",
				title: "OS updates needed on m6 (VM)",
				delayMs: 3 * DAY,
			}),
		]);
	});

	it("tells when jobs go to GitHub-hosted runners", () => {
		const alerts = conditions([node({ enabled: false, phase: "stopped" })], {
			pool: pool({
				routingVariable: "DOKPLOY_RUNS_ON",
				routing: {
					variable: "DOKPLOY_RUNS_ON",
					target: "fallback",
					value: '["ubuntu-24.04"]',
					since: "2026-10-21T22:00:00.000Z",
					unavailableSince: null,
					syncedValue: null,
					syncedAt: null,
					attemptedAt: null,
					error: null,
				},
			}),
		});
		expect(alerts).toEqual([
			expect.objectContaining({
				subject: "pool:fallback",
				nodeId: null,
				severity: "warning",
			}),
		]);
		expect(alerts[0]?.message).toContain("ubuntu-24.04");
	});

	it("is critical when no machine takes jobs and the pool has no fallback", () => {
		const alerts = conditions([
			node({
				observed: {
					at: ago(0),
					reachable: false,
					admission: { ok: true },
					slots: [],
				},
			}),
			node({ githubRunnerNodeId: "m4", name: "m4", drain: {} as never }),
		]);
		expect(alerts.map((alert) => alert.subject)).toEqual([
			"m6:unreachable",
			"pool:no-capacity",
		]);
	});

	it("does not call capacity missing when every machine is disabled", () => {
		expect(conditions([node({ enabled: false, phase: "stopped" })])).toEqual(
			[],
		);
	});

	it("warns before a personal access token expires", () => {
		const tokenPool = pool({ authType: "token", token: "t" });
		const expiring = (expiresAt: string) =>
			conditions([], { pool: tokenPool, token: { valid: true, expiresAt } });
		expect(expiring("2026-12-01 00:00:00 UTC")).toEqual([]);
		expect(expiring("2026-11-01 08:00:00 UTC")).toEqual([
			expect.objectContaining({ subject: "pool:token", severity: "warning" }),
		]);
		expect(expiring("2026-10-24 08:00:00 +0200")).toEqual([
			expect.objectContaining({ severity: "critical" }),
		]);
		expect(
			conditions([], {
				pool: tokenPool,
				token: { valid: false, expiresAt: null },
			}),
		).toEqual([
			expect.objectContaining({
				severity: "critical",
				title: "Flots CI: GitHub token rejected",
			}),
		]);
		// App pools have no token to check.
		expect(
			conditions([], { token: { valid: false, expiresAt: null } }),
		).toEqual([]);
	});

	it("reads GitHub's token expiry header", () => {
		expect(parseTokenExpiration("2026-11-02 10:00:00 UTC")).toBe(
			"2026-11-02T10:00:00.000Z",
		);
		expect(parseTokenExpiration("2026-11-02 10:00:00 -0800")).toBe(
			"2026-11-02T18:00:00.000Z",
		);
		expect(parseTokenExpiration("soon")).toBeNull();
		expect(parseTokenExpiration(null)).toBeNull();
	});

	it("tells a rejected token from an unreachable GitHub", async () => {
		await expect(
			checkToken("t", "https://api.github.com", {
				fetch: async () => new Response("{}", { status: 401 }),
			}),
		).resolves.toEqual({ valid: false, expiresAt: null });
		await expect(
			checkToken("t", "https://api.github.com", {
				fetch: async () => new Response("{}", { status: 503 }),
			}),
		).rejects.toThrow("503");
	});

	it("words each kind of notice", () => {
		const notice = {
			severity: "critical" as const,
			title: "m6 is unreachable",
			message: "",
			pool: "Flots CI",
			machine: "m6",
			at: new Date(now),
		};
		expect(runnerNoticeHeading({ ...notice, event: "opened" })).toBe(
			"m6 is unreachable",
		);
		expect(runnerNoticeHeading({ ...notice, event: "reminder" })).toBe(
			"Still open: m6 is unreachable",
		);
		expect(runnerNoticeHeading({ ...notice, event: "resolved" })).toBe(
			"Resolved: m6 is unreachable",
		);
	});
});
