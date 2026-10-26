import {
	applyRunnerNodeConfig,
	assertGitProviderAccess,
	checkGithubRunnerMachine,
	checkRunnerNodeOs,
	cleanRunnerCaches,
	completeGithubRunnerEnrollment,
	createGithubRunnerNode,
	createGithubRunnerPool,
	disableRunnerNode,
	enableRunnerNode,
	findGithubRunnerNode,
	findGithubRunnerOperation,
	findGithubRunnerPool,
	finishGithubRunnerEnrollment,
	getGithubRunnerJobStats,
	getGithubRunnerMetrics,
	getGithubRunnerOverview,
	githubRunnerControllerStatus,
	githubRunnerSetupScript,
	IS_CLOUD,
	listGithubRunnerJobs,
	listGithubRunnerOperations,
	provisionRunnerNode,
	readPresentedHostKey,
	refreshRunnerCaches,
	removeGithubRunnerPool,
	removeRunnerNode,
	requestGithubRunnerNodeUpdate,
	resetGithubRunnerHostKey,
	resumeGithubRunnerPoolRollout,
	rotateRunnerNodeKey,
	startGithubRunnerEnrollment,
	testGithubRunnerCredentials,
	updateGithubRunnerNode,
	updateGithubRunnerPool,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import { checkPermission } from "@dokploy/server/services/permission";
import { toClientError } from "@dokploy/server/utils/github-runners/errors";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { createTRPCRouter, withPermission } from "@/server/api/trpc";
import { audit } from "@/server/api/utils/audit";
import {
	apiCheckGithubRunnerNode,
	apiCleanGithubRunnerNode,
	apiCompleteGithubRunnerEnrollment,
	apiCreateGithubRunnerNode,
	apiCreateGithubRunnerPool,
	apiDisableGithubRunnerNode,
	apiFindGithubRunnerNode,
	apiFindGithubRunnerOperation,
	apiFindGithubRunnerPool,
	apiFinishGithubRunnerEnrollment,
	apiGithubRunnerJobs,
	apiGithubRunnerMetrics,
	apiGithubRunnerOperations,
	apiRemoveGithubRunnerNode,
	apiStartGithubRunnerEnrollment,
	apiTestGithubRunnerCredentials,
	apiUpdateGithubRunnerNode,
	apiUpdateGithubRunnerPool,
} from "@/server/db/schema";

// Self-hosted only: runner machines are reached from the Dokploy server over SSH.
const assertSelfHosted = () => {
	if (IS_CLOUD) {
		throw new TRPCError({
			code: "NOT_IMPLEMENTED",
			message: "GitHub runners are not available on Dokploy Cloud",
		});
	}
};
const read = withPermission("githubRunner", "read").use(({ next }) => {
	assertSelfHosted();
	return next();
});
const create = withPermission("githubRunner", "create").use(({ next }) => {
	assertSelfHosted();
	return next();
});
const update = withPermission("githubRunner", "update").use(({ next }) => {
	assertSelfHosted();
	return next();
});
const remove = withPermission("githubRunner", "delete").use(({ next }) => {
	assertSelfHosted();
	return next();
});

const fail = (error: unknown): never => {
	throw toClientError(error);
};

/**
 * A pool signs GitHub requests with the provider's App key: picking a provider
 * needs the same access as using it anywhere else in Dokploy. The provider a
 * pool already uses stays usable by whoever may edit the pool.
 */
const assertProvider = async (
	input: { githubId: string | null; githubRunnerPoolId?: string | null },
	session: { userId: string; activeOrganizationId: string },
) => {
	if (!input.githubId) return;
	if (input.githubRunnerPoolId) {
		const pool = await findGithubRunnerPool(
			input.githubRunnerPoolId,
			session.activeOrganizationId,
		);
		if (pool.githubId === input.githubId) return;
	}
	const provider = await db.query.github.findFirst({
		where: (table, { eq }) => eq(table.githubId, input.githubId ?? ""),
		with: { gitProvider: true },
	});
	if (!provider) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "GitHub provider not found",
		});
	}
	await assertGitProviderAccess(session, provider.gitProvider);
};

export const githubRunnerRouter = createTRPCRouter({
	overview: read.query(({ ctx }) =>
		getGithubRunnerOverview(ctx.session.activeOrganizationId),
	),

	testCredentials: create
		.input(apiTestGithubRunnerCredentials)
		.mutation(async ({ input, ctx }) => {
			// Checking an existing pool reuses its stored secrets: as for editing it.
			if (input.githubRunnerPoolId) {
				await checkPermission(ctx, { githubRunner: ["update"] });
			}
			await assertProvider(input, ctx.session);
			return testGithubRunnerCredentials(
				input,
				ctx.session.activeOrganizationId,
			).catch(fail);
		}),

	createPool: create
		.input(apiCreateGithubRunnerPool)
		.mutation(async ({ input, ctx }) => {
			await assertProvider(input, ctx.session);
			const pool = await createGithubRunnerPool(
				input,
				ctx.session.activeOrganizationId,
			).catch(fail);
			await audit(ctx, {
				action: "create",
				resourceType: "githubRunner",
				resourceId: pool.githubRunnerPoolId,
				resourceName: pool.name,
				metadata: { kind: "pool", scope: pool.scope, owner: pool.owner },
			});
			return pool;
		}),

	updatePool: update
		.input(apiUpdateGithubRunnerPool)
		.mutation(async ({ input, ctx }) => {
			await assertProvider(input, ctx.session);
			const pool = await updateGithubRunnerPool(
				input,
				ctx.session.activeOrganizationId,
			).catch(fail);
			await audit(ctx, {
				action: "update",
				resourceType: "githubRunner",
				resourceId: pool.githubRunnerPoolId,
				resourceName: pool.name,
				metadata: { kind: "pool" },
			});
			return pool;
		}),

	removePool: remove
		.input(apiFindGithubRunnerPool)
		.mutation(async ({ input, ctx }) => {
			// Checks the pool belongs to the organization before anything goes.
			const { name, warning } = await removeGithubRunnerPool(
				input.githubRunnerPoolId,
				ctx.session.activeOrganizationId,
			).catch(fail);
			await audit(ctx, {
				action: "delete",
				resourceType: "githubRunner",
				resourceId: input.githubRunnerPoolId,
				resourceName: name,
				metadata: { kind: "pool" },
			});
			return { warning };
		}),

	checkMachine: create
		.input(apiCheckGithubRunnerNode)
		.mutation(({ input, ctx }) =>
			checkGithubRunnerMachine(
				{
					...input,
					budget: {
						cpuPercent: input.cpuPercent,
						memoryPercent: input.memoryPercent,
						diskReserveGb: input.diskReserveGb,
						diskCleanupPercent: input.diskCleanupPercent,
						maxRunners: input.maxRunners,
						vmDiskGb: input.vmDiskGb,
					},
				},
				ctx.session.activeOrganizationId,
			).catch(fail),
		),

	createMachine: create
		.input(apiCreateGithubRunnerNode)
		.mutation(async ({ input, ctx }) => {
			const node = await createGithubRunnerNode(
				input,
				ctx.session.activeOrganizationId,
			).catch(fail);
			await audit(ctx, {
				action: "create",
				resourceType: "githubRunner",
				resourceId: node.githubRunnerNodeId,
				resourceName: node.name,
				metadata: {
					kind: "machine",
					host: node.host,
					platform: node.platform,
					cpuPercent: node.cpuPercent,
					memoryPercent: node.memoryPercent,
				},
			});
			await provisionRunnerNode(node.githubRunnerNodeId, ctx.user.id).catch(
				fail,
			);
			return node;
		}),

	/** Setup with a script: the machine's own key and the script to run on it. */
	startEnrollment: create
		.input(apiStartGithubRunnerEnrollment)
		.mutation(async ({ input, ctx }) => {
			const result = await startGithubRunnerEnrollment(
				input,
				ctx.session.activeOrganizationId,
			).catch(fail);
			await audit(ctx, {
				action: "create",
				resourceType: "githubRunner",
				resourceId: result.node.githubRunnerNodeId,
				resourceName: result.node.name,
				metadata: {
					kind: "machine",
					platform: result.node.platform,
					setup: "script",
					keyFingerprint: result.keyFingerprint,
				},
			});
			return result;
		}),

	// Adding a machine is one flow: whoever may start it may finish it.
	setupScript: create
		.input(apiFindGithubRunnerNode)
		.query(async ({ input, ctx }) => {
			const node = await findGithubRunnerNode(
				input.githubRunnerNodeId,
				ctx.session.activeOrganizationId,
			);
			return githubRunnerSetupScript(node);
		}),

	completeEnrollment: create
		.input(apiCompleteGithubRunnerEnrollment)
		.mutation(async ({ input, ctx }) => {
			const result = await completeGithubRunnerEnrollment(
				input,
				ctx.session.activeOrganizationId,
			).catch(fail);
			await audit(ctx, {
				action: "update",
				resourceType: "githubRunner",
				resourceId: input.githubRunnerNodeId,
				metadata: {
					kind: "machine",
					operation: "setup-code",
					host: input.host,
					hostKey: result.fingerprint,
				},
			});
			return result;
		}),

	finishEnrollment: create
		.input(apiFinishGithubRunnerEnrollment)
		.mutation(async ({ input, ctx }) => {
			const node = await finishGithubRunnerEnrollment(
				input,
				ctx.session.activeOrganizationId,
			).catch(fail);
			const operation = await provisionRunnerNode(
				node.githubRunnerNodeId,
				ctx.user.id,
			).catch(fail);
			await audit(ctx, {
				action: "update",
				resourceType: "githubRunner",
				resourceId: node.githubRunnerNodeId,
				resourceName: node.name,
				metadata: {
					kind: "machine",
					operation: "provision",
					cpuPercent: node.cpuPercent,
					memoryPercent: node.memoryPercent,
				},
			});
			return operation;
		}),

	rotateKey: update
		.input(apiFindGithubRunnerNode)
		.mutation(async ({ input, ctx }) => {
			const node = await findGithubRunnerNode(
				input.githubRunnerNodeId,
				ctx.session.activeOrganizationId,
			);
			await rotateRunnerNodeKey(node.githubRunnerNodeId).catch(fail);
			await audit(ctx, {
				action: "update",
				resourceType: "githubRunner",
				resourceId: node.githubRunnerNodeId,
				resourceName: node.name,
				metadata: { kind: "machine", operation: "rotate-key" },
			});
			return true;
		}),

	provisionMachine: update
		.input(apiFindGithubRunnerNode)
		.mutation(async ({ input, ctx }) => {
			const node = await findGithubRunnerNode(
				input.githubRunnerNodeId,
				ctx.session.activeOrganizationId,
			);
			const operation = await provisionRunnerNode(
				node.githubRunnerNodeId,
				ctx.user.id,
			).catch(fail);
			await audit(ctx, {
				action: "update",
				resourceType: "githubRunner",
				resourceId: node.githubRunnerNodeId,
				resourceName: node.name,
				metadata: { kind: "machine", operation: "provision" },
			});
			return operation;
		}),

	updateMachine: update
		.input(apiUpdateGithubRunnerNode)
		.mutation(async ({ input, ctx }) => {
			const node = await updateGithubRunnerNode(
				input,
				ctx.session.activeOrganizationId,
			).catch(fail);
			const operation = await applyRunnerNodeConfig(
				node.githubRunnerNodeId,
				input.mode,
				ctx.user.id,
			).catch(fail);
			await audit(ctx, {
				action: "update",
				resourceType: "githubRunner",
				resourceId: node.githubRunnerNodeId,
				resourceName: node.name,
				metadata: {
					kind: "machine",
					cpuPercent: node.cpuPercent,
					memoryPercent: node.memoryPercent,
					maxRunners: node.maxRunners,
					diskReserveGb: node.diskReserveGb,
					diskCleanupPercent: node.diskCleanupPercent,
					updatePolicy: node.updatePolicy,
					mode: input.mode,
				},
			});
			return { node, operation };
		}),

	/** Updates the runtime and the runner at the next tick, whatever the policy. */
	updateMachineNow: update
		.input(apiFindGithubRunnerNode)
		.mutation(async ({ input, ctx }) => {
			const node = await requestGithubRunnerNodeUpdate(
				input.githubRunnerNodeId,
				ctx.session.activeOrganizationId,
			).catch(fail);
			await audit(ctx, {
				action: "update",
				resourceType: "githubRunner",
				resourceId: node.githubRunnerNodeId,
				resourceName: node.name,
				metadata: { kind: "machine", operation: "update-now" },
			});
			return { requested: true };
		}),

	/** Lets the other machines follow a rollout its canary paused. */
	resumeRollout: update
		.input(
			z.object({
				githubRunnerPoolId: z.string().min(1),
				kind: z.enum(["runner", "runtime"]),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			const pool = await resumeGithubRunnerPoolRollout(
				input.githubRunnerPoolId,
				input.kind,
				ctx.session.activeOrganizationId,
			).catch(fail);
			await audit(ctx, {
				action: "update",
				resourceType: "githubRunner",
				resourceId: pool.githubRunnerPoolId,
				resourceName: pool.name,
				metadata: {
					kind: "pool",
					operation: "resume-rollout",
					update: input.kind,
				},
			});
			return { resumed: true };
		}),

	/** Which controller process leads, and which ones stand by. */
	controllerStatus: read.query(() => githubRunnerControllerStatus()),

	/** Reads the OS of a machine again at the next tick. */
	checkMachineOs: update
		.input(apiFindGithubRunnerNode)
		.mutation(async ({ input, ctx }) => {
			const node = await findGithubRunnerNode(
				input.githubRunnerNodeId,
				ctx.session.activeOrganizationId,
			);
			await checkRunnerNodeOs(node.githubRunnerNodeId);
			return { requested: true };
		}),

	disableMachine: update
		.input(apiDisableGithubRunnerNode)
		.mutation(async ({ input, ctx }) => {
			const node = await findGithubRunnerNode(
				input.githubRunnerNodeId,
				ctx.session.activeOrganizationId,
			);
			const operation = await disableRunnerNode(
				node.githubRunnerNodeId,
				{ mode: input.mode, timeoutMinutes: input.timeoutMinutes },
				ctx.user.id,
			).catch(fail);
			await audit(ctx, {
				action: "stop",
				resourceType: "githubRunner",
				resourceId: node.githubRunnerNodeId,
				resourceName: node.name,
				metadata: {
					kind: "machine",
					mode: input.mode,
					timeoutMinutes: input.timeoutMinutes,
				},
			});
			return operation;
		}),

	enableMachine: update
		.input(apiFindGithubRunnerNode)
		.mutation(async ({ input, ctx }) => {
			const node = await findGithubRunnerNode(
				input.githubRunnerNodeId,
				ctx.session.activeOrganizationId,
			);
			const operation = await enableRunnerNode(
				node.githubRunnerNodeId,
				ctx.user.id,
			).catch(fail);
			await audit(ctx, {
				action: "start",
				resourceType: "githubRunner",
				resourceId: node.githubRunnerNodeId,
				resourceName: node.name,
				metadata: { kind: "machine" },
			});
			return operation;
		}),

	removeMachine: remove
		.input(apiRemoveGithubRunnerNode)
		.mutation(async ({ input, ctx }) => {
			const node = await findGithubRunnerNode(
				input.githubRunnerNodeId,
				ctx.session.activeOrganizationId,
			);
			const operation = await removeRunnerNode(
				node.githubRunnerNodeId,
				{
					mode: input.mode,
					uninstall: input.uninstall,
					force: input.force,
					timeoutMinutes: input.timeoutMinutes,
				},
				ctx.user.id,
			).catch(fail);
			await audit(ctx, {
				action: "delete",
				resourceType: "githubRunner",
				resourceId: node.githubRunnerNodeId,
				resourceName: node.name,
				metadata: {
					kind: "machine",
					mode: input.mode,
					uninstall: input.uninstall,
					force: input.force,
				},
			});
			return operation;
		}),

	presentedHostKey: update
		.input(apiFindGithubRunnerNode)
		.mutation(async ({ input, ctx }) => {
			const node = await findGithubRunnerNode(
				input.githubRunnerNodeId,
				ctx.session.activeOrganizationId,
			);
			return {
				pinned: node.hostKeyFingerprint,
				presented: await readPresentedHostKey(node.githubRunnerNodeId).catch(
					fail,
				),
			};
		}),

	acceptHostKey: update
		.input(
			apiFindGithubRunnerNode.extend({
				fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]+$/),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			const node = await findGithubRunnerNode(
				input.githubRunnerNodeId,
				ctx.session.activeOrganizationId,
			);
			await resetGithubRunnerHostKey(
				node.githubRunnerNodeId,
				input.fingerprint,
				ctx.session.activeOrganizationId,
			);
			await audit(ctx, {
				action: "update",
				resourceType: "githubRunner",
				resourceId: node.githubRunnerNodeId,
				resourceName: node.name,
				metadata: {
					kind: "machine",
					hostKey: input.fingerprint,
					previousHostKey: node.hostKeyFingerprint,
				},
			});
			return true;
		}),

	refreshCaches: update
		.input(apiFindGithubRunnerNode)
		.mutation(async ({ input, ctx }) => {
			const node = await findGithubRunnerNode(
				input.githubRunnerNodeId,
				ctx.session.activeOrganizationId,
			);
			return refreshRunnerCaches(node.githubRunnerNodeId);
		}),

	cleanCaches: update
		.input(apiCleanGithubRunnerNode)
		.mutation(async ({ input, ctx }) => {
			const node = await findGithubRunnerNode(
				input.githubRunnerNodeId,
				ctx.session.activeOrganizationId,
			);
			await cleanRunnerCaches(node.githubRunnerNodeId, input.mode).catch(fail);
			await audit(ctx, {
				action: "update",
				resourceType: "githubRunner",
				resourceId: node.githubRunnerNodeId,
				resourceName: node.name,
				metadata: {
					kind: "machine",
					operation: "clean-caches",
					mode: input.mode,
				},
			});
			return true;
		}),

	operations: read
		.input(apiGithubRunnerOperations)
		.query(({ input, ctx }) =>
			listGithubRunnerOperations(
				input.githubRunnerNodeId,
				ctx.session.activeOrganizationId,
				input.limit,
			),
		),

	operation: read
		.input(apiFindGithubRunnerOperation)
		.query(({ input, ctx }) =>
			findGithubRunnerOperation(
				input.githubRunnerOperationId,
				ctx.session.activeOrganizationId,
			),
		),

	jobs: read
		.input(apiGithubRunnerJobs)
		.query(({ input, ctx }) =>
			listGithubRunnerJobs(input, ctx.session.activeOrganizationId),
		),

	jobStats: read
		.input(apiFindGithubRunnerPool)
		.query(({ input, ctx }) =>
			getGithubRunnerJobStats(
				input.githubRunnerPoolId,
				ctx.session.activeOrganizationId,
			),
		),

	metrics: read
		.input(apiGithubRunnerMetrics)
		.query(({ input, ctx }) =>
			getGithubRunnerMetrics(
				input.githubRunnerNodeId,
				input.hours,
				ctx.session.activeOrganizationId,
			),
		),
});
