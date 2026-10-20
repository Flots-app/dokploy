import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "octokit";

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

const describeFailure = (status: number, body: string, path: string) => {
	let message = body.slice(0, 300);
	try {
		message = (JSON.parse(body) as { message?: string }).message ?? message;
	} catch {
		// Not JSON: keep the raw body.
	}
	if (status === 401) {
		return "GitHub rejected the credentials (401). Check the token or the GitHub App key.";
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
	status === 403 || status === 404
		? `GitHub refused to write the routing variable (${status}). The credentials need "Variables: read and write" on the ${target.scope === "organization" ? "organization" : "repository"}.`
		: describeFailure(status, body, "actions/variables");

const createAuthorization = (auth: GithubRunnerAuth, apiUrl: string) => {
	if (auth.type === "token") {
		return async () => `Bearer ${auth.token}`;
	}
	// The installation token is cached and refreshed by auth-app.
	const appAuth = createAppAuth({
		appId: auth.appId,
		privateKey: auth.privateKey,
		installationId: auth.installationId,
		request: new Octokit({ baseUrl: apiUrl }).request,
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
	const fetcher = options.fetch ?? fetch;
	const base = target.apiUrl.replace(/\/+$/, "");
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
	const get = (path: string) =>
		fetcher(`${base}${path}`, {
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${jwt}`,
				"X-GitHub-Api-Version": "2022-11-28",
				"User-Agent": "dokploy-github-runners",
			},
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		}).catch((error: unknown) => {
			throw new GithubRunnerApiError(
				`GitHub API ${path} unreachable: ${error instanceof Error ? error.message : String(error)}`,
				null,
			);
		});
	const owner = encodeURIComponent(target.owner);
	const path =
		target.scope === "organization"
			? `/orgs/${owner}/installation`
			: `/repos/${owner}/${encodeURIComponent(target.repository ?? "")}/installation`;
	const response = await get(path);
	if (response.ok) {
		return String(((await response.json()) as { id: number }).id);
	}
	if (response.status === 401) {
		throw new GithubRunnerApiError(
			"GitHub rejected the App ID or the private key (401): check that both belong to the same GitHub App.",
			401,
		);
	}
	if (response.status === 404) {
		const where =
			target.scope === "organization"
				? target.owner
				: `${target.owner}/${target.repository}`;
		const page = await get("/app")
			.then((res) =>
				res.ok ? (res.json() as Promise<{ html_url?: string }>) : null,
			)
			.catch(() => null);
		throw new GithubRunnerApiError(
			`The GitHub App is not installed on ${where}.${page?.html_url ? ` Install it from ${page.html_url}/installations/new, then try again.` : ""}`,
			404,
		);
	}
	throw new GithubRunnerApiError(
		describeFailure(response.status, await response.text(), path),
		response.status,
	);
};

/**
 * When a token expires, from the header GitHub adds to the responses it
 * authenticates with one; null for tokens without expiry or on failure.
 */
export const tokenExpiration = async (
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
				"User-Agent": "dokploy-github-runners",
			},
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		},
	).catch(() => null);
	return (
		response?.headers.get("github-authentication-token-expiration") ?? null
	);
};

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
	const fetcher = options.fetch ?? fetch;
	const authorization = createAuthorization(auth, target.apiUrl);
	const base = target.apiUrl.replace(/\/+$/, "");
	let groupId: number | null = target.scope === "repository" ? 1 : null;

	// Conditional GETs: a 304 does not count against the GitHub rate limit, and the
	// controller polls the same runner list every few seconds.
	const etags = new Map<string, { etag: string; text: string }>();

	const request = async (method: string, path: string, body?: unknown) => {
		const cached = method === "GET" ? etags.get(path) : undefined;
		const response = await fetcher(`${base}${path}`, {
			method,
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: await authorization(),
				"X-GitHub-Api-Version": "2022-11-28",
				"User-Agent": "dokploy-github-runners",
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
			return { status: 200, text: cached.text };
		}
		const text = await response.text();
		const etag = response.headers.get("etag");
		if (method === "GET" && response.ok && etag) {
			etags.set(path, { etag, text });
		}
		return { status: response.status, text };
	};

	const json = async <T>(method: string, path: string, body?: unknown) => {
		const response = await request(method, path, body);
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
			}>("GET", `${listPath}?per_page=100&page=${page}`);
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
	const runPath = (repository: string, runId: string) => {
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
		return `/repos/${owner}/${name}/actions/runs/${runId}`;
	};

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
		const jobs: WorkflowRunJob[] = [];
		for (let page = 1; page <= 10; page++) {
			const data = await json<{
				total_count: number;
				jobs: {
					name: string;
					status: string;
					conclusion: string | null;
					runner_name: string | null;
					labels?: string[];
					created_at?: string;
				}[];
			}>("GET", `${runPath(repository, runId)}/jobs?per_page=100&page=${page}`);
			for (const job of data.jobs) {
				jobs.push({
					name: job.name,
					status: job.status,
					conclusion: job.conclusion,
					runnerName: job.runner_name,
					labels: job.labels ?? [],
					createdAt: job.created_at ?? null,
				});
			}
			if (data.jobs.length < 100 || jobs.length >= data.total_count) break;
		}
		return jobs;
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
		const names: string[] = [];
		for (let page = 1; page <= 20; page++) {
			const data = await json<
				{ full_name: string; private: boolean; archived?: boolean }[]
			>("GET", `/orgs/${owner}/repos?type=private&per_page=100&page=${page}`);
			for (const repo of data) {
				if (repo.private && !repo.archived) names.push(repo.full_name);
			}
			if (data.length < 100) break;
		}
		return names;
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
 * Resolves the actions/runner release for Linux on the given architecture,
 * with the SHA-256 published by GitHub, which the machine verifies.
 */
export const resolveRunnerRelease = async (
	version: string | null,
	arch: string,
	options: { fetch?: Fetch; authorization?: string } = {},
): Promise<RunnerRelease> => {
	const fetcher = options.fetch ?? fetch;
	const path = version
		? `/repos/actions/runner/releases/tags/v${version}`
		: "/repos/actions/runner/releases/latest";
	// Authenticated when possible: the anonymous quota is 60 calls per hour per IP.
	const get = (authorization?: string) =>
		fetcher(`https://api.github.com${path}`, {
			headers: {
				Accept: "application/vnd.github+json",
				"User-Agent": "dokploy-github-runners",
				...(authorization ? { Authorization: authorization } : {}),
			},
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	let response = await get(options.authorization);
	if (options.authorization && response.status === 401) {
		response = await get();
	}
	if (!response.ok) {
		throw new Error(
			`Unable to read the actions/runner release ${version ?? "latest"} (${response.status})`,
		);
	}
	const release = (await response.json()) as {
		tag_name: string;
		body?: string | null;
		assets: { name: string; browser_download_url: string; digest?: string }[];
	};
	const resolved = release.tag_name.replace(/^v/, "");
	const platform = `linux-${releaseArch(arch)}`;
	const asset = release.assets.find(
		(item) => item.name === `actions-runner-${platform}-${resolved}.tar.gz`,
	);
	if (!asset) {
		throw new Error(`actions/runner ${resolved} has no ${platform} archive`);
	}
	const fromDigest = asset.digest?.match(/^sha256:([a-f0-9]{64})$/)?.[1];
	const fromNotes = release.body?.match(
		new RegExp(
			`<!-- BEGIN SHA ${platform} -->([a-f0-9]{64})<!-- END SHA ${platform} -->`,
		),
	)?.[1];
	const sha256 = fromDigest ?? fromNotes;
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
	const fetcher = options.fetch ?? fetch;
	const get = (authorization?: string) =>
		fetcher(
			`https://api.github.com/repos/lima-vm/lima/releases/tags/v${version}`,
			{
				headers: {
					Accept: "application/vnd.github+json",
					"User-Agent": "dokploy-github-runners",
					...(authorization ? { Authorization: authorization } : {}),
				},
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			},
		);
	let response = await get(options.authorization);
	if (options.authorization && response.status === 401) response = await get();
	if (!response.ok) {
		throw new Error(
			`Unable to read the Lima release ${version} (${response.status})`,
		);
	}
	const release = (await response.json()) as {
		assets: { name: string; browser_download_url: string; digest?: string }[];
	};
	const platform = `Darwin-${arch === "arm64" || arch === "aarch64" ? "arm64" : "x86_64"}`;
	const asset = release.assets.find(
		(item) => item.name === `lima-${version}-${platform}.tar.gz`,
	);
	const sha256 = asset?.digest?.match(/^sha256:([a-f0-9]{64})$/)?.[1];
	if (!asset || !sha256) {
		throw new Error(
			`Lima ${version} publishes no verified ${platform} archive`,
		);
	}
	return { version, url: asset.browser_download_url, sha256 };
};
