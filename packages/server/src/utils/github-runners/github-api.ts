import { createAppAuth } from "@octokit/auth-app";
import { Octokit, RequestError } from "octokit";
import type { RunnerReleaseInfo } from "./versions";

export interface GithubRunnerTarget {
	scope: "organization" | "repository";
	owner: string;
	repository: string | null;
	runnerGroup: string;
	apiUrl: string;
}

export type GithubRunnerAuth =
	| { type: "token"; token: string }
	| {
			type: "app";
			appId: number;
			installationId: string;
			privateKey: string;
	  };

export interface GithubRunner {
	id: number;
	name: string;
	os: string;
	status: "online" | "offline";
	busy: boolean;
	labels: string[];
	/** Labels set at registration, as opposed to the read-only ones GitHub adds. */
	customLabels: string[];
	version: string | null;
}

export interface GithubRunnerGroup {
	id: number;
	name: string;
	default: boolean;
	/** Repositories allowed to use it: every one, a selection, or private ones only. */
	visibility: "all" | "selected" | "private";
	allowsPublicRepositories: boolean;
}

export class GithubRunnerApiError extends Error {
	constructor(
		message: string,
		readonly status: number | null,
	) {
		super(message);
	}
}

/**
 * Whether a GitHub failure will not heal by itself: bad credentials, a missing
 * run, a request GitHub refuses. Network errors, timeouts, 5xx, 429 and
 * rate-limited 403s ("API rate limit exceeded", "secondary rate limit") are
 * worth trying again later.
 */
export const isPermanentGithubError = (error: unknown) => {
	if (!(error instanceof GithubRunnerApiError) || error.status === null) {
		return false;
	}
	if (error.status === 403) return !/rate limit/i.test(error.message);
	return [401, 404, 410, 422].includes(error.status);
};

type Fetch = typeof fetch;

export interface WorkflowRun {
	status: string;
	conclusion: string | null;
	runAttempt: number;
}

export interface WorkflowRunJob {
	name: string;
	status: string;
	conclusion: string | null;
	runnerName: string | null;
	/** The runs-on labels GitHub resolved when it queued the job. */
	labels: string[];
	createdAt: string | null;
}

export interface QueuedRun {
	id: number;
	runAttempt: number;
	workflow: string;
	createdAt: string;
}

export interface GithubRunnerClient {
	target: GithubRunnerTarget;
	/** Authorization header of the pool credentials. */
	authorization: () => Promise<string>;
	/** `repository` is "owner/name" and must belong to the pool target. */
	getRun: (repository: string, runId: string) => Promise<WorkflowRun>;
	listRunJobs: (repository: string, runId: string) => Promise<WorkflowRunJob[]>;
	forceCancelRun: (repository: string, runId: string) => Promise<void>;
	cancelRun: (repository: string, runId: string) => Promise<void>;
	/** Private repositories the pool may route jobs for ("owner/name"). */
	listRepositories: () => Promise<string[]>;
	listQueuedRuns: (repository: string) => Promise<QueuedRun[]>;
	/** Writes the Actions variable of the pool target (organization: private repositories). */
	setVariable: (name: string, value: string) => Promise<void>;
	deleteVariable: (name: string) => Promise<void>;
	/** Whether the credentials may manage the Actions variables of the target. */
	canManageVariables: () => Promise<boolean>;
	rerunFailedJobs: (repository: string, runId: string) => Promise<void>;
	listRunners: () => Promise<GithubRunner[]>;
	/** Organization runner groups, with which repositories may use them. */
	runnerGroups: () => Promise<GithubRunnerGroup[]>;
	runnerGroupId: () => Promise<number>;
	generateJitConfig: (options: {
		name: string;
		labels: string[];
	}) => Promise<{ runnerId: number; encodedJitConfig: string }>;
	/** "busy" when GitHub refuses because the runner is running a job. */
	deleteRunner: (runnerId: number) => Promise<"deleted" | "missing" | "busy">;
}

const REQUEST_TIMEOUT_MS = 20_000;
const API_VERSION = "2022-11-28";
const USER_AGENT = "dokploy-github-runners";
/** Conditional GETs remembered per client: pages of runners, queued runs per repository. */
const MAX_ETAGS = 500;

/**
 * Octokit for one GitHub API, for the calls it makes simpler (pagination,
 * typed endpoints). Its retry and throttling plugins are off: they would wait
 * out a rate limit inside the controller tick. Every request has a timeout.
 */
const githubOctokit = (
	apiUrl: string,
	options: {
		fetch?: Fetch;
		timeoutMs?: number;
		authorization?: () => Promise<string>;
	} = {},
) => {
	const octokit = new Octokit({
		baseUrl: apiUrl.replace(/\/+$/, ""),
		userAgent: USER_AGENT,
		request: { fetch: options.fetch ?? fetch },
		retry: { enabled: false },
		throttle: { enabled: false },
	});
	octokit.hook.wrap("request", async (request, endpoint) =>
		request({
			...endpoint,
			headers: {
				...endpoint.headers,
				"x-github-api-version": API_VERSION,
				...(options.authorization
					? { authorization: await options.authorization() }
					: {}),
			},
			request: {
				...endpoint.request,
				signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
			},
		}),
	);
	return octokit;
};

/** The HTTP status of a failed Octokit call; null when GitHub did not answer. */
const statusOf = (error: unknown) =>
	error instanceof RequestError && error.response ? error.status : null;

/** A failed Octokit call as the error the controller reads. */
const apiError = (error: unknown, path: string) => {
	const status = statusOf(error);
	if (status === null) {
		return new GithubRunnerApiError(
			`GitHub API ${path} unreachable: ${error instanceof Error ? error.message : String(error)}`,
			null,
		);
	}
	const data = (error as RequestError).response?.data;
	return new GithubRunnerApiError(
		describeFailure(
			status,
			typeof data === "string" ? data : JSON.stringify(data ?? {}),
			path,
		),
		status,
	);
};

/** GitHub's own message in an error body, or the start of the body. */
const failureMessage = (body: string) => {
	try {
		return (
			(JSON.parse(body) as { message?: string }).message ?? body.slice(0, 300)
		);
	} catch {
		return body.slice(0, 300);
	}
};

/**
 * A rate limit, primary or secondary: a 429, or a 403 whose message says so
 * (the remaining quota header is 0 for the primary one).
 */
const isRateLimited = (status: number, message: string) =>
	status === 429 || (status === 403 && /rate limit/i.test(message));

const describeFailure = (status: number, body: string, path: string) => {
	const message = failureMessage(body);
	if (status === 401) {
		return "GitHub rejected the credentials (401). Check the token or the GitHub App key.";
	}
	// Not a permission to fix: GitHub accepts requests again later.
	if (isRateLimited(status, message)) {
		return `GitHub rate limit reached (${status}): ${message}`;
	}
	if (status === 403 || status === 404) {
		return `GitHub refused ${path} (${status}: ${message}). The credentials need the "Self-hosted runners: read and write" organization permission, or "Administration: read and write" on the repository.`;
	}
	return `GitHub API ${path} failed (${status}): ${message}`;
};

/** Writing the routing variable needs one more permission than the runners. */
const describeVariableFailure = (
	status: number,
	body: string,
	target: Pick<GithubRunnerTarget, "scope">,
) =>
	(status === 403 || status === 404) &&
	!isRateLimited(status, failureMessage(body))
		? `GitHub refused to write the routing variable (${status}). The credentials need "Variables: read and write" on the ${target.scope === "organization" ? "organization" : "repository"}.`
		: describeFailure(status, body, "actions/variables");

/** Wait after a rate limit when GitHub does not say how long (at least a minute). */
const RATE_LIMIT_WAIT_MS = 60_000;
/** The wait doubles while the limit lasts, up to this. */
const RATE_LIMIT_MAX_WAIT_MS = 30 * 60_000;

/**
 * A fetch that honours GitHub's rate limits for one set of credentials: once
 * GitHub answers that the limit is reached, nothing more is sent until it
 * accepts requests again (retry-after, else x-ratelimit-reset when the quota
 * is spent, else a minute that doubles while it lasts). Continuing to send
 * "may result in the banning of your integration"
 * (https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).
 * Meanwhile it answers 429 itself, so the custom requests and Octokit report
 * the same error.
 */
export const rateLimitedFetch = (
	fetcher: Fetch,
	label: string,
	now: () => number = Date.now,
): Fetch => {
	let pausedUntil = 0;
	let strikes = 0;
	let reason = "";
	const refusal = () => {
		const seconds = Math.max(1, Math.ceil((pausedUntil - now()) / 1000));
		const until = new Date(pausedUntil).toISOString().slice(11, 16);
		return new Response(
			JSON.stringify({
				message: `${reason ? `${reason} ` : ""}Dokploy sends nothing more until ${until} UTC.`,
			}),
			{
				status: 429,
				headers: {
					"content-type": "application/json",
					"retry-after": String(seconds),
				},
			},
		);
	};
	return (async (input, init) => {
		if (now() < pausedUntil) return refusal();
		const response = await fetcher(input, init);
		if (response.status !== 403 && response.status !== 429) {
			strikes = 0;
			return response;
		}
		const message = failureMessage(await response.clone().text());
		const spent = response.headers.get("x-ratelimit-remaining") === "0";
		if (!spent && !isRateLimited(response.status, message)) return response;
		strikes++;
		const retryAfter = Number(response.headers.get("retry-after"));
		const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000;
		const told = retryAfter > 0 ? now() + retryAfter * 1000 : spent ? reset : 0;
		// No wait given, or a reset already past (clock skew): back off.
		pausedUntil =
			told > now()
				? told
				: now() +
					Math.min(
						RATE_LIMIT_WAIT_MS * 2 ** (strikes - 1),
						RATE_LIMIT_MAX_WAIT_MS,
					);
		reason = message;
		console.warn(
			`GitHub runners: GitHub rate limit reached for ${label} (${message}); no request until ${new Date(pausedUntil).toISOString()}`,
		);
		return refusal();
	}) as Fetch;
};

const createAuthorization = (
	auth: GithubRunnerAuth,
	apiUrl: string,
	fetcher?: Fetch,
) => {
	if (auth.type === "token") {
		return async () => `Bearer ${auth.token}`;
	}
	// The installation token is cached and refreshed by auth-app.
	const appAuth = createAppAuth({
		appId: auth.appId,
		privateKey: auth.privateKey,
		installationId: auth.installationId,
		request: githubOctokit(apiUrl, { fetch: fetcher }).request,
	});
	return async () => {
		try {
			const { token } = await appAuth({ type: "installation" });
			return `Bearer ${token}`;
		} catch (error) {
			throw new GithubRunnerApiError(
				`GitHub App authentication failed: ${error instanceof Error ? error.message : String(error)}`,
				null,
			);
		}
	};
};

export const findRunnerGroup = (groups: GithubRunnerGroup[], name: string) => {
	const wanted = name.trim().toLowerCase();
	return groups.find((group) => group.name.toLowerCase() === wanted) ?? null;
};

/**
 * The installation of a GitHub App on the pool owner, found from the App ID and
 * its private key alone, so nobody has to look the installation ID up.
 */
export const findAppInstallation = async (
	app: { appId: number; privateKey: string },
	target: Pick<GithubRunnerTarget, "scope" | "owner" | "repository" | "apiUrl">,
	options: { fetch?: Fetch } = {},
) => {
	let jwt: string;
	try {
		const appAuth = createAppAuth({
			appId: app.appId,
			privateKey: app.privateKey,
		});
		jwt = (await appAuth({ type: "app" })).token;
	} catch {
		throw new GithubRunnerApiError(
			"The private key is not a GitHub App key: load the .pem file GitHub downloaded when you generated it.",
			null,
		);
	}
	const octokit = githubOctokit(target.apiUrl, {
		fetch: options.fetch,
		authorization: async () => `Bearer ${jwt}`,
	});
	const where =
		target.scope === "organization"
			? target.owner
			: `${target.owner}/${target.repository}`;
	try {
		const { data } =
			target.scope === "organization"
				? await octokit.rest.apps.getOrgInstallation({ org: target.owner })
				: await octokit.rest.apps.getRepoInstallation({
						owner: target.owner,
						repo: target.repository ?? "",
					});
		return String(data.id);
	} catch (error) {
		const status = statusOf(error);
		if (status === 401) {
			throw new GithubRunnerApiError(
				"GitHub rejected the App ID or the private key (401): check that both belong to the same GitHub App.",
				401,
			);
		}
		if (status === 404) {
			const page = await octokit.rest.apps
				.getAuthenticated()
				.then(({ data }) => data)
				.catch(() => null);
			throw new GithubRunnerApiError(
				`The GitHub App is not installed on ${where}.${page?.html_url ? ` Install it from ${page.html_url}/installations/new, then try again.` : ""}`,
				404,
			);
		}
		throw apiError(error, `installation of ${where}`);
	}
};

/**
 * Whether GitHub accepts a token, and when it expires: GitHub adds the expiry
 * to the responses it authenticates with an expiring token. Throws when GitHub
 * cannot be reached.
 */
export const checkToken = async (
	token: string,
	apiUrl: string,
	options: { fetch?: Fetch } = {},
) => {
	const response = await (options.fetch ?? fetch)(
		`${apiUrl.replace(/\/+$/, "")}/rate_limit`,
		{
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${token}`,
				"User-Agent": USER_AGENT,
			},
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		},
	);
	if (response.status === 401) return { valid: false, expiresAt: null };
	if (!response.ok) {
		throw new Error(`GitHub answered ${response.status} to the token check`);
	}
	return {
		valid: true,
		expiresAt:
			response.headers.get("github-authentication-token-expiration") ?? null,
	};
};

/** When a token expires; null for tokens without expiry or on failure. */
export const tokenExpiration = (
	token: string,
	apiUrl: string,
	options: { fetch?: Fetch } = {},
) =>
	checkToken(token, apiUrl, options)
		.then((result) => result.expiresAt)
		.catch(() => null);

/** Base path of the runner endpoints for the target. */
export const runnersPath = (target: GithubRunnerTarget) =>
	target.scope === "organization"
		? `/orgs/${encodeURIComponent(target.owner)}/actions/runners`
		: `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repository ?? "")}/actions/runners`;

export const createGithubRunnerClient = (
	target: GithubRunnerTarget,
	auth: GithubRunnerAuth,
	options: { fetch?: Fetch; timeoutMs?: number } = {},
): GithubRunnerClient => {
	// Every call of these credentials goes through it: Octokit, the app token too.
	const fetcher = rateLimitedFetch(
		options.fetch ?? fetch,
		target.repository ? `${target.owner}/${target.repository}` : target.owner,
	);
	const authorization = createAuthorization(auth, target.apiUrl, fetcher);
	const octokit = githubOctokit(target.apiUrl, {
		fetch: fetcher,
		timeoutMs: options.timeoutMs,
		authorization,
	});
	const base = target.apiUrl.replace(/\/+$/, "");
	let groupId: number | null = target.scope === "repository" ? 1 : null;

	// Conditional GETs for what the controller polls (the runner list every
	// tick, the queued runs of each repository every minute): a 304 does not
	// count against the GitHub rate limit. Past MAX_ETAGS the least recently
	// used entry goes, so a client living as long as the process stays small.
	const etags = new Map<string, { etag: string; text: string }>();
	const remember = (path: string, entry: { etag: string; text: string }) => {
		etags.delete(path);
		etags.set(path, entry);
		const oldest = etags.keys().next().value;
		if (etags.size > MAX_ETAGS && oldest !== undefined) etags.delete(oldest);
	};

	const request = async (
		method: string,
		path: string,
		body?: unknown,
		{ etag: conditional = false } = {},
	) => {
		const cached = conditional ? etags.get(path) : undefined;
		const response = await fetcher(`${base}${path}`, {
			method,
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: await authorization(),
				"X-GitHub-Api-Version": API_VERSION,
				"User-Agent": USER_AGENT,
				...(cached ? { "If-None-Match": cached.etag } : {}),
				...(body ? { "Content-Type": "application/json" } : {}),
			},
			body: body ? JSON.stringify(body) : undefined,
			signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
		}).catch((error: unknown) => {
			throw new GithubRunnerApiError(
				`GitHub API ${method} ${path} unreachable: ${error instanceof Error ? error.message : String(error)}`,
				null,
			);
		});
		if (cached && response.status === 304) {
			remember(path, cached);
			return { status: 200, text: cached.text };
		}
		const text = await response.text();
		const etag = response.headers.get("etag");
		if (conditional && response.ok && etag) remember(path, { etag, text });
		return { status: response.status, text };
	};

	const json = async <T>(
		method: string,
		path: string,
		body?: unknown,
		cache: { etag?: boolean } = {},
	) => {
		const response = await request(method, path, body, cache);
		if (response.status < 200 || response.status >= 300) {
			throw new GithubRunnerApiError(
				describeFailure(response.status, response.text, path),
				response.status,
			);
		}
		return JSON.parse(response.text) as T;
	};

	/**
	 * Runners of the target. For an organization only the pool's runner group is
	 * listed: an organization can hold hundreds of runners of other providers.
	 */
	const listRunners = async () => {
		const runners: GithubRunner[] = [];
		const listPath =
			target.scope === "organization"
				? `/orgs/${encodeURIComponent(target.owner)}/actions/runner-groups/${await runnerGroupId()}/runners`
				: runnersPath(target);
		for (let page = 1; page <= 50; page++) {
			const data = await json<{
				total_count: number;
				runners: {
					id: number;
					name: string;
					os: string;
					status: string;
					busy: boolean;
					labels: { name: string; type?: string }[];
					version?: string | null;
				}[];
			}>("GET", `${listPath}?per_page=100&page=${page}`, undefined, {
				etag: true,
			});
			for (const runner of data.runners) {
				runners.push({
					id: runner.id,
					name: runner.name,
					os: runner.os,
					status: runner.status === "online" ? "online" : "offline",
					busy: runner.busy,
					labels: runner.labels.map((item) => item.name),
					customLabels: runner.labels
						.filter((item) => item.type === "custom")
						.map((item) => item.name),
					version: runner.version ?? null,
				});
			}
			if (data.runners.length < 100 || runners.length >= data.total_count) {
				break;
			}
		}
		return runners;
	};

	const runnerGroups = async (): Promise<GithubRunnerGroup[]> => {
		const data = await json<{
			runner_groups: {
				id: number;
				name: string;
				default?: boolean;
				visibility?: string;
				allows_public_repositories?: boolean;
			}[];
		}>(
			"GET",
			`/orgs/${encodeURIComponent(target.owner)}/actions/runner-groups?per_page=100`,
		);
		return data.runner_groups.map((group) => ({
			id: group.id,
			name: group.name,
			default: Boolean(group.default),
			visibility:
				group.visibility === "selected" || group.visibility === "private"
					? group.visibility
					: "all",
			allowsPublicRepositories: Boolean(group.allows_public_repositories),
		}));
	};

	const runnerGroupId = async () => {
		if (groupId !== null) return groupId;
		const groups = await runnerGroups();
		const group = findRunnerGroup(groups, target.runnerGroup);
		if (!group) {
			throw new GithubRunnerApiError(
				`Runner group "${target.runnerGroup}" not found in ${target.owner}. Available: ${groups.map((item) => item.name).join(", ")}`,
				404,
			);
		}
		groupId = group.id;
		return groupId;
	};

	const generateJitConfig: GithubRunnerClient["generateJitConfig"] = async ({
		name,
		labels,
	}) => {
		const data = await json<{
			runner: { id: number };
			encoded_jit_config: string;
		}>("POST", `${runnersPath(target)}/generate-jitconfig`, {
			name,
			runner_group_id: await runnerGroupId(),
			labels,
			work_folder: "_work",
		});
		return {
			runnerId: data.runner.id,
			encodedJitConfig: data.encoded_jit_config,
		};
	};

	const deleteRunner: GithubRunnerClient["deleteRunner"] = async (runnerId) => {
		const path = `${runnersPath(target)}/${runnerId}`;
		const response = await request("DELETE", path);
		if (response.status === 204) return "deleted";
		if (response.status === 404) return "missing";
		// GitHub refuses to remove a runner while it runs a job.
		if (response.status === 422) return "busy";
		throw new GithubRunnerApiError(
			describeFailure(response.status, response.text, path),
			response.status,
		);
	};

	// Job data comes from the machines, where jobs run: never act outside the pool.
	const runOf = (repository: string, runId: string) => {
		const [owner, name, extra] = repository.split("/");
		const valid =
			owner &&
			name &&
			extra === undefined &&
			/^\d+$/.test(runId) &&
			/^[A-Za-z0-9._-]+$/.test(owner) &&
			/^[A-Za-z0-9._-]+$/.test(name) &&
			owner.toLowerCase() === target.owner.toLowerCase() &&
			(target.scope === "organization" ||
				name.toLowerCase() === (target.repository ?? "").toLowerCase());
		if (!valid) {
			throw new GithubRunnerApiError(
				`Run ${runId} of ${repository} is outside this pool`,
				null,
			);
		}
		return {
			owner,
			repo: name,
			runId: Number(runId),
			path: `/repos/${owner}/${name}/actions/runs/${runId}`,
		};
	};
	const runPath = (repository: string, runId: string) =>
		runOf(repository, runId).path;

	const getRun: GithubRunnerClient["getRun"] = async (repository, runId) => {
		const run = await json<{
			status: string;
			conclusion: string | null;
			run_attempt: number;
		}>("GET", runPath(repository, runId));
		return {
			status: run.status,
			conclusion: run.conclusion,
			runAttempt: run.run_attempt,
		};
	};

	const listRunJobs: GithubRunnerClient["listRunJobs"] = async (
		repository,
		runId,
	) => {
		const run = runOf(repository, runId);
		let pages = 0;
		const jobs = await octokit
			.paginate(
				octokit.rest.actions.listJobsForWorkflowRun,
				{ owner: run.owner, repo: run.repo, run_id: run.runId, per_page: 100 },
				(response, done) => {
					if (++pages >= 10) done();
					return response.data;
				},
			)
			.catch((error: unknown) => {
				throw apiError(error, `${run.path}/jobs`);
			});
		return jobs.map((job) => ({
			name: job.name,
			status: job.status,
			conclusion: job.conclusion,
			runnerName: job.runner_name,
			labels: job.labels ?? [],
			createdAt: job.created_at ?? null,
		}));
	};

	const post = async (path: string) => {
		const response = await request("POST", path);
		if (response.status < 200 || response.status >= 300) {
			throw new GithubRunnerApiError(
				describeFailure(response.status, response.text, path),
				response.status,
			);
		}
	};

	const owner = encodeURIComponent(target.owner);
	const variablesPath =
		target.scope === "organization"
			? `/orgs/${owner}/actions/variables`
			: `/repos/${owner}/${encodeURIComponent(target.repository ?? "")}/actions/variables`;

	const setVariable: GithubRunnerClient["setVariable"] = async (
		name,
		value,
	) => {
		const body =
			target.scope === "organization"
				? { name, value, visibility: "private" }
				: { name, value };
		const updated = await request(
			"PATCH",
			`${variablesPath}/${encodeURIComponent(name)}`,
			body,
		);
		if (updated.status === 204) return;
		if (updated.status !== 404) {
			throw new GithubRunnerApiError(
				describeVariableFailure(updated.status, updated.text, target),
				updated.status,
			);
		}
		const created = await request("POST", variablesPath, body);
		if (created.status !== 201) {
			throw new GithubRunnerApiError(
				describeVariableFailure(created.status, created.text, target),
				created.status,
			);
		}
	};

	const deleteVariable: GithubRunnerClient["deleteVariable"] = async (name) => {
		const response = await request(
			"DELETE",
			`${variablesPath}/${encodeURIComponent(name)}`,
		);
		if (response.status !== 204 && response.status !== 404) {
			throw new GithubRunnerApiError(
				describeVariableFailure(response.status, response.text, target),
				response.status,
			);
		}
	};

	const listRepositories: GithubRunnerClient["listRepositories"] = async () => {
		if (target.scope === "repository") {
			return [`${target.owner}/${target.repository}`];
		}
		let pages = 0;
		const repositories = await octokit
			.paginate(
				octokit.rest.repos.listForOrg,
				{ org: target.owner, type: "private", per_page: 100 },
				(response, done) => {
					if (++pages >= 20) done();
					return response.data;
				},
			)
			.catch((error: unknown) => {
				throw apiError(error, `/orgs/${owner}/repos`);
			});
		return repositories
			.filter((repo) => repo.private && !repo.archived)
			.map((repo) => repo.full_name);
	};

	const listQueuedRuns: GithubRunnerClient["listQueuedRuns"] = async (
		repository,
	) => {
		const [repoOwner, name] = repository.split("/");
		if (
			repoOwner?.toLowerCase() !== target.owner.toLowerCase() ||
			!name ||
			!/^[A-Za-z0-9._-]+$/.test(name)
		) {
			throw new GithubRunnerApiError(
				`${repository} is outside this pool`,
				null,
			);
		}
		const data = await json<{
			workflow_runs: {
				id: number;
				run_attempt: number;
				name: string | null;
				created_at: string;
			}[];
		}>(
			"GET",
			`/repos/${owner}/${encodeURIComponent(name)}/actions/runs?status=queued&per_page=50`,
			undefined,
			{ etag: true },
		);
		return data.workflow_runs.map((run) => ({
			id: run.id,
			runAttempt: run.run_attempt,
			workflow: run.name ?? "workflow",
			createdAt: run.created_at,
		}));
	};

	return {
		target,
		authorization,
		getRun,
		listRunJobs,
		cancelRun: async (repository, runId) =>
			post(`${runPath(repository, runId)}/cancel`),
		listRepositories,
		listQueuedRuns,
		setVariable,
		deleteVariable,
		canManageVariables: async () => {
			const response = await request("GET", `${variablesPath}?per_page=1`);
			return response.status === 200;
		},
		forceCancelRun: async (repository, runId) =>
			post(`${runPath(repository, runId)}/force-cancel`),
		rerunFailedJobs: async (repository, runId) =>
			post(`${runPath(repository, runId)}/rerun-failed-jobs`),
		listRunners,
		runnerGroups,
		runnerGroupId,
		generateJitConfig,
		deleteRunner,
	};
};

const JIT_FILES = new Set([
	".runner",
	".credentials",
	".credentials_rsaparams",
]);

/**
 * A JIT config is the base64 JSON of the files the runner would write itself
 * with `--jitconfig`. Writing them directly keeps the runner credentials out of
 * the process arguments, which every local user can read.
 */
export const decodeJitConfig = (encoded: string) => {
	let files: Record<string, string>;
	try {
		files = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
	} catch {
		throw new Error("GitHub returned an unreadable JIT configuration");
	}
	const entries = Object.entries(files);
	if (
		!entries.length ||
		entries.some(
			([name, value]) =>
				!JIT_FILES.has(name) ||
				typeof value !== "string" ||
				!/^[A-Za-z0-9+/=]+$/.test(value),
		) ||
		!files[".runner"] ||
		!files[".credentials"]
	) {
		throw new Error("GitHub returned an unexpected JIT configuration");
	}
	return entries.map(([name, base64]) => ({ name, base64 }));
};

export interface RunnerRelease {
	version: string;
	url: string;
	sha256: string;
}

const releaseArch = (arch: string) => {
	if (arch === "x86_64" || arch === "amd64" || arch === "x64") return "x64";
	if (arch === "aarch64" || arch === "arm64") return "arm64";
	throw new Error(`Unsupported CPU architecture for GitHub runners: ${arch}`);
};

/**
 * A release of a public repository on github.com. Authenticated when possible:
 * the anonymous quota is 60 calls per hour per IP. A token GitHub rejects
 * falls back to that quota.
 */
const readRelease = async (
	repository: { owner: string; repo: string },
	tag: string | null,
	options: { fetch?: Fetch; authorization?: string },
) => {
	const get = (authorization?: string) => {
		const octokit = githubOctokit("https://api.github.com", {
			fetch: options.fetch,
			authorization: authorization ? async () => authorization : undefined,
		});
		return tag
			? octokit.rest.repos.getReleaseByTag({ ...repository, tag })
			: octokit.rest.repos.getLatestRelease(repository);
	};
	try {
		const { data } = await get(options.authorization).catch((error) => {
			if (options.authorization && statusOf(error) === 401) return get();
			throw error;
		});
		return data;
	} catch (error) {
		const status = statusOf(error);
		throw new Error(
			`Unable to read the ${repository.owner}/${repository.repo} release ${tag ?? "latest"} (${status ?? (error instanceof Error ? error.message : String(error))})`,
		);
	}
};

/**
 * The latest actions/runner releases with their publication dates, to tell
 * whether a machine's runner is behind and until when GitHub accepts it.
 * Drafts and pre-releases are left out.
 */
export const listRunnerReleases = async (
	options: { fetch?: Fetch; authorization?: string } = {},
): Promise<RunnerReleaseInfo[]> => {
	const list = (authorization?: string) =>
		githubOctokit("https://api.github.com", {
			fetch: options.fetch,
			authorization: authorization ? async () => authorization : undefined,
		}).rest.repos.listReleases({
			owner: "actions",
			repo: "runner",
			per_page: 30,
		});
	try {
		const { data } = await list(options.authorization).catch((error) => {
			if (options.authorization && statusOf(error) === 401) return list();
			throw error;
		});
		return data
			.filter((release) => !release.draft && !release.prerelease)
			.flatMap((release) =>
				release.published_at
					? [
							{
								version: release.tag_name.replace(/^v/, ""),
								publishedAt: release.published_at,
							},
						]
					: [],
			);
	} catch (error) {
		throw apiError(error, "/repos/actions/runner/releases");
	}
};

/** The SHA-256 GitHub computed for a release asset, when it publishes one. */
const assetSha256 = (asset: {
	browser_download_url: string;
	digest?: string | null;
}) => asset.digest?.match(/^sha256:([a-f0-9]{64})$/)?.[1];

/**
 * Resolves the actions/runner release for Linux on the given architecture,
 * with the SHA-256 published by GitHub, which the machine verifies.
 */
export const resolveRunnerRelease = async (
	version: string | null,
	arch: string,
	options: { fetch?: Fetch; authorization?: string } = {},
): Promise<RunnerRelease> => {
	const release = await readRelease(
		{ owner: "actions", repo: "runner" },
		version ? `v${version}` : null,
		options,
	);
	const resolved = release.tag_name.replace(/^v/, "");
	const platform = `linux-${releaseArch(arch)}`;
	const asset = release.assets.find(
		(item) => item.name === `actions-runner-${platform}-${resolved}.tar.gz`,
	);
	if (!asset) {
		throw new Error(`actions/runner ${resolved} has no ${platform} archive`);
	}
	// Older releases only list their checksums in the notes.
	const sha256 =
		assetSha256(asset) ??
		release.body?.match(
			new RegExp(
				`<!-- BEGIN SHA ${platform} -->([a-f0-9]{64})<!-- END SHA ${platform} -->`,
			),
		)?.[1];
	if (!sha256) {
		throw new Error(
			`actions/runner ${resolved} publishes no SHA-256 for ${platform}`,
		);
	}
	return { version: resolved, url: asset.browser_download_url, sha256 };
};

/** The Lima archive for macOS on a CPU architecture, with its published SHA-256. */
export const resolveLimaRelease = async (
	version: string,
	arch: string,
	options: { fetch?: Fetch; authorization?: string } = {},
): Promise<RunnerRelease> => {
	const release = await readRelease(
		{ owner: "lima-vm", repo: "lima" },
		`v${version}`,
		options,
	);
	const platform = `Darwin-${arch === "arm64" || arch === "aarch64" ? "arm64" : "x86_64"}`;
	const asset = release.assets.find(
		(item) => item.name === `lima-${version}-${platform}.tar.gz`,
	);
	const sha256 = asset && assetSha256(asset);
	if (!asset || !sha256) {
		throw new Error(
			`Lima ${version} publishes no verified ${platform} archive`,
		);
	}
	return { version, url: asset.browser_download_url, sha256 };
};
