/**
 * Usage of the providers of a fallback chain this month, as they bill it:
 * GitHub's billing usage report for GitHub-hosted runners, the Blacksmith CLI
 * for Blacksmith (it has no documented HTTP API; the workflow-side router of
 * Flots reads it the same way, from the same pinned release).
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	GithubRunnerFallbackProvider,
	GithubRunnerProviderUsage,
} from "../../db/schema/github-runner";
import { API_VERSION, type GithubRunnerTarget, USER_AGENT } from "./github-api";
import { usageMonth } from "./providers";

const asNumber = (value: unknown) =>
	typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: null;

/**
 * Actions minutes and their net amount (past the included minutes) in a GitHub
 * billing usage report (GET /organizations/{org}/settings/billing/usage).
 * Self-hosted runners are not billed, so every Actions minute there ran on a
 * GitHub-hosted runner.
 */
export const parseGithubBillingUsage = (report: unknown) => {
	const items =
		report && typeof report === "object" && "usageItems" in report
			? (report as { usageItems: unknown }).usageItems
			: null;
	if (!Array.isArray(items)) {
		throw new Error("GitHub billing usage has no usageItems");
	}
	let minutes = 0;
	let spend = 0;
	for (const item of items as Record<string, unknown>[]) {
		if (String(item.product ?? "").toLowerCase() !== "actions") continue;
		if (!/^minutes?$/i.test(String(item.unitType ?? ""))) continue;
		minutes += asNumber(item.quantity) ?? 0;
		spend += asNumber(item.netAmount) ?? 0;
	}
	return { minutes, spend: Math.round(spend * 100) / 100 };
};

export const readGithubBillingUsage = async (input: {
	target: Pick<GithubRunnerTarget, "owner" | "apiUrl">;
	authorization: string;
	now: number;
	fetchImpl?: typeof fetch;
}) => {
	const fetchImpl = input.fetchImpl ?? fetch;
	const date = new Date(input.now);
	const query = `year=${date.getUTCFullYear()}&month=${date.getUTCMonth() + 1}`;
	const base = input.target.apiUrl.replace(/\/$/, "");
	const owner = encodeURIComponent(input.target.owner);
	// An organization first; a repository pool may belong to a user.
	for (const path of [
		`/organizations/${owner}/settings/billing/usage`,
		`/users/${owner}/settings/billing/usage`,
	]) {
		const response = await fetchImpl(`${base}${path}?${query}`, {
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: input.authorization,
				"X-GitHub-Api-Version": API_VERSION,
				"User-Agent": USER_AGENT,
			},
			signal: AbortSignal.timeout(30_000),
		});
		if (response.status === 404) continue;
		if (!response.ok) {
			throw new Error(
				response.status === 403
					? "GitHub refused the billing usage (HTTP 403): the credentials need read access to the billing of the account"
					: `GitHub billing usage failed with HTTP ${response.status}`,
			);
		}
		return parseGithubBillingUsage(await response.json());
	}
	throw new Error(`No billing usage for ${input.target.owner} (HTTP 404)`);
};

export const BLACKSMITH_CLI_VERSION = "v0.4.57";
/** The release the workflow-side router pins; a new one needs both checksums. */
export const BLACKSMITH_CLI_ASSETS = {
	x64: {
		url: `https://clireleases.blacksmith.sh/cli/${BLACKSMITH_CLI_VERSION}/linux/amd64/blacksmith`,
		sha256: "7f60f3b9f8d4d7644d9743f5d962acb3b3dbf675f51676702e5f292e02060bca",
	},
	arm64: {
		url: `https://clireleases.blacksmith.sh/cli/${BLACKSMITH_CLI_VERSION}/linux/arm64/blacksmith`,
		sha256: "04c8d261526e23c7791f05b8acec8f02b9d1fe67c35a1adcf28076627327270a",
	},
} as const;
/** Blacksmith bills vCPU minutes; its free minutes are minutes of 2 vCPUs. */
export const BLACKSMITH_BASELINE_VCPU = 2;
const MAX_BINARY_BYTES = 100 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** Free-tier minutes in a `blacksmith usage --format json` report. */
export const parseBlacksmithUsage = (report: unknown) => {
	const object = (value: unknown) =>
		value && typeof value === "object"
			? (value as Record<string, unknown>)
			: null;
	const root = object(report);
	if (!root) throw new Error("Blacksmith usage is not a JSON object");
	const found = [
		root.billing_minutes,
		object(root.total)?.billing_minutes,
		object(root.totals)?.billing_minutes,
		object(root.summary)?.billing_minutes,
	].filter((value) => value !== undefined);
	const billing = found.length === 1 ? asNumber(found[0]) : null;
	if (billing === null) {
		throw new Error(
			`Expected one billing_minutes figure in the Blacksmith usage, found ${found.length}`,
		);
	}
	return { minutes: billing / BLACKSMITH_BASELINE_VCPU };
};

export type RunCommand = (
	command: string,
	args: string[],
	options: { input?: string; env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<{ stdout: string }>;

/** Runs a binary without a shell, with bounded output and duration. */
export const runCommand: RunCommand = (command, args, options) =>
	new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			env: options.env,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const stdout: Buffer[] = [];
		let bytes = 0;
		let settled = false;
		const finish = (error: Error | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error) reject(error);
			else resolve({ stdout: Buffer.concat(stdout).toString("utf8") });
		};
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			finish(new Error(`blacksmith ${args[0]} timed out`));
		}, options.timeoutMs);
		child.stdout.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > MAX_OUTPUT_BYTES) {
				child.kill("SIGTERM");
				finish(new Error("blacksmith output too large"));
				return;
			}
			stdout.push(chunk);
		});
		child.stderr.on("data", () => undefined);
		child.on("error", (error) => finish(error));
		child.on("close", (code) =>
			finish(
				code === 0
					? null
					: new Error(`blacksmith ${args[0]} exited with ${code}`),
			),
		);
		child.stdin.end(options.input ?? "");
	});

const utcSeconds = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * Downloads the pinned Blacksmith CLI, checks it, reads this month's usage with
 * the organization token (given on stdin, never on the command line), and
 * removes the binary and its login before returning.
 */
export const readBlacksmithUsage = async (input: {
	token: string;
	organization: string;
	now: number;
	arch?: string;
	fetchImpl?: typeof fetch;
	run?: RunCommand;
}) => {
	const arch = (input.arch ?? process.arch) === "arm64" ? "arm64" : "x64";
	const asset = BLACKSMITH_CLI_ASSETS[arch];
	const fetchImpl = input.fetchImpl ?? fetch;
	const run = input.run ?? runCommand;
	const dir = await mkdtemp(join(tmpdir(), "dokploy-blacksmith-"));
	// A home of its own: the login stays in this directory, removed below.
	const env: NodeJS.ProcessEnv = {
		PATH: "/usr/bin:/bin",
		HOME: dir,
		XDG_CONFIG_HOME: dir,
		NODE_ENV: process.env.NODE_ENV,
	};
	const binary = join(dir, "blacksmith");
	let logged = false;
	try {
		const response = await fetchImpl(asset.url, {
			redirect: "follow",
			signal: AbortSignal.timeout(60_000),
		});
		if (!response.ok) {
			throw new Error(
				`Blacksmith CLI download failed with HTTP ${response.status}`,
			);
		}
		const bytes = Buffer.from(await response.arrayBuffer());
		if (!bytes.length || bytes.length > MAX_BINARY_BYTES) {
			throw new Error("Blacksmith CLI download has an invalid size");
		}
		if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256) {
			throw new Error("Blacksmith CLI checksum mismatch");
		}
		await writeFile(binary, bytes, { mode: 0o700 });
		await chmod(binary, 0o700);
		await run(
			binary,
			[
				"auth",
				"login",
				"--api-token",
				"-",
				"--non-interactive",
				"--organization",
				input.organization,
			],
			{ input: input.token, env, timeoutMs: 60_000 },
		);
		logged = true;
		const now = new Date(input.now);
		const start = new Date(
			Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
		);
		const { stdout } = await run(
			binary,
			[
				"usage",
				"--start-time",
				utcSeconds(start),
				"--end-time",
				utcSeconds(now),
				// The router's flags: the report then holds one billing_minutes total.
				"--breakdown-by",
				"runner_type,repo",
				"--limit",
				"1000",
				"--format",
				"json",
			],
			{ env, timeoutMs: 60_000 },
		);
		return parseBlacksmithUsage(JSON.parse(stdout));
	} finally {
		if (logged) {
			await run(binary, ["auth", "logout", "--all"], {
				env,
				timeoutMs: 15_000,
			}).catch(() => undefined);
		}
		await rm(dir, { recursive: true, force: true });
	}
};

/** What the controller needs to read the usage of a pool's providers. */
export interface UsageReaders {
	github: (now: number) => Promise<{ minutes: number; spend: number }>;
	blacksmith: ((now: number) => Promise<{ minutes: number }>) | null;
}

/** Reads the usage of each provider with a budget; a failure is kept, not thrown. */
export const readChainUsage = async (
	chain: GithubRunnerFallbackProvider[],
	readers: UsageReaders,
	now: number,
): Promise<Record<string, GithubRunnerProviderUsage>> => {
	const month = usageMonth(now);
	const measuredAt = new Date(now).toISOString();
	const entries = await Promise.all(
		chain
			.filter((provider) => provider.budget)
			.map(async (provider): Promise<[string, GithubRunnerProviderUsage]> => {
				try {
					if (provider.kind === "github") {
						const { minutes, spend } = await readers.github(now);
						return [
							provider.id,
							{ month, minutes, spend, measuredAt, error: null },
						];
					}
					if (!readers.blacksmith) {
						throw new Error("no Blacksmith organization or token in the pool");
					}
					const { minutes } = await readers.blacksmith(now);
					return [
						provider.id,
						{ month, minutes, spend: null, measuredAt, error: null },
					];
				} catch (error) {
					return [
						provider.id,
						{
							month,
							minutes: null,
							spend: null,
							measuredAt,
							error: error instanceof Error ? error.message : String(error),
						},
					];
				}
			}),
	);
	return Object.fromEntries(entries);
};
