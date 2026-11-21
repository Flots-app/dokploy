import {
	assignOsUpdateConfiguration,
	cancelOsUpdateRun,
	createOsUpdateConfiguration,
	findOsUpdateRun,
	getAccessibleServerIds,
	handOffMacos,
	IS_CLOUD,
	installOsUpdatesNow,
	listOsUpdateConfigurations,
	listOsUpdateMacs,
	listOsUpdateRunnerNodes,
	listOsUpdateRuns,
	listOsUpdateServers,
	type OsUpdateAccess,
	removeOsUpdateConfiguration,
	requestOsUpdateAssessment,
	setOsUpdateConfigurationEnabled,
	setOsUpdatePeriodicAssessment,
	updateOsUpdateConfiguration,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import { githubRunnerNodes } from "@dokploy/server/db/schema";
import { checkPermission } from "@dokploy/server/services/permission";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { createTRPCRouter, withPermission } from "@/server/api/trpc";
import { audit } from "@/server/api/utils/audit";
import {
	apiAssignOsUpdateConfiguration,
	apiCreateOsUpdateConfiguration,
	apiFindOsUpdateConfiguration,
	apiFindOsUpdateRun,
	apiHandOffMacos,
	apiInstallOsUpdatesNow,
	apiListOsUpdateRuns,
	apiOsUpdateMachine,
	apiSetOsUpdateAssessment,
	apiSetOsUpdateConfigurationEnabled,
	apiUpdateOsUpdateConfiguration,
} from "@/server/db/schema";

// Self-hosted only: the servers are reached over SSH from the Dokploy server,
// whose controller runs the updates.
const assertSelfHosted = () => {
	if (IS_CLOUD) {
		throw new TRPCError({
			code: "NOT_IMPLEMENTED",
			message: "OS updates are not available on Dokploy Cloud",
		});
	}
};
const guard = (action: "read" | "create" | "update" | "delete" | "run") =>
	withPermission("osUpdate", action).use(({ next }) => {
		assertSelfHosted();
		return next();
	});
const read = guard("read");
const create = guard("create");
const update = guard("update");
const remove = guard("delete");
/** Runs commands as root on a server: Check now and Install now. */
const run = guard("run");

/** Whether the member holds a permission, without throwing. */
const allowed = (
	ctx: Parameters<typeof checkPermission>[0],
	permissions: Parameters<typeof checkPermission>[1],
) =>
	checkPermission(ctx, permissions).then(
		() => true,
		() => false,
	);

/**
 * What the member may reach: the servers of their access (a member may be
 * limited to some), the runner machines when they may see GitHub runners,
 * osUpdate.run, which every change that makes machines run apt as root needs
 * on top of its own right, and githubRunner.update, which every change that
 * takes runner machines out of service needs (the service tells when).
 */
const accessOf = async (
	ctx: Parameters<typeof checkPermission>[0] & {
		session: { userId: string; activeOrganizationId: string };
	},
): Promise<OsUpdateAccess> => {
	const organizationId = ctx.session.activeOrganizationId;
	const [serverIds, seesRunners] = await Promise.all([
		getAccessibleServerIds(ctx.session),
		// Self-hosted only, as OS updates (the router checks it first).
		allowed(ctx, { githubRunner: ["read"] }),
	]);
	const runnerNodeIds = seesRunners
		? new Set(
				(
					await db
						.select({ id: githubRunnerNodes.githubRunnerNodeId })
						.from(githubRunnerNodes)
						.where(eq(githubRunnerNodes.organizationId, organizationId))
				).map((row) => row.id),
			)
		: new Set<string>();
	return {
		organizationId,
		serverIds,
		runnerNodeIds,
		requireRun: () => checkPermission(ctx, { osUpdate: ["run"] }),
		requireRunnerUpdate: () =>
			checkPermission(ctx, { githubRunner: ["update"] }),
	};
};

/** What the audit log names: the server, or the runner machine. */
const auditTarget = (target: {
	id: string;
	name: string;
	machine: { kind: "server" | "runner" };
}) => ({
	resourceId: target.id,
	resourceName: target.name,
	metadata: { machine: target.machine.kind },
});

export const osUpdateRouter = createTRPCRouter({
	overview: read.query(async ({ ctx }) => {
		const access = await accessOf(ctx);
		const [servers, runnerNodes, macs, configurations] = await Promise.all([
			listOsUpdateServers(access),
			listOsUpdateRunnerNodes(access),
			listOsUpdateMacs(access),
			listOsUpdateConfigurations(access),
		]);
		return { servers, runnerNodes, macs, configurations };
	}),

	runs: read
		.input(apiListOsUpdateRuns)
		.query(async ({ input, ctx }) =>
			listOsUpdateRuns(input, await accessOf(ctx)),
		),

	run: read
		.input(apiFindOsUpdateRun)
		.query(async ({ input, ctx }) =>
			findOsUpdateRun(input.osUpdateRunId, await accessOf(ctx)),
		),

	createConfiguration: create
		.input(apiCreateOsUpdateConfiguration)
		.mutation(async ({ input, ctx }) => {
			const configuration = await createOsUpdateConfiguration(
				input,
				await accessOf(ctx),
			);
			await audit(ctx, {
				action: "create",
				resourceType: "osUpdate",
				resourceId: configuration.osUpdateConfigurationId,
				resourceName: configuration.name,
				metadata: {
					schedule: configuration.schedule,
					classification: configuration.classification,
					reboot: configuration.reboot,
					allowDockerUpdates: configuration.allowDockerUpdates,
					servers: input.serverIds,
					runnerNodes: input.runnerNodeIds,
				},
			});
			return configuration;
		}),

	updateConfiguration: update
		.input(apiUpdateOsUpdateConfiguration)
		.mutation(async ({ input, ctx }) => {
			const configuration = await updateOsUpdateConfiguration(
				input,
				await accessOf(ctx),
			);
			await audit(ctx, {
				action: "update",
				resourceType: "osUpdate",
				resourceId: configuration.osUpdateConfigurationId,
				resourceName: configuration.name,
				metadata: {
					enabled: configuration.enabled,
					schedule: configuration.schedule,
					classification: configuration.classification,
					includePackages: configuration.includePackages,
					excludePackages: configuration.excludePackages,
					reboot: configuration.reboot,
					allowDockerUpdates: configuration.allowDockerUpdates,
					servers: input.serverIds,
					runnerNodes: input.runnerNodeIds,
				},
			});
			return configuration;
		}),

	/** On or off only: the form's other fields may be stale. */
	setEnabled: update
		.input(apiSetOsUpdateConfigurationEnabled)
		.mutation(async ({ input, ctx }) => {
			const configuration = await setOsUpdateConfigurationEnabled(
				input,
				await accessOf(ctx),
			);
			await audit(ctx, {
				action: "update",
				resourceType: "osUpdate",
				resourceId: configuration.osUpdateConfigurationId,
				resourceName: configuration.name,
				metadata: { enabled: configuration.enabled },
			});
			return configuration;
		}),

	removeConfiguration: remove
		.input(apiFindOsUpdateConfiguration)
		.mutation(async ({ input, ctx }) => {
			const configuration = await removeOsUpdateConfiguration(
				input.osUpdateConfigurationId,
				await accessOf(ctx),
			);
			await audit(ctx, {
				action: "delete",
				resourceType: "osUpdate",
				resourceId: configuration.osUpdateConfigurationId,
				resourceName: configuration.name,
			});
			return { ok: true };
		}),

	assign: update
		.input(apiAssignOsUpdateConfiguration)
		.mutation(async ({ input, ctx }) => {
			const { machine, configuration } = await assignOsUpdateConfiguration(
				input,
				await accessOf(ctx),
			);
			const target = auditTarget(machine);
			await audit(ctx, {
				action: "update",
				resourceType: "osUpdate",
				...target,
				metadata: {
					...target.metadata,
					configuration: configuration?.name ?? null,
				},
			});
			return { ok: true };
		}),

	setPeriodicAssessment: update
		.input(apiSetOsUpdateAssessment)
		.mutation(async ({ input, ctx }) => {
			const machine = await setOsUpdatePeriodicAssessment(
				input,
				await accessOf(ctx),
			);
			const target = auditTarget(machine);
			await audit(ctx, {
				action: "update",
				resourceType: "osUpdate",
				...target,
				metadata: {
					...target.metadata,
					periodicAssessment: input.periodicAssessment,
				},
			});
			return { ok: true };
		}),

	checkNow: run.input(apiOsUpdateMachine).mutation(async ({ input, ctx }) => {
		const machine = await requestOsUpdateAssessment(input, await accessOf(ctx));
		const target = auditTarget(machine);
		await audit(ctx, {
			action: "run",
			resourceType: "osUpdate",
			...target,
			metadata: { ...target.metadata, assessment: true },
		});
		return { ok: true };
	}),

	installNow: run
		.input(apiInstallOsUpdatesNow)
		.mutation(async ({ input, ctx }) => {
			const { run: queued, machine } = await installOsUpdatesNow(
				input,
				await accessOf(ctx),
				ctx.user.email,
			);
			const target = auditTarget(machine);
			await audit(ctx, {
				action: "run",
				resourceType: "osUpdate",
				...target,
				metadata: {
					...target.metadata,
					run: queued.osUpdateRunId,
					settings: queued.settings,
				},
			});
			return queued;
		}),

	/**
	 * Takes a Mac out of service while its owner updates macOS: Dokploy
	 * installs nothing on macOS, it gives the Mac back once it reports
	 * another version.
	 */
	handOffMacos: run.input(apiHandOffMacos).mutation(async ({ input, ctx }) => {
		const { run: queued, machine } = await handOffMacos(
			input,
			await accessOf(ctx),
			ctx.user.email,
		);
		const target = auditTarget(machine);
		await audit(ctx, {
			action: "run",
			resourceType: "osUpdate",
			...target,
			metadata: {
				...target.metadata,
				handoff: true,
				run: queued.osUpdateRunId,
				maxHours: input.maxHours,
			},
		});
		return queued;
	}),

	cancelRun: run.input(apiFindOsUpdateRun).mutation(async ({ input, ctx }) => {
		const { run: cancelled, machine } = await cancelOsUpdateRun(
			input.osUpdateRunId,
			await accessOf(ctx),
		);
		const target = auditTarget(machine);
		await audit(ctx, {
			action: "cancel",
			resourceType: "osUpdate",
			...target,
			metadata: {
				...target.metadata,
				run: cancelled.osUpdateRunId,
				trigger: cancelled.trigger,
				windowStart: cancelled.windowStart,
			},
		});
		return { ok: true };
	}),
});
