import {
	assignOsUpdateConfiguration,
	cancelOsUpdateRun,
	createOsUpdateConfiguration,
	findOsUpdateRun,
	getAccessibleServerIds,
	IS_CLOUD,
	installOsUpdatesNow,
	listOsUpdateConfigurations,
	listOsUpdateRuns,
	listOsUpdateServers,
	type OsUpdateAccess,
	removeOsUpdateConfiguration,
	requestOsUpdateAssessment,
	setOsUpdateConfigurationEnabled,
	setOsUpdatePeriodicAssessment,
	updateOsUpdateConfiguration,
} from "@dokploy/server";
import { checkPermission } from "@dokploy/server/services/permission";
import { TRPCError } from "@trpc/server";
import { createTRPCRouter, withPermission } from "@/server/api/trpc";
import { audit } from "@/server/api/utils/audit";
import {
	apiAssignOsUpdateConfiguration,
	apiCreateOsUpdateConfiguration,
	apiFindOsUpdateConfiguration,
	apiFindOsUpdateRun,
	apiInstallOsUpdatesNow,
	apiListOsUpdateRuns,
	apiOsUpdateServer,
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

/**
 * What the member may reach: the servers of their access (a member may be
 * limited to some), and osUpdate.run, which every change that makes servers
 * run apt as root needs on top of its own right (the service tells when).
 */
const accessOf = async (
	ctx: Parameters<typeof checkPermission>[0] & {
		session: { userId: string; activeOrganizationId: string };
	},
): Promise<OsUpdateAccess> => ({
	organizationId: ctx.session.activeOrganizationId,
	serverIds: await getAccessibleServerIds(ctx.session),
	requireRun: () => checkPermission(ctx, { osUpdate: ["run"] }),
});

export const osUpdateRouter = createTRPCRouter({
	overview: read.query(async ({ ctx }) => {
		const access = await accessOf(ctx);
		const [servers, configurations] = await Promise.all([
			listOsUpdateServers(access),
			listOsUpdateConfigurations(access),
		]);
		return { servers, configurations };
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
			const { server, configuration } = await assignOsUpdateConfiguration(
				input,
				await accessOf(ctx),
			);
			await audit(ctx, {
				action: "update",
				resourceType: "osUpdate",
				resourceId: server.serverId,
				resourceName: server.name,
				metadata: { configuration: configuration?.name ?? null },
			});
			return { ok: true };
		}),

	setPeriodicAssessment: update
		.input(apiSetOsUpdateAssessment)
		.mutation(async ({ input, ctx }) => {
			const server = await setOsUpdatePeriodicAssessment(
				input,
				await accessOf(ctx),
			);
			await audit(ctx, {
				action: "update",
				resourceType: "osUpdate",
				resourceId: server.serverId,
				resourceName: server.name,
				metadata: { periodicAssessment: input.periodicAssessment },
			});
			return { ok: true };
		}),

	checkNow: run.input(apiOsUpdateServer).mutation(async ({ input, ctx }) => {
		const server = await requestOsUpdateAssessment(
			input.serverId,
			await accessOf(ctx),
		);
		await audit(ctx, {
			action: "run",
			resourceType: "osUpdate",
			resourceId: server.serverId,
			resourceName: server.name,
			metadata: { assessment: true },
		});
		return { ok: true };
	}),

	installNow: run
		.input(apiInstallOsUpdatesNow)
		.mutation(async ({ input, ctx }) => {
			const { run: queued, server } = await installOsUpdatesNow(
				input,
				await accessOf(ctx),
				ctx.user.email,
			);
			await audit(ctx, {
				action: "run",
				resourceType: "osUpdate",
				resourceId: server.serverId,
				resourceName: server.name,
				metadata: { run: queued.osUpdateRunId, settings: queued.settings },
			});
			return queued;
		}),

	cancelRun: run.input(apiFindOsUpdateRun).mutation(async ({ input, ctx }) => {
		const { run: cancelled, server } = await cancelOsUpdateRun(
			input.osUpdateRunId,
			await accessOf(ctx),
		);
		await audit(ctx, {
			action: "cancel",
			resourceType: "osUpdate",
			resourceId: server.serverId,
			resourceName: server.name,
			metadata: {
				run: cancelled.osUpdateRunId,
				trigger: cancelled.trigger,
				windowStart: cancelled.windowStart,
			},
		});
		return { ok: true };
	}),
});
