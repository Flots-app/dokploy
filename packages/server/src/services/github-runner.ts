import { createHash } from "node:crypto";
import { db } from "@dokploy/server/db";
import {
	type apiCompleteGithubRunnerEnrollment,
	type apiCreateGithubRunnerNode,
	type apiCreateGithubRunnerPool,
	type apiFinishGithubRunnerEnrollment,
	type apiStartGithubRunnerEnrollment,
	type apiTestGithubRunnerCredentials,
	type apiUpdateGithubRunnerNode,
	type apiUpdateGithubRunnerPool,
	firewallAttachments,
	type GithubRunnerPool,
	githubRunnerJobs,
	githubRunnerMetrics,
	githubRunnerNodes,
	githubRunnerOperations,
	githubRunnerPools,
	githubRunnerReroutes,
	sshKeys,
} from "@dokploy/server/db/schema";
import {
	effectiveBudget,
	resolveMaxRunners,
} from "@dokploy/server/utils/github-runners/budget";
import {
	checkRunnerMachine,
	clearPoolRouting,
	generateMachineKey,
	knownOsReleases,
	knownRunnerReleases,
	resumeGithubRunnerRollout,
	retryRunnerNodeNow,
} from "@dokploy/server/utils/github-runners/controller";
import {
	diskThresholds,
	vmDiskThresholds,
} from "@dokploy/server/utils/github-runners/disk";
import { envKeys } from "@dokploy/server/utils/github-runners/env";
import {
	createGithubRunnerClient,
	findAppInstallation,
	findRunnerGroup,
	tokenExpiration,
} from "@dokploy/server/utils/github-runners/github-api";
import { osStatus } from "@dokploy/server/utils/github-runners/os";
import { nextMachine } from "@dokploy/server/utils/github-runners/placement";
import { runnerNamePrefix } from "@dokploy/server/utils/github-runners/reconcile";
import { RUNTIME_VERSION } from "@dokploy/server/utils/github-runners/runtime";
import {
	MANAGER_ACCOUNT,
	machineSetupScript,
	parseSetupCode,
	publicKeyFingerprint,
	type SetupCode,
} from "@dokploy/server/utils/github-runners/setup";
import {
	describeUpdateWindow,
	effectiveUpdatePolicy,
	inUpdateWindow,
} from "@dokploy/server/utils/github-runners/updates";
import {
	latestRunnerRelease,
	machineRunnerStatus,
} from "@dokploy/server/utils/github-runners/versions";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, gte, inArray, ne } from "drizzle-orm";
import type { z } from "zod";
import { runnerNodeFirewallState } from "./firewall";

const notFound = (what: string) =>
	new TRPCError({ code: "NOT_FOUND", message: `${what} not found` });

/** Machines as sent to the browser: never their private key nor the lease. */
const publicNode = <
	T extends {
		sshPrivateKey?: unknown;
		lockedBy?: unknown;
		lockedUntil?: unknown;
	},
>(
	node: T,
) => {
	const {
		sshPrivateKey: _key,
		lockedBy: _lockedBy,
		lockedUntil: _lockedUntil,
		...rest
	} = node;
	return { ...rest, hasOwnKey: Boolean(_key) };
};

/** Pools as sent to the browser: secrets are replaced by whether they are set. */
const publicPool = (pool: GithubRunnerPool) => {
	const { token, appPrivateKey, runnerEnv, ...rest } = pool;
	return {
		...rest,
		hasToken: Boolean(token),
		hasAppPrivateKey: Boolean(appPrivateKey),
		runnerEnvKeys: envKeys(runnerEnv),
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

type PoolAccessInput = z.infer<typeof apiTestGithubRunnerCredentials>;

const GITHUB_API_URL = "https://api.github.com";

/**
 * Secrets only go to the GitHub they belong to: a Dokploy GitHub provider is a
 * github.com App, and a stored token or App key is only sent to the API URL
 * the pool was saved with. Another URL needs the secret pasted again, so
 * someone who cannot read a secret cannot have it sent to their own server.
 */
export const assertSecretsDestination = (
	input: Pick<
		PoolAccessInput,
		| "authType"
		| "apiUrl"
		| "token"
		| "appPrivateKey"
		| "scope"
		| "owner"
		| "repository"
	>,
	stored: GithubRunnerPool | null,
) => {
	if (input.authType === "provider" && input.apiUrl !== GITHUB_API_URL) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `A GitHub provider only works with ${GITHUB_API_URL}`,
		});
	}
	const reused =
		(input.authType === "token" && !input.token) ||
		(input.authType === "app" && !input.appPrivateKey);
	const sameTarget =
		stored !== null &&
		input.apiUrl === stored.apiUrl &&
		input.scope === stored.scope &&
		input.owner === stored.owner &&
		(input.scope === "organization" ||
			(input.repository ?? null) === stored.repository);
	if (reused && stored && !sameTarget) {
		const target =
			stored.scope === "organization"
				? stored.owner
				: `${stored.owner}/${stored.repository}`;
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `Paste the ${input.authType === "token" ? "token" : "App private key"} again: the stored one is only used for ${target} on ${stored.apiUrl}`,
		});
	}
};

/** Pool names are unique per organization: say so before the database does. */
const assertPoolNameFree = async (
	name: string,
	organizationId: string,
	poolId: string | null,
) => {
	const sameName = await db.query.githubRunnerPools.findFirst({
		where: and(
			eq(githubRunnerPools.organizationId, organizationId),
			eq(githubRunnerPools.name, name),
			poolId ? ne(githubRunnerPools.githubRunnerPoolId, poolId) : undefined,
		),
		columns: { githubRunnerPoolId: true },
	});
	if (sameName) {
		throw new TRPCError({
			code: "CONFLICT",
			message: `A runner pool named ${name} already exists`,
		});
	}
};

/**
 * Reaches GitHub with the pool settings: finds the App installation when it is
 * not given, lists the runner groups of an organization and the runners. A
 * missing runner group is reported, not thrown, so the form can offer the
 * existing ones.
 */
export const testGithubRunnerCredentials = async (
	input: PoolAccessInput,
	organizationId: string,
) => {
	const stored = input.githubRunnerPoolId
		? await findGithubRunnerPool(input.githubRunnerPoolId, organizationId)
		: null;
	assertSecretsDestination(input, stored);
	const secrets = credentialsOf(input, stored);
	let auth: Parameters<typeof createGithubRunnerClient>[1];
	let installationId: string | null = null;
	if (input.authType === "token") {
		if (!secrets.token) throw new Error("Paste the token created on GitHub");
		auth = { type: "token", token: secrets.token };
	} else if (input.authType === "app") {
		if (!input.appId || !secrets.appPrivateKey) {
			throw new Error("Enter the App ID and the private key of the GitHub App");
		}
		installationId =
			input.appInstallationId ??
			(await findAppInstallation(
				{ appId: input.appId, privateKey: secrets.appPrivateKey },
				input,
			));
		auth = {
			type: "app",
			appId: input.appId,
			installationId,
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
	const [groups, tokenExpiresAt, variables] = await Promise.all([
		input.scope === "organization" ? client.runnerGroups() : [],
		auth.type === "token" ? tokenExpiration(auth.token, input.apiUrl) : null,
		input.routingVariable ? client.canManageVariables() : null,
	]);
	const group =
		input.scope === "organization"
			? findRunnerGroup(groups, input.runnerGroup)
			: null;
	const runners =
		input.scope === "repository" || group ? await client.listRunners() : null;
	return {
		installationId,
		tokenExpiresAt,
		/** Whether the routing variable can be written; null without routing. */
		variablesAccess: variables,
		groups,
		group,
		runners: runners?.length ?? null,
		online:
			runners?.filter((runner) => runner.status === "online").length ?? null,
	};
};

/** Refuses settings GitHub does not accept, before they are saved. */
const verifyPoolAccess = async (
	input: PoolAccessInput,
	organizationId: string,
) => {
	const access = await testGithubRunnerCredentials(input, organizationId);
	if (input.scope === "organization" && !access.group) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `Runner group "${input.runnerGroup}" does not exist in ${input.owner}. Available: ${access.groups.map((group) => group.name).join(", ")}`,
		});
	}
	return access;
};

export const createGithubRunnerPool = async (
	input: z.infer<typeof apiCreateGithubRunnerPool>,
	organizationId: string,
) => {
	await assertPoolNameFree(input.name, organizationId, null);
	await assertRoutingVariableFree(input, organizationId, null);
	const access = await verifyPoolAccess(
		{ ...input, githubRunnerPoolId: null },
		organizationId,
	);
	const [pool] = await db
		.insert(githubRunnerPools)
		.values({
			...input,
			appInstallationId: input.appInstallationId ?? access.installationId,
			organizationId,
		})
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
	assertSecretsDestination(values, stored);
	await assertPoolNameFree(values.name, organizationId, githubRunnerPoolId);
	await assertRoutingVariableFree(values, organizationId, githubRunnerPoolId);
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
	// The App installation is looked up again: the App may have been reinstalled.
	const appInstallationId =
		values.authType === "app" && !values.appInstallationId
			? (
					await verifyPoolAccess(
						{ ...input, runnerEnv: input.runnerEnv ?? stored.runnerEnv },
						organizationId,
					)
				).installationId
			: values.appInstallationId;
	const [pool] = await db
		.update(githubRunnerPools)
		.set({
			...values,
			appInstallationId,
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
	const [pool, node] = await Promise.all([
		findGithubRunnerPool(poolId, organizationId),
		db.query.githubRunnerNodes.findFirst({
			where: eq(githubRunnerNodes.githubRunnerPoolId, poolId),
		}),
	]);
	if (node) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Remove the machines of this pool first",
		});
	}
	const warning = await clearPoolRouting(pool);
	await db
		.delete(githubRunnerPools)
		.where(eq(githubRunnerPools.githubRunnerPoolId, poolId));
	return { name: pool.name, warning };
};

/** Two pools of the same target cannot publish to the same variable. */
const assertRoutingVariableFree = async (
	pool: {
		scope: "organization" | "repository";
		owner: string;
		repository: string | null;
		routingVariable: string | null;
	},
	organizationId: string,
	poolId: string | null,
) => {
	if (!pool.routingVariable) return;
	const others = await db.query.githubRunnerPools.findMany({
		where: eq(githubRunnerPools.organizationId, organizationId),
		columns: {
			githubRunnerPoolId: true,
			name: true,
			scope: true,
			owner: true,
			repository: true,
			routingVariable: true,
		},
	});
	const clash = others.find(
		(other) =>
			other.githubRunnerPoolId !== poolId &&
			other.routingVariable?.toLowerCase() ===
				pool.routingVariable?.toLowerCase() &&
			other.owner.toLowerCase() === pool.owner.toLowerCase() &&
			(other.scope === "organization" ||
				pool.scope === "organization" ||
				other.repository?.toLowerCase() === pool.repository?.toLowerCase()),
	);
	if (clash) {
		throw new TRPCError({
			code: "CONFLICT",
			message: `Pool ${clash.name} already publishes ${pool.routingVariable} for ${pool.owner}: pick another variable name`,
		});
	}
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
	return publicNode(node);
};

const assertNameFree = async (name: string, organizationId: string) => {
	const sameName = await db.query.githubRunnerNodes.findFirst({
		where: and(
			eq(githubRunnerNodes.organizationId, organizationId),
			eq(githubRunnerNodes.name, name),
		),
		columns: { githubRunnerNodeId: true },
	});
	if (sameName) {
		throw new TRPCError({
			code: "CONFLICT",
			message: `A runner machine named ${name} already exists`,
		});
	}
};

/** The setup script of an enrolling machine, with what the dialog shows of it. */
export const githubRunnerSetupScript = (node: {
	name: string;
	platform: "linux" | "macos";
	sshPublicKey: string | null;
	keepAwake: boolean;
}) => {
	if (!node.sshPublicKey) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `${node.name} has no key of its own`,
		});
	}
	const script = machineSetupScript({
		platform: node.platform,
		machine: node.name,
		publicKey: node.sshPublicKey,
		keepAwake: node.keepAwake,
	});
	return {
		fileName: `dokploy-runner-setup-${node.name}.sh`,
		script,
		sha256: createHash("sha256").update(script).digest("hex"),
		keyFingerprint: publicKeyFingerprint(node.sshPublicKey),
	};
};

/**
 * First step of the setup of a machine: its own key, and the script an
 * administrator runs on it. The machine waits in the "enrolling" phase.
 */
export const startGithubRunnerEnrollment = async (
	input: z.infer<typeof apiStartGithubRunnerEnrollment>,
	organizationId: string,
) => {
	await findGithubRunnerPool(input.githubRunnerPoolId, organizationId);
	await assertNameFree(input.name, organizationId);
	const keys = generateMachineKey(input.name);
	const [node] = await db
		.insert(githubRunnerNodes)
		.values({
			...input,
			organizationId,
			host: "",
			port: 22,
			username: MANAGER_ACCOUNT,
			phase: "enrolling",
			sshPrivateKey: keys.privateKey,
			sshPublicKey: keys.publicKey,
		})
		.returning();
	if (!node) throw new Error("Unable to create the machine");
	return { node: publicNode(node), ...githubRunnerSetupScript(node) };
};

/**
 * Second step: the code the script printed. The connection only goes ahead
 * when the machine presents one of the host keys the code lists, and the code
 * must come from this machine's own script.
 */
export const completeGithubRunnerEnrollment = async (
	input: z.infer<typeof apiCompleteGithubRunnerEnrollment>,
	organizationId: string,
) => {
	const node = await findGithubRunnerNode(
		input.githubRunnerNodeId,
		organizationId,
	);
	if (node.phase !== "enrolling" || !node.sshPrivateKey || !node.sshPublicKey) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `${node.name} is not waiting for a setup code`,
		});
	}
	let setup: SetupCode;
	try {
		setup = parseSetupCode(input.code);
	} catch (error) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: error instanceof Error ? error.message : "Invalid setup code",
		});
	}
	const refuse = (message: string) => {
		throw new TRPCError({ code: "BAD_REQUEST", message });
	};
	if (setup.machine !== node.name) {
		refuse(
			`This code comes from the setup script of ${setup.machine}, not ${node.name}`,
		);
	}
	if (setup.platform !== node.platform) {
		refuse(
			`This code comes from a ${setup.platform === "macos" ? "Mac" : "Linux"} script`,
		);
	}
	if (setup.key !== publicKeyFingerprint(node.sshPublicKey)) {
		refuse(
			`This code was printed by an older setup script of ${node.name}: download the current one and run it again`,
		);
	}
	const result = await checkRunnerMachine({
		name: node.name,
		host: input.host,
		port: input.port,
		username: setup.user,
		privateKey: node.sshPrivateKey,
		hostKeyFingerprint: null,
		knownHostKeys: setup.hostKeys,
		platform: node.platform,
		vmName: node.vmName,
		vmDiskGb: node.vmDiskGb,
		diskReserveGb: node.diskReserveGb,
		diskCleanupGb: node.diskCleanupGb,
		cpuPercent: node.cpuPercent,
		memoryPercent: node.memoryPercent,
		maxRunners: node.maxRunners,
	});
	// The key it presented is one the script listed, checked before logging in.
	await db
		.update(githubRunnerNodes)
		.set({
			host: input.host,
			port: input.port,
			username: setup.user,
			hostKeyFingerprint: result.fingerprint,
			setup: {
				at: new Date().toISOString(),
				os: setup.os,
				arch: setup.arch,
				hosts: setup.hosts,
				hostKeys: setup.hostKeys,
				fileVault: setup.fileVault,
				keepAwake: setup.keepAwake,
			},
		})
		.where(eq(githubRunnerNodes.githubRunnerNodeId, node.githubRunnerNodeId));
	return result;
};

/** Last step: the budget, then provisioning starts. */
export const finishGithubRunnerEnrollment = async (
	input: z.infer<typeof apiFinishGithubRunnerEnrollment>,
	organizationId: string,
) => {
	const node = await findGithubRunnerNode(
		input.githubRunnerNodeId,
		organizationId,
	);
	if (node.phase !== "enrolling" || !node.hostKeyFingerprint || !node.host) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `Paste the setup code of ${node.name} first`,
		});
	}
	const { githubRunnerNodeId, ...budget } = input;
	const [updated] = await db
		.update(githubRunnerNodes)
		.set({ ...budget, phase: "new" })
		.where(eq(githubRunnerNodes.githubRunnerNodeId, githubRunnerNodeId))
		.returning();
	if (!updated) throw notFound("Runner machine");
	return publicNode(updated);
};

/** "Update now": the next tick updates the runtime and the runner, whatever the policy. */
export const requestGithubRunnerNodeUpdate = async (
	nodeId: string,
	organizationId: string,
) => {
	const node = await findGithubRunnerNode(nodeId, organizationId);
	if (node.phase !== "ready" && node.phase !== "draining") {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `${node.name} must be ready to be updated`,
		});
	}
	await db
		.update(githubRunnerNodes)
		.set({
			updateState: {
				...node.updateState,
				requestedAt: new Date().toISOString(),
			},
		})
		.where(eq(githubRunnerNodes.githubRunnerNodeId, nodeId));
	retryRunnerNodeNow(nodeId);
	return node;
};

/** Resumes a rollout its canary paused: the next machine to update leads it again. */
export const resumeGithubRunnerPoolRollout = async (
	poolId: string,
	kind: "runner" | "runtime",
	organizationId: string,
) => {
	const pool = await findGithubRunnerPool(poolId, organizationId);
	await resumeGithubRunnerRollout(pool.githubRunnerPoolId, kind);
	return pool;
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
	return publicNode(node);
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
	retryRunnerNodeNow(nodeId);
};

/** Everything the runners page shows, refreshed every few seconds. */
export const getGithubRunnerOverview = async (organizationId: string) => {
	const pools = await db.query.githubRunnerPools.findMany({
		where: eq(githubRunnerPools.organizationId, organizationId),
		orderBy: asc(githubRunnerPools.name),
	});
	const poolIds = pools.map((pool) => pool.githubRunnerPoolId);
	const [nodes, operations, reroutes, attachments] = await Promise.all([
		db.query.githubRunnerNodes.findMany({
			where: eq(githubRunnerNodes.organizationId, organizationId),
			orderBy: asc(githubRunnerNodes.name),
			with: { sshKey: { columns: { name: true } } },
		}),
		// Polled every few seconds: the logs are read one operation at a time.
		db.query.githubRunnerOperations.findMany({
			where: and(
				eq(githubRunnerOperations.organizationId, organizationId),
				eq(githubRunnerOperations.status, "running"),
			),
			columns: { logs: false },
		}),
		poolIds.length
			? db.query.githubRunnerReroutes.findMany({
					where: and(
						inArray(githubRunnerReroutes.githubRunnerPoolId, poolIds),
						gte(
							githubRunnerReroutes.createdAt,
							new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString(),
						),
					),
					orderBy: desc(githubRunnerReroutes.createdAt),
				})
			: [],
		db.query.firewallAttachments.findMany({
			where: eq(firewallAttachments.organizationId, organizationId),
			with: {
				firewall: { columns: { firewallId: true, name: true, revision: true } },
			},
		}),
	]);
	const poolFirewall = (poolId: string) =>
		attachments.find((row) => row.githubRunnerPoolId === poolId)?.firewall ??
		null;
	const nodeFirewall = (nodeId: string) =>
		attachments.find((row) => row.githubRunnerNodeId === nodeId)?.firewall ??
		null;
	const releases = knownRunnerReleases(pools);
	const now = Date.now();
	return pools.map((pool) => {
		const poolNodes = nodes
			.filter((node) => node.githubRunnerPoolId === pool.githubRunnerPoolId)
			.map((row) => {
				const node = publicNode(row);
				const host = node.observed?.host ?? null;
				const policy = effectiveUpdatePolicy(pool, node);
				const windowOpen = inUpdateWindow(policy.window, new Date(now));
				const ownFirewall = nodeFirewall(node.githubRunnerNodeId);
				const firewall = ownFirewall ?? poolFirewall(pool.githubRunnerPoolId);
				return {
					...node,
					/** The firewall of its jobs (Firewalls service) and where it stands. */
					firewallStatus: firewall
						? {
								firewallId: firewall.firewallId,
								name: firewall.name,
								inherited: !ownFirewall,
								...runnerNodeFirewallState(firewall, node),
							}
						: null,
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
					/** The update policy it follows, its own or its pool's. */
					updates: {
						inherited: node.updatePolicy === null,
						auto: policy.auto,
						window: policy.window,
						description: describeUpdateWindow(policy.window),
						open: windowOpen,
						requestedAt: node.updateState?.requestedAt ?? null,
						error: node.updateState?.error ?? null,
						inProgress: node.updateState?.inProgress ?? null,
						/** OS updates installed in the window (Linux, the VM of a Mac). */
						osPatches: policy.osPatches === true,
						patchedAt: node.updateState?.patchedAt ?? null,
						patchError: node.updateState?.patchError ?? null,
					},
					/** Whether the actions/runner release it runs is still accepted. */
					runnerUpdate: machineRunnerStatus(pool, node, releases, now),
					/** The OS of the machine, and of its VM on a Mac. */
					os: {
						checkedAt: node.osReport?.at ?? null,
						error: node.osReport?.error ?? null,
						host: osStatus({
							info: node.osReport?.host ?? null,
							releases: knownOsReleases(node.osReport?.host?.id ?? ""),
							now,
						}),
						guest:
							node.platform === "macos"
								? osStatus({
										info: node.osReport?.guest ?? null,
										releases: knownOsReleases(node.osReport?.guest?.id ?? ""),
										now,
									})
								: null,
					},
					/** Dokploy's runtime on the machine is older than this Dokploy's. */
					runtimeUpdatePending:
						(node.observed?.runtime?.version ?? RUNTIME_VERSION) <
						RUNTIME_VERSION,
				};
			});
		return {
			...publicPool(pool),
			firewall: poolFirewall(pool.githubRunnerPoolId),
			/** Latest actions/runner release, once the controller listed them. */
			latestRunnerVersion: latestRunnerRelease(releases)?.version ?? null,
			/** Runs sent to the fallback in the last week, latest first. */
			reroutes: reroutes
				.filter((row) => row.githubRunnerPoolId === pool.githubRunnerPoolId)
				.slice(0, 10),
			/** Machine the next job lands on with fastest-first placement. */
			nextNodeId:
				pool.placement === "fastest"
					? nextMachine(
							poolNodes.map((node) => ({
								id: node.githubRunnerNodeId,
								accepting:
									node.enabled &&
									node.phase === "ready" &&
									!node.drain &&
									node.observed?.reachable !== false &&
									node.observed?.admission?.ok !== false,
								maxRunners: node.resolvedMaxRunners,
								busy: (node.observed?.slots ?? []).filter(
									(slot) => slot.state === "busy",
								).length,
								speed: node.benchmark
									? {
											single: node.benchmark.single,
											multi: node.benchmark.multi,
										}
									: null,
								cpus: node.budget?.cpus ?? 1,
							})),
						)
					: null,
			nodes: poolNodes,
		};
	});
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
		// The dialog reads the log of the operation it shows with `operation`.
		columns: { logs: false },
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
