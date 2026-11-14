import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
	apiCreateGithubRunnerPool,
	type GithubRunnerFallbackProvider,
	type GithubRunnerNode,
	type GithubRunnerPool,
	type GithubRunnerProviderUsage,
} from "@dokploy/server/db/schema";
import { runnerAlertConditions } from "@dokploy/server/utils/github-runners/alerts";
import {
	chooseFallback,
	limitMinutes,
	providerState,
	USAGE_STALE_MS,
} from "@dokploy/server/utils/github-runners/providers";
import { decideRouting } from "@dokploy/server/utils/github-runners/routing";
import {
	BLACKSMITH_CLI_ASSETS,
	parseBlacksmithUsage,
	parseGithubBillingUsage,
	type RunCommand,
	readBlacksmithUsage,
	readChainUsage,
	readGithubBillingUsage,
} from "@dokploy/server/utils/github-runners/usage";
import { describe, expect, it } from "vitest";

const now = Date.parse("2026-11-15T12:00:00Z");
const fresh = new Date(now - 60_000).toISOString();

const blacksmith: GithubRunnerFallbackProvider = {
	id: "bs",
	kind: "blacksmith",
	labels: ["blacksmith-2vcpu-ubuntu-2404-arm"],
	x64Labels: ["blacksmith-2vcpu-ubuntu-2404"],
	budget: {
		freeMinutes: 3000,
		pricePerMinute: 0.004,
		overspend: 0,
		warningPercent: 80,
	},
};
const github: GithubRunnerFallbackProvider = {
	id: "gh",
	kind: "github",
	labels: ["ubuntu-24.04-arm"],
	x64Labels: ["ubuntu-24.04"],
	budget: {
		freeMinutes: 3000,
		pricePerMinute: 0.008,
		overspend: 20,
		warningPercent: 80,
	},
};
const usage = (
	minutes: number | null,
	overrides: Partial<GithubRunnerProviderUsage> = {},
): GithubRunnerProviderUsage => ({
	month: "2026-11",
	minutes,
	spend: null,
	measuredAt: fresh,
	error: null,
	...overrides,
});

describe("provider budgets", () => {
	it("allows the free minutes, then what the overspend buys", () => {
		expect(limitMinutes(blacksmith.budget!)).toBe(3000);
		expect(limitMinutes(github.budget!)).toBe(3000 + 20 / 0.008);
		expect(limitMinutes({ ...github.budget!, pricePerMinute: 0 })).toBe(
			Number.POSITIVE_INFINITY,
		);
	});

	it("takes a provider without a budget as it is", () => {
		expect(
			providerState({ ...github, budget: null }, undefined, now),
		).toMatchObject({
			status: "within",
		});
	});

	it("skips a provider whose usage is missing, old, from last month or unreadable", () => {
		for (const [figures, reason] of [
			[undefined, /not read yet this month/],
			[usage(10, { month: "2026-10" }), /not read yet this month/],
			[usage(null, { error: "HTTP 403" }), /unreadable: HTTP 403/],
			[
				usage(10, {
					measuredAt: new Date(now - USAGE_STALE_MS - 1).toISOString(),
				}),
				/over two hours/,
			],
		] as const) {
			const state = providerState(github, figures, now);
			expect(state.status).toBe("unknown");
			expect(state.reason).toMatch(reason);
		}
	});

	it("warns past the warning level and stops at the free minutes without overspend", () => {
		expect(providerState(blacksmith, usage(1000), now).status).toBe("within");
		expect(providerState(blacksmith, usage(2500), now)).toMatchObject({
			status: "warning",
			reason: "83% of its budget used",
		});
		expect(providerState(blacksmith, usage(3000), now)).toMatchObject({
			status: "exhausted",
			reason: "3000 of its 3000 free minutes used",
		});
	});

	it("prices the minutes past the free ones, or uses what the provider charged", () => {
		// 4000 of the 5500 minutes the budget buys: 1000 past the free ones, 8 spent.
		expect(providerState(github, usage(4000), now)).toMatchObject({
			status: "within",
			spend: 8,
		});
		// 4500: 82% of the budget, 12 spent of the 20 allowed.
		expect(providerState(github, usage(4500), now)).toMatchObject({
			status: "warning",
			spend: 12,
		});
		expect(providerState(github, usage(6000), now)).toMatchObject({
			status: "exhausted",
			spend: 24,
			reason: "24 spent past its free minutes, of 20 allowed",
		});
		// GitHub reported its own charges: they decide, not the price.
		expect(providerState(github, usage(6000, { spend: 5 }), now)).toMatchObject(
			{
				status: "warning",
				spend: 5,
			},
		);
	});

	it("projects the month from its pace", () => {
		// 14.5 days elapsed on 15 November at noon, 30 days in the month.
		expect(providerState(blacksmith, usage(1450), now).projectedMinutes).toBe(
			3000,
		);
	});
});

describe("fallback choice", () => {
	const base = {
		fallbackLabels: ["ubuntu-24.04"],
		x64FallbackLabels: ["ubuntu-24.04"],
		now,
	};

	it("keeps the plain fallback labels without a chain", () => {
		expect(chooseFallback({ ...base, chain: [], usage: {} })).toEqual({
			provider: null,
			labels: ["ubuntu-24.04"],
			x64Labels: ["ubuntu-24.04"],
			exhausted: false,
			skipped: [],
		});
	});

	it("takes the first provider within its budget, in order", () => {
		const choice = chooseFallback({
			...base,
			chain: [blacksmith, github],
			usage: { bs: usage(3100), gh: usage(100) },
		});
		expect(choice.provider?.id).toBe("gh");
		expect(choice.labels).toEqual(["ubuntu-24.04-arm"]);
		expect(choice.x64Labels).toEqual(["ubuntu-24.04"]);
		expect(choice.skipped).toEqual([
			{ kind: "blacksmith", reason: "3100 of its 3000 free minutes used" },
		]);
		expect(
			chooseFallback({
				...base,
				chain: [blacksmith, github],
				usage: { bs: usage(10), gh: usage(100) },
			}).provider?.id,
		).toBe("bs");
	});

	it("says so when every provider is over budget or unreadable", () => {
		const choice = chooseFallback({
			...base,
			chain: [blacksmith, github],
			usage: { bs: usage(3100), gh: usage(null, { error: "HTTP 403" }) },
		});
		expect(choice.exhausted).toBe(true);
		expect(choice.provider).toBeNull();
		expect(choice.skipped.map((skip) => skip.kind)).toEqual([
			"blacksmith",
			"github",
		]);
	});

	it("records the provider on the routing only while it is the target", () => {
		const routing = {
			previous: null,
			anyEnabled: true,
			labels: ["flots-dokploy"],
			fallbackLabels: blacksmith.labels,
			provider: "blacksmith" as const,
			now,
		};
		expect(
			decideRouting({ ...routing, available: false, force: "fallback" }),
		).toMatchObject({
			target: "fallback",
			provider: "blacksmith",
			value: '"blacksmith-2vcpu-ubuntu-2404-arm"',
		});
		expect(decideRouting({ ...routing, available: true }).provider).toBeNull();
	});
});

describe("GitHub billing usage", () => {
	it("adds up the Actions minutes and their net amount", () => {
		expect(
			parseGithubBillingUsage({
				usageItems: [
					{
						product: "actions",
						sku: "Actions Linux",
						unitType: "Minutes",
						quantity: 120,
						netAmount: 0,
					},
					{
						product: "Actions",
						sku: "Actions Linux ARM",
						unitType: "minutes",
						quantity: 30.5,
						netAmount: 0.24,
					},
					{
						product: "actions",
						sku: "Actions storage",
						unitType: "GigabyteHours",
						quantity: 900,
						netAmount: 0.1,
					},
					{
						product: "packages",
						unitType: "Minutes",
						quantity: 10,
						netAmount: 3,
					},
				],
			}),
		).toEqual({ minutes: 150.5, spend: 0.24 });
		expect(() => parseGithubBillingUsage({ message: "Not Found" })).toThrow(
			/usageItems/,
		);
	});

	it("asks the organization, then the user, for this month, with the given credentials", async () => {
		const asked: { url: string; authorization: string | null }[] = [];
		const fetchImpl = (async (url: string, init?: RequestInit) => {
			asked.push({
				url,
				authorization: new Headers(init?.headers).get("authorization"),
			});
			return url.includes("/organizations/")
				? new Response("{}", { status: 404 })
				: Response.json({
						usageItems: [
							{
								product: "actions",
								unitType: "Minutes",
								quantity: 42,
								netAmount: 0,
							},
						],
					});
		}) as typeof fetch;
		expect(
			await readGithubBillingUsage({
				target: { owner: "Flots-app", apiUrl: "https://api.github.com" },
				authorization: "Bearer test",
				now,
				fetchImpl,
			}),
		).toEqual({ minutes: 42, spend: 0 });
		expect(asked).toEqual([
			{
				url: "https://api.github.com/organizations/Flots-app/settings/billing/usage?year=2026&month=11",
				authorization: "Bearer test",
			},
			{
				url: "https://api.github.com/users/Flots-app/settings/billing/usage?year=2026&month=11",
				authorization: "Bearer test",
			},
		]);
		await expect(
			readGithubBillingUsage({
				target: { owner: "Flots-app", apiUrl: "https://api.github.com" },
				authorization: "Bearer test",
				now,
				fetchImpl: (async () =>
					new Response("{}", { status: 403 })) as typeof fetch,
			}),
		).rejects.toThrow(/read access to the billing/);
	});
});

describe("Blacksmith usage", () => {
	it("reads the one billing_minutes total, in 2-vCPU minutes", () => {
		expect(parseBlacksmithUsage({ billing_minutes: 600 })).toEqual({
			minutes: 300,
		});
		expect(parseBlacksmithUsage({ totals: { billing_minutes: 90 } })).toEqual({
			minutes: 45,
		});
		expect(() => parseBlacksmithUsage({})).toThrow(/found 0/);
		expect(() =>
			parseBlacksmithUsage({
				billing_minutes: 1,
				total: { billing_minutes: 1 },
			}),
		).toThrow(/found 2/);
	});

	const cli = Buffer.from("#!/bin/sh\necho blacksmith\n");
	const download = (bytes: Buffer) =>
		(async () =>
			new Response(new Uint8Array(bytes))) as unknown as typeof fetch;

	it("runs the checked CLI with the token on stdin, then logs out and removes it", async () => {
		const calls: { args: string[]; input?: string; home?: string }[] = [];
		let binaryPath = "";
		const run: RunCommand = async (command, args, options) => {
			binaryPath = command;
			calls.push({ args, input: options.input, home: options.env.HOME });
			return {
				stdout:
					args[0] === "usage" ? JSON.stringify({ billing_minutes: 1000 }) : "",
			};
		};
		const asset = BLACKSMITH_CLI_ASSETS.x64;
		const original = asset.sha256;
		(asset as { sha256: string }).sha256 = createHash("sha256")
			.update(cli)
			.digest("hex");
		try {
			expect(
				await readBlacksmithUsage({
					token: "bs-secret",
					organization: "flots-app",
					now,
					arch: "x64",
					fetchImpl: download(cli),
					run,
				}),
			).toEqual({ minutes: 500 });
		} finally {
			(asset as { sha256: string }).sha256 = original;
		}
		expect(calls.map((call) => call.args[0])).toEqual([
			"auth",
			"usage",
			"auth",
		]);
		expect(calls[0]?.input).toBe("bs-secret");
		expect(calls.flatMap((call) => call.args).join(" ")).not.toContain(
			"bs-secret",
		);
		expect(calls[1]?.args).toEqual(
			expect.arrayContaining([
				"--start-time",
				"2026-11-01T00:00:00Z",
				"--end-time",
				"2026-11-15T12:00:00Z",
			]),
		);
		expect(calls[2]?.args).toEqual(["auth", "logout", "--all"]);
		// Its own home: the login lives there, and goes with it.
		expect(calls[0]?.home).toBe(binaryPath.replace(/\/blacksmith$/, ""));
		expect(existsSync(binaryPath)).toBe(false);
	});

	it("refuses a CLI whose checksum differs, and runs nothing", async () => {
		const calls: string[][] = [];
		await expect(
			readBlacksmithUsage({
				token: "bs-secret",
				organization: "flots-app",
				now,
				arch: "arm64",
				fetchImpl: download(cli),
				run: async (_command, args) => {
					calls.push(args);
					return { stdout: "" };
				},
			}),
		).rejects.toThrow(/checksum mismatch/);
		expect(calls).toEqual([]);
	});
});

describe("usage of a chain", () => {
	it("reads the providers with a budget and keeps a failure as the reason", async () => {
		const chain = [blacksmith, github, { ...github, id: "free", budget: null }];
		const read = await readChainUsage(
			chain,
			{ github: async () => ({ minutes: 12, spend: 0.5 }), blacksmith: null },
			now,
		);
		expect(Object.keys(read).sort()).toEqual(["bs", "gh"]);
		expect(read.gh).toEqual({
			month: "2026-11",
			minutes: 12,
			spend: 0.5,
			measuredAt: new Date(now).toISOString(),
			error: null,
		});
		expect(read.bs).toMatchObject({
			minutes: null,
			error: "no Blacksmith organization or token in the pool",
		});
	});
});

describe("pool settings and alerts", () => {
	it("validates the chain", () => {
		const parse = (fallbackChain: unknown) =>
			apiCreateGithubRunnerPool.safeParse({
				name: "pool",
				scope: "organization",
				owner: "Flots-app",
				authType: "token",
				token: "ghp_example",
				fallbackChain,
			});
		expect(parse(undefined).data?.fallbackChain).toEqual([]);
		expect(parse([blacksmith, github]).success).toBe(true);
		expect(parse([blacksmith, { ...github, id: "bs" }]).success).toBe(false);
		expect(parse([{ ...github, labels: [] }]).success).toBe(false);
	});

	const pool = (overrides: Partial<GithubRunnerPool>) =>
		({
			githubRunnerPoolId: "pool",
			organizationId: "org",
			name: "Flots-app",
			authType: "app",
			token: null,
			runnerVersion: null,
			updatePolicy: { auto: true, window: null },
			routingVariable: "DOKPLOY_RUNS_ON",
			routing: null,
			fallbackLabels: ["ubuntu-24.04"],
			x64FallbackLabels: ["ubuntu-24.04"],
			fallbackChain: [blacksmith, github],
			fallbackUsage: {},
			...overrides,
		}) as GithubRunnerPool;
	const machine = (accepting: boolean) =>
		({
			githubRunnerNodeId: "m4",
			githubRunnerPoolId: "pool",
			name: "m4",
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
			health: null,
			observed: {
				at: new Date(now).toISOString(),
				reachable: true,
				admission: accepting
					? { ok: true }
					: { ok: false, reason: "set aside" },
				slots: [],
				runtime: { version: 18, runnerVersion: "2.338.2" },
			},
		}) as unknown as GithubRunnerNode;
	const alerts = (overrides: Partial<GithubRunnerPool>, accepting = true) =>
		runnerAlertConditions({
			pool: pool(overrides),
			nodes: [machine(accepting)],
			now,
			runnerReleases: [
				{ version: "2.338.2", publishedAt: "2026-11-01T00:00:00Z" },
			],
			osReleases: () => [],
			token: null,
		});

	it("warns near a budget, alerts over it and when usage is unknown", () => {
		const conditions = alerts({
			fallbackUsage: {
				bs: usage(2600),
				gh: usage(null, { error: "HTTP 403" }),
			},
		});
		expect(
			conditions.map((alert) => [alert.subject, alert.kind, alert.severity]),
		).toEqual(
			expect.arrayContaining([
				["pool:provider-budget:bs", "provider-budget", "warning"],
				["pool:provider-usage:gh", "provider-usage", "warning"],
			]),
		);
		expect(
			conditions.find((alert) => alert.subject === "pool:provider-budget:bs")
				?.title,
		).toBe("Flots-app: Blacksmith nears its budget");
		expect(conditions.some((alert) => alert.kind === "no-fallback")).toBe(
			false,
		);
	});

	it("is critical once no machine and no provider takes jobs", () => {
		const conditions = alerts(
			{ fallbackUsage: { bs: usage(3100), gh: usage(7000) } },
			false,
		);
		const critical = conditions.find((alert) => alert.kind === "no-fallback");
		expect(critical).toMatchObject({
			severity: "critical",
			subject: "pool:no-fallback",
		});
		expect(critical?.message).toContain(
			"Blacksmith: 3100 of its 3000 free minutes used",
		);
	});
});
