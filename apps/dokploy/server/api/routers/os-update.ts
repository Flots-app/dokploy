import {
	assignOsUpdateConfiguration,
	cancelOsUpdateRun,
	createOsUpdateConfiguration,
	findOsUpdateRun,
	IS_CLOUD,
	installOsUpdatesNow,
	listOsUpdateConfigurations,
	listOsUpdateRuns,
	listOsUpdateServers,
	removeOsUpdateConfiguration,
	requestOsUpdateAssessment,
	setOsUpdatePeriodicAssessment,
	updateOsUpdateConfiguration,
} from "@dokploy/server";
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

export const osUpdateRouter = createTRPCRouter({
	overview: read.query(async ({ ctx }) => {
		const organizationId = ctx.session.activeOrganizationId;
		const [servers, configurations] = await Promise.all([
			listOsUpdateServers(organizationId),
			listOsUpdateConfigurations(organizationId),
		]);
		return { servers, configurations };
	}),

	runs: read
		.input(apiListOsUpdateRuns)
		.query(({ input, ctx }) =>
			listOsUpdateRuns(input, ctx.session.activeOrganizationId),
		),

	run: read
		.input(apiFindOsUpdateRun)
		.query(({ input, ctx }) =>
			findOsUpdateRun(input.osUpdateRunId, ctx.session.activeOrganizationId),
		),

	createConfiguration: create
		.input(apiCreateOsUpdateConfiguration)
		.mutation(async ({ input, ctx }) => {
			const configuration = await createOsUpdateConfiguration(
				input,
				ctx.session.activeOrganizationId,
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
				ctx.session.activeOrganizationId,
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

	removeConfiguration: remove
		.input(apiFindOsUpdateConfiguration)
		.mutation(async ({ input, ctx }) => {
			const configuration = await removeOsUpdateConfiguration(
				input.osUpdateConfigurationId,
				ctx.session.activeOrganizationId,
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
				ctx.session.activeOrganizationId,
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
				ctx.session.activeOrganizationId,
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
			ctx.session.activeOrganizationId,
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
				ctx.session.activeOrganizationId,
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
		const cancelled = await cancelOsUpdateRun(
			input.osUpdateRunId,
			ctx.session.activeOrganizationId,
		);
		await audit(ctx, {
			action: "cancel",
			resourceType: "osUpdate",
			resourceId: cancelled.osUpdateRunId,
			resourceName: cancelled.serverId,
		});
		return { ok: true };
	}),
});
