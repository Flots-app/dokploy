import {
	attachFirewall,
	createFirewall,
	detachFirewall,
	findFirewall,
	firewallAppliesToRunners,
	IS_CLOUD,
	listFirewalls,
	removeFirewall,
	updateFirewall,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import { checkPermission } from "@dokploy/server/services/permission";
import { toClientError } from "@dokploy/server/utils/github-runners/errors";
import { TRPCError } from "@trpc/server";
import { asc, eq } from "drizzle-orm";
import { createTRPCRouter, withPermission } from "@/server/api/trpc";
import { audit } from "@/server/api/utils/audit";
import {
	apiAttachFirewall,
	apiCreateFirewall,
	apiDetachFirewall,
	apiFindFirewall,
	apiUpdateFirewall,
	githubRunnerNodes,
	githubRunnerPools,
} from "@/server/db/schema";

// Firewalls apply to GitHub runner machines for now, reached over SSH from a
// self-hosted Dokploy.
const assertSelfHosted = () => {
	if (IS_CLOUD) {
		throw new TRPCError({
			code: "NOT_IMPLEMENTED",
			message: "Firewalls are not available on Dokploy Cloud",
		});
	}
};
const guard = (action: "read" | "create" | "update" | "delete") =>
	withPermission("firewall", action).use(({ next }) => {
		assertSelfHosted();
		return next();
	});
const read = guard("read");
const create = guard("create");
const update = guard("update");
const remove = guard("delete");

/**
 * Changing or deleting a firewall that runner pools or machines use changes
 * what their jobs may reach, like attaching one: it needs the runner right too.
 */
const assertRunnerChange = async (
	ctx: Parameters<typeof checkPermission>[0] & {
		session: { activeOrganizationId: string };
	},
	firewallId: string,
) => {
	if (
		await firewallAppliesToRunners(firewallId, ctx.session.activeOrganizationId)
	) {
		await checkPermission(ctx, { githubRunner: ["update"] });
	}
};

const fail = (error: unknown): never => {
	throw toClientError(error);
};

export const firewallRouter = createTRPCRouter({
	list: read.query(({ ctx }) =>
		listFirewalls(ctx.session.activeOrganizationId),
	),

	one: read
		.input(apiFindFirewall)
		.query(({ input, ctx }) =>
			findFirewall(input.firewallId, ctx.session.activeOrganizationId),
		),

	/** Resources a firewall can apply to, for those who may see them. */
	targets: read.query(async ({ ctx }) => {
		await checkPermission(ctx, { githubRunner: ["read"] });
		const organizationId = ctx.session.activeOrganizationId;
		const [pools, nodes] = await Promise.all([
			db.query.githubRunnerPools.findMany({
				where: eq(githubRunnerPools.organizationId, organizationId),
				columns: { githubRunnerPoolId: true, name: true },
				orderBy: asc(githubRunnerPools.name),
			}),
			db.query.githubRunnerNodes.findMany({
				where: eq(githubRunnerNodes.organizationId, organizationId),
				columns: {
					githubRunnerNodeId: true,
					githubRunnerPoolId: true,
					name: true,
					platform: true,
				},
				orderBy: asc(githubRunnerNodes.name),
			}),
		]);
		return { pools, nodes };
	}),

	create: create.input(apiCreateFirewall).mutation(async ({ input, ctx }) => {
		const firewall = await createFirewall(
			input,
			ctx.session.activeOrganizationId,
		).catch(fail);
		await audit(ctx, {
			action: "create",
			resourceType: "firewall",
			resourceId: firewall.firewallId,
			resourceName: firewall.name,
			metadata: {
				inboundPolicy: firewall.inboundPolicy,
				outboundPolicy: firewall.outboundPolicy,
				rules: firewall.rules.length,
			},
		});
		return firewall;
	}),

	update: update.input(apiUpdateFirewall).mutation(async ({ input, ctx }) => {
		await assertRunnerChange(ctx, input.firewallId);
		const firewall = await updateFirewall(
			input,
			ctx.session.activeOrganizationId,
		).catch(fail);
		await audit(ctx, {
			action: "update",
			resourceType: "firewall",
			resourceId: firewall.firewallId,
			resourceName: firewall.name,
			metadata: {
				revision: firewall.revision,
				inboundPolicy: firewall.inboundPolicy,
				outboundPolicy: firewall.outboundPolicy,
				rules: firewall.rules,
			},
		});
		return firewall;
	}),

	remove: remove.input(apiFindFirewall).mutation(async ({ input, ctx }) => {
		await assertRunnerChange(ctx, input.firewallId);
		const firewall = await removeFirewall(
			input.firewallId,
			ctx.session.activeOrganizationId,
		).catch(fail);
		await audit(ctx, {
			action: "delete",
			resourceType: "firewall",
			resourceId: firewall.firewallId,
			resourceName: firewall.name,
		});
		return { ok: true };
	}),

	/** Changing what a runner pool or machine lets through is a runner change too. */
	attach: update.input(apiAttachFirewall).mutation(async ({ input, ctx }) => {
		await checkPermission(ctx, { githubRunner: ["update"] });
		const { firewall, targetName } = await attachFirewall(
			input,
			ctx.session.activeOrganizationId,
		).catch(fail);
		await audit(ctx, {
			action: "update",
			resourceType: "firewall",
			resourceId: firewall.firewallId,
			resourceName: firewall.name,
			metadata: { attached: { ...input.target, name: targetName } },
		});
		return { ok: true };
	}),

	detach: update.input(apiDetachFirewall).mutation(async ({ input, ctx }) => {
		await checkPermission(ctx, { githubRunner: ["update"] });
		const { targetName } = await detachFirewall(
			input.target,
			ctx.session.activeOrganizationId,
		).catch(fail);
		await audit(ctx, {
			action: "update",
			resourceType: "firewall",
			resourceId: input.target.id,
			resourceName: targetName,
			metadata: { detached: input.target },
		});
		return { ok: true };
	}),
});
