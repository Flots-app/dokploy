import { db } from "@dokploy/server/db";
import {
	type apiCreateGithubRunnerNode,
	type apiCreateGithubRunnerPool,
	type apiTestGithubRunnerCredentials,
	type apiUpdateGithubRunnerNode,
	type apiUpdateGithubRunnerPool,
	type GithubRunnerPool,
	githubRunnerJobs,
	githubRunnerMetrics,
	githubRunnerNodes,
	githubRunnerOperations,
	githubRunnerPools,
	sshKeys,
} from "@dokploy/server/db/schema";
import {
	effectiveBudget,
	resolveMaxRunners,
} from "@dokploy/server/utils/github-runners/budget";
import { checkRunnerMachine } from "@dokploy/server/utils/github-runners/controller";
import {
	diskThresholds,
	vmDiskThresholds,
} from "@dokploy/server/utils/github-runners/disk";
import { createGithubRunnerClient } from "@dokploy/server/utils/github-runners/github-api";
import { runnerNamePrefix } from "@dokploy/server/utils/github-runners/reconcile";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, gte } from "drizzle-orm";
import type { z } from "zod";

const notFound = (what: string) =>
	new TRPCError({ code: "NOT_FOUND", message: `${what} not found` });

/** Pools as sent to the browser: secrets are replaced by whether they are set. */
const publicPool = (pool: GithubRunnerPool) => {
	const { token, appPrivateKey, runnerEnv, ...rest } = pool;
	return {
		...rest,
		hasToken: Boolean(token),
		hasAppPrivateKey: Boolean(appPrivateKey),
		runnerEnvKeys: runnerEnv
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line && !line.startsWith("#"))
			.map((line) => line.split("=")[0]),
	};
};

export const findGithubRunnerPool = async (
	poolId: string,
	organizationId: string,
) => {
	const pool = await db.query.githubRunnerPools.findFirst({
		where: and(
			eq(githubRunnerPools.githubRunnerPoolId, poolId),
			eq(githubRunnerPools.organizationId, organizationId),
		),
	});
	if (!pool) throw notFound("Runner pool");
	return pool;
};

export const findGithubRunnerNode = async (
	nodeId: string,
	organizationId: string,
) => {
	const node = await db.query.githubRunnerNodes.findFirst({
		where: and(
			eq(githubRunnerNodes.githubRunnerNodeId, nodeId),
			eq(githubRunnerNodes.organizationId, organizationId),
		),
	});
	if (!node) throw notFound("Runner machine");
	return node;
};

const credentialsOf = (
	input: z.infer<typeof apiTestGithubRunnerCredentials>,
	stored: GithubRunnerPool | null,
) => ({
	token: input.token ?? stored?.token ?? null,
	appPrivateKey: input.appPrivateKey ?? stored?.appPrivateKey ?? null,
});

export const testGithubRunnerCredentials = async (
	input: z.infer<typeof apiTestGithubRunnerCredentials>,
	organizationId: string,
) => {
	const stored = input.githubRunnerPoolId
		? await findGithubRunnerPool(input.githubRunnerPoolId, organizationId)
		: null;
	const secrets = credentialsOf(input, stored);
	let auth: Parameters<typeof createGithubRunnerClient>[1];
	if (input.authType === "token") {
		if (!secrets.token) throw new Error("Enter a token");
		auth = { type: "token", token: secrets.token };
	} else if (input.authType === "app") {
		if (!input.appId || !input.appInstallationId || !secrets.appPrivateKey) {
			throw new Error(
				"Enter the App ID, the installation ID and the private key",
			);
		}
		auth = {
			type: "app",
			appId: input.appId,
			installationId: input.appInstallationId,
			privateKey: secrets.appPrivateKey,
		};
	} else {
		const provider = input.githubId
			? await db.query.github.findFirst({
					where: (table, { eq }) => eq(table.githubId, input.githubId ?? ""),
					with: { gitProvider: true },
				})
			: null;
		if (
			!provider?.githubAppId ||
			!provider.githubInstallationId ||
			!provider.githubPrivateKey ||
			provider.gitProvider.organizationId !== organizationId
		) {
			throw new Error("Select an installed GitHub provider");
		}
		auth = {
			type: "app",
			appId: provider.githubAppId,
			installationId: provider.githubInstallationId,
			privateKey: provider.githubPrivateKey,
		};
	}
	const client = createGithubRunnerClient(
		{
			scope: input.scope,
			owner: input.owner,
			repository: input.repository,
			runnerGroup: input.runnerGroup,
			apiUrl: input.apiUrl,
		},
		auth,
	);
	const [runners, groupId] = await Promise.all([
		client.listRunners(),
		client.runnerGroupId(),
	]);
	return {
		runners: runners.length,
		online: runners.filter((runner) => runner.status === "online").length,
		groupId,
	};
};

export const createGithubRunnerPool = async (
	input: z.infer<typeof apiCreateGithubRunnerPool>,
	organizationId: string,
) => {
	const [pool] = await db
		.insert(githubRunnerPools)
		.values({ ...input, organizationId })
		.returning();
	if (!pool) throw new Error("Unable to create the pool");
	return publicPool(pool);
};

export const updateGithubRunnerPool = async (
	input: z.infer<typeof apiUpdateGithubRunnerPool>,
	organizationId: string,
) => {
	const stored = await findGithubRunnerPool(
		input.githubRunnerPoolId,
		organizationId,
	);
	const { githubRunnerPoolId, ...values } = input;
	const nodes = await db.query.githubRunnerNodes.findMany({
		where: eq(githubRunnerNodes.githubRunnerPoolId, githubRunnerPoolId),
		columns: { githubRunnerNodeId: true },
	});
	if (
		nodes.length &&
		(values.scope !== stored.scope ||
			values.owner !== stored.owner ||
			values.repository !== stored.repository ||
			values.apiUrl !== stored.apiUrl)
	) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				"The GitHub target of a pool with machines cannot change: remove its machines first",
		});
	}
	const [pool] = await db
		.update(githubRunnerPools)
		.set({
			...values,
			// Empty secrets keep the stored ones.
			token: values.token ?? stored.token,
			appPrivateKey: values.appPrivateKey ?? stored.appPrivateKey,
			runnerEnv: values.runnerEnv ?? stored.runnerEnv,
		})
		.where(eq(githubRunnerPools.githubRunnerPoolId, githubRunnerPoolId))
		.returning();
	if (!pool) throw notFound("Runner pool");
	return publicPool(pool);
};

export const removeGithubRunnerPool = async (
	poolId: string,
	organizationId: string,
) => {
	await findGithubRunnerPool(poolId, organizationId);
	const node = await db.query.githubRunnerNodes.findFirst({
		where: eq(githubRunnerNodes.githubRunnerPoolId, poolId),
	});
	if (node) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Remove the machines of this pool first",
		});
	}
	await db
		.delete(githubRunnerPools)
		.where(eq(githubRunnerPools.githubRunnerPoolId, poolId));
};

const findSshKey = async (sshKeyId: string, organizationId: string) => {
	const key = await db.query.sshKeys.findFirst({
		where: and(
			eq(sshKeys.sshKeyId, sshKeyId),
			eq(sshKeys.organizationId, organizationId),
		),
	});
	if (!key?.privateKey) throw notFound("SSH key");
	return key;
};

export const checkGithubRunnerMachine = async (
	input: {
		host: string;
		port: number;
		username: string;
		sshKeyId: string;
		platform: "linux" | "macos";
		vmName: string;
		githubRunnerNodeId: string | null;
		budget: {
			cpuPercent: number;
			memoryPercent: number;
			diskReserveGb: number;
			diskCleanupGb: number;
			maxRunners: number;
			vmDiskGb: number;
		};
	},
	organizationId: string,
) => {
	const key = await findSshKey(input.sshKeyId, organizationId);
	const existing = input.githubRunnerNodeId
		? await findGithubRunnerNode(input.githubRunnerNodeId, organizationId)
		: null;
	return checkRunnerMachine({
		name: existing?.name ?? input.host,
		host: input.host,
		port: input.port,
		username: input.username,
		privateKey: key.privateKey,
		hostKeyFingerprint: existing?.hostKeyFingerprint ?? null,
		platform: input.platform,
		vmName: input.vmName,
		...input.budget,
	});
};

export const createGithubRunnerNode = async (
	input: z.infer<typeof apiCreateGithubRunnerNode>,
	organizationId: string,
) => {
	await findGithubRunnerPool(input.githubRunnerPoolId, organizationId);
	await findSshKey(input.sshKeyId, organizationId);
	const sameName = await db.query.githubRunnerNodes.findFirst({
		where: and(
			eq(githubRunnerNodes.organizationId, organizationId),
			eq(githubRunnerNodes.name, input.name),
		),
	});
	if (sameName) {
		throw new TRPCError({
			code: "CONFLICT",
			message: `A runner machine named ${input.name} already exists`,
		});
	}
	const [node] = await db
		.insert(githubRunnerNodes)
		.values({ ...input, organizationId })
		.returning();
	if (!node) throw new Error("Unable to create the machine");
	return node;
};

export const updateGithubRunnerNode = async (
	input: z.infer<typeof apiUpdateGithubRunnerNode>,
	organizationId: string,
) => {
	await findGithubRunnerNode(input.githubRunnerNodeId, organizationId);
	const { githubRunnerNodeId, mode: _mode, ...values } = input;
	const [node] = await db
		.update(githubRunnerNodes)
		.set(values)
		.where(eq(githubRunnerNodes.githubRunnerNodeId, githubRunnerNodeId))
		.returning();
	if (!node) throw notFound("Runner machine");
	return node;
};

export const resetGithubRunnerHostKey = async (
	nodeId: string,
	fingerprint: string,
	organizationId: string,
) => {
	await findGithubRunnerNode(nodeId, organizationId);
	await db
		.update(githubRunnerNodes)
		.set({ hostKeyFingerprint: fingerprint })
		.where(eq(githubRunnerNodes.githubRunnerNodeId, nodeId));
};

/** Everything the runners page shows, refreshed every few seconds. */
export const getGithubRunnerOverview = async (organizationId: string) => {
	const [pools, nodes, operations] = await Promise.all([
		db.query.githubRunnerPools.findMany({
			where: eq(githubRunnerPools.organizationId, organizationId),
			orderBy: asc(githubRunnerPools.name),
		}),
		db.query.githubRunnerNodes.findMany({
			where: eq(githubRunnerNodes.organizationId, organizationId),
			orderBy: asc(githubRunnerNodes.name),
			with: { sshKey: { columns: { name: true } } },
		}),
		db.query.githubRunnerOperations.findMany({
			where: and(
				eq(githubRunnerOperations.organizationId, organizationId),
				eq(githubRunnerOperations.status, "running"),
			),
		}),
	]);
	return pools.map((pool) => ({
		...publicPool(pool),
		nodes: nodes
			.filter((node) => node.githubRunnerPoolId === pool.githubRunnerPoolId)
			.map(({ lockedBy: _lockedBy, lockedUntil: _lockedUntil, ...node }) => {
				const host = node.observed?.host ?? null;
				return {
					...node,
					sshKeyName: node.sshKey?.name ?? null,
					runnerNamePrefix: runnerNamePrefix(node.name),
					resolvedMaxRunners: resolveMaxRunners(
						node.maxRunners,
						node.platform,
						host,
						node,
					),
					budget: host ? effectiveBudget(node.platform, host, node) : null,
					// Where caches are trimmed and jobs stop, for the disks shown.
					diskThresholds: {
						host: host?.diskTotalBytes
							? diskThresholds(host.diskTotalBytes, node)
							: null,
						vm: node.observed?.sandbox?.diskTotalBytes
							? vmDiskThresholds(node.observed.sandbox.diskTotalBytes)
							: null,
					},
					operation:
						operations.find(
							(operation) =>
								operation.githubRunnerNodeId === node.githubRunnerNodeId,
						) ?? null,
				};
			}),
	}));
};

export const listGithubRunnerOperations = async (
	nodeId: string,
	organizationId: string,
	limit: number,
) =>
	db.query.githubRunnerOperations.findMany({
		where: and(
			eq(githubRunnerOperations.githubRunnerNodeId, nodeId),
			eq(githubRunnerOperations.organizationId, organizationId),
		),
		orderBy: desc(githubRunnerOperations.createdAt),
		limit,
		with: { user: { columns: { email: true } } },
	});

export const findGithubRunnerOperation = async (
	operationId: string,
	organizationId: string,
) => {
	const operation = await db.query.githubRunnerOperations.findFirst({
		where: and(
			eq(githubRunnerOperations.githubRunnerOperationId, operationId),
			eq(githubRunnerOperations.organizationId, organizationId),
		),
	});
	if (!operation) throw notFound("Operation");
	return operation;
};

export const listGithubRunnerJobs = async (
	input: {
		githubRunnerPoolId: string;
		githubRunnerNodeId: string | null;
		limit: number;
	},
	organizationId: string,
) => {
	await findGithubRunnerPool(input.githubRunnerPoolId, organizationId);
	return db.query.githubRunnerJobs.findMany({
		where: and(
			eq(githubRunnerJobs.githubRunnerPoolId, input.githubRunnerPoolId),
			...(input.githubRunnerNodeId
				? [eq(githubRunnerJobs.githubRunnerNodeId, input.githubRunnerNodeId)]
				: []),
		),
		orderBy: desc(githubRunnerJobs.startedAt),
		limit: input.limit,
	});
};

/** Usage samples of a machine, averaged into at most ~180 points for the charts. */
export const getGithubRunnerMetrics = async (
	nodeId: string,
	hours: number,
	organizationId: string,
) => {
	await findGithubRunnerNode(nodeId, organizationId);
	const since = new Date(Date.now() - hours * 60 * 60_000).toISOString();
	const rows = await db.query.githubRunnerMetrics.findMany({
		where: and(
			eq(githubRunnerMetrics.githubRunnerNodeId, nodeId),
			gte(githubRunnerMetrics.at, since),
		),
		orderBy: asc(githubRunnerMetrics.at),
	});
	const bucketMs = Math.max(30_000, Math.ceil((hours * 60 * 60_000) / 180));
	const buckets = new Map<number, typeof rows>();
	for (const row of rows) {
		const bucket = Math.floor(Date.parse(row.at) / bucketMs) * bucketMs;
		const list = buckets.get(bucket) ?? [];
		list.push(row);
		buckets.set(bucket, list);
	}
	const average = (values: (number | null)[]) => {
		const present = values.filter((value): value is number => value !== null);
		return present.length
			? present.reduce((sum, value) => sum + value, 0) / present.length
			: null;
	};
	return [...buckets.entries()].map(([bucket, list]) => ({
		at: new Date(bucket).toISOString(),
		cpuPercent: average(list.map((row) => row.cpuPercent)),
		memoryBytes: average(list.map((row) => row.memoryBytes)),
		memoryLimitBytes: average(list.map((row) => row.memoryLimitBytes)),
		hostMemoryFreePercent: average(
			list.map((row) => row.hostMemoryFreePercent),
		),
		diskFreeBytes: average(list.map((row) => row.diskFreeBytes)),
		busyRunners: Math.max(...list.map((row) => row.busyRunners)),
		runners: Math.max(...list.map((row) => row.runners)),
	}));
};

/** Job counts and durations of the last 24 hours, per machine. */
export const getGithubRunnerJobStats = async (
	poolId: string,
	organizationId: string,
) => {
	await findGithubRunnerPool(poolId, organizationId);
	const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
	const jobs = await db.query.githubRunnerJobs.findMany({
		where: and(
			eq(githubRunnerJobs.githubRunnerPoolId, poolId),
			gte(githubRunnerJobs.startedAt, since),
		),
		columns: {
			githubRunnerNodeId: true,
			outcome: true,
			durationSeconds: true,
		},
	});
	const stats = new Map<
		string,
		{
			total: number;
			completed: number;
			interrupted: number;
			running: number;
			durations: number[];
		}
	>();
	for (const job of jobs) {
		const entry = stats.get(job.githubRunnerNodeId) ?? {
			total: 0,
			completed: 0,
			interrupted: 0,
			running: 0,
			durations: [],
		};
		entry.total++;
		entry[job.outcome]++;
		if (job.durationSeconds !== null && job.outcome === "completed") {
			entry.durations.push(job.durationSeconds);
		}
		stats.set(job.githubRunnerNodeId, entry);
	}
	return [...stats.entries()].map(([nodeId, entry]) => {
		const sorted = [...entry.durations].sort((a, b) => a - b);
		return {
			githubRunnerNodeId: nodeId,
			total: entry.total,
			completed: entry.completed,
			interrupted: entry.interrupted,
			running: entry.running,
			averageSeconds: sorted.length
				? Math.round(
						sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
					)
				: null,
			p90Seconds: sorted.length
				? (sorted[
						Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))
					] ?? null)
				: null,
		};
	});
};
