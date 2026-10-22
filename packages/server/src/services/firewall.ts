/**
 * The Firewalls service: firewalls of an organization and the resources they
 * apply to. Enforcement belongs to the services that own the resources (the
 * GitHub runner controller loads the rules on its machines); this service
 * holds the rules, the attachments, and reports where they stand.
 */
import { lookup } from "node:dns/promises";
import { db } from "@dokploy/server/db";
import {
	type apiCreateFirewall,
	type apiUpdateFirewall,
	type Firewall,
	type FirewallTarget,
	firewallAttachments,
	firewalls,
	type GithubRunnerNode,
	githubRunnerNodes,
	githubRunnerPools,
} from "@dokploy/server/db/schema";
import {
	nftablesRuleset,
	pfRuleset,
} from "@dokploy/server/utils/firewall/backends";
import { compileFirewall, filters } from "@dokploy/server/utils/firewall/model";
import { isAddress } from "@dokploy/server/utils/firewall/rules";
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { z } from "zod";
import { getDokployUrl } from "./admin";
import { getWebServerSettings } from "./web-server-settings";

const notFound = (what: string) =>
	new TRPCError({ code: "NOT_FOUND", message: `${what} not found` });

export const findFirewall = async (
	firewallId: string,
	organizationId: string,
) => {
	const firewall = await db.query.firewalls.findFirst({
		where: and(
			eq(firewalls.firewallId, firewallId),
			eq(firewalls.organizationId, organizationId),
		),
	});
	if (!firewall) throw notFound("Firewall");
	return firewall;
};

export const createFirewall = async (
	input: z.infer<typeof apiCreateFirewall>,
	organizationId: string,
) => {
	const [firewall] = await db
		.insert(firewalls)
		.values({ ...input, organizationId })
		.returning();
	if (!firewall) throw new Error("The firewall could not be created");
	return firewall;
};

export const updateFirewall = async (
	input: z.infer<typeof apiUpdateFirewall>,
	organizationId: string,
) => {
	const { firewallId, ...fields } = input;
	await findFirewall(firewallId, organizationId);
	const [firewall] = await db
		.update(firewalls)
		.set({
			...fields,
			revision: sql`${firewalls.revision} + 1`,
			updatedAt: new Date().toISOString(),
		})
		.where(eq(firewalls.firewallId, firewallId))
		.returning();
	if (!firewall) throw notFound("Firewall");
	return firewall;
};

/** Resources lose the firewall with it: their machines remove its rules. */
export const removeFirewall = async (
	firewallId: string,
	organizationId: string,
) => {
	const firewall = await findFirewall(firewallId, organizationId);
	await db.delete(firewalls).where(eq(firewalls.firewallId, firewallId));
	return firewall;
};

const targetColumn = (target: FirewallTarget) =>
	target.type === "githubRunnerPool"
		? firewallAttachments.githubRunnerPoolId
		: firewallAttachments.githubRunnerNodeId;

/** Checks the resource belongs to the organization; returns its name. */
const assertTarget = async (target: FirewallTarget, organizationId: string) => {
	if (target.type === "githubRunnerPool") {
		const pool = await db.query.githubRunnerPools.findFirst({
			where: and(
				eq(githubRunnerPools.githubRunnerPoolId, target.id),
				eq(githubRunnerPools.organizationId, organizationId),
			),
			columns: { name: true },
		});
		if (!pool) throw notFound("Runner pool");
		return pool.name;
	}
	const node = await db.query.githubRunnerNodes.findFirst({
		where: and(
			eq(githubRunnerNodes.githubRunnerNodeId, target.id),
			eq(githubRunnerNodes.organizationId, organizationId),
		),
		columns: { name: true },
	});
	if (!node) throw notFound("Runner machine");
	return node.name;
};

/** Puts a resource behind a firewall, in place of the one it had. */
export const attachFirewall = async (
	input: { firewallId: string; target: FirewallTarget },
	organizationId: string,
) => {
	const [firewall, targetName] = await Promise.all([
		findFirewall(input.firewallId, organizationId),
		assertTarget(input.target, organizationId),
	]);
	await db.transaction(async (tx) => {
		await tx
			.delete(firewallAttachments)
			.where(eq(targetColumn(input.target), input.target.id));
		await tx.insert(firewallAttachments).values({
			firewallId: firewall.firewallId,
			organizationId,
			githubRunnerPoolId:
				input.target.type === "githubRunnerPool" ? input.target.id : null,
			githubRunnerNodeId:
				input.target.type === "githubRunnerNode" ? input.target.id : null,
		});
	});
	return { firewall, targetName };
};

export const detachFirewall = async (
	target: FirewallTarget,
	organizationId: string,
) => {
	const targetName = await assertTarget(target, organizationId);
	await db
		.delete(firewallAttachments)
		.where(
			and(
				eq(targetColumn(target), target.id),
				eq(firewallAttachments.organizationId, organizationId),
			),
		);
	return { targetName };
};

// ------------------------------------------------------------ Dokploy server

const DOKPLOY_ADDRESSES_TTL_MS = 10 * 60_000;
const cache = globalThis as {
	__dokployFirewallAddresses?: { at: number; addresses: string[] };
};

/**
 * Addresses of this Dokploy server, for the "Dokploy server" object: its
 * public IP and what its domain resolves to. Cached for a few minutes.
 */
export const dokployServerAddresses = async () => {
	const known = cache.__dokployFirewallAddresses;
	if (known && Date.now() - known.at < DOKPLOY_ADDRESSES_TTL_MS) {
		return known.addresses;
	}
	const addresses = new Set<string>();
	const settings = await getWebServerSettings().catch(() => null);
	if (settings?.serverIp && isAddress(settings.serverIp)) {
		addresses.add(settings.serverIp);
	}
	const host = await getDokployUrl()
		.then((url) => new URL(url).hostname)
		.catch(() => null);
	if (host && isAddress(host)) addresses.add(host);
	else if (host) {
		for (const item of await lookup(host, { all: true }).catch(() => [])) {
			addresses.add(item.address);
		}
	}
	const list = [...addresses].sort();
	cache.__dokployFirewallAddresses = { at: Date.now(), addresses: list };
	return list;
};

// ------------------------------------------------------------ GitHub runners

/** Firewalls attached to runner pools and machines, for the controller. */
export const loadRunnerFirewalls = async () => {
	const rows = await db.query.firewallAttachments.findMany({
		with: { firewall: true },
	});
	const byPool = new Map<string, Firewall>();
	const byNode = new Map<string, Firewall>();
	for (const row of rows) {
		if (row.githubRunnerPoolId)
			byPool.set(row.githubRunnerPoolId, row.firewall);
		if (row.githubRunnerNodeId)
			byNode.set(row.githubRunnerNodeId, row.firewall);
	}
	return { byPool, byNode };
};

export type RunnerFirewalls = Awaited<ReturnType<typeof loadRunnerFirewalls>>;

/** The firewall a machine follows: its own, or its pool's. */
export const runnerNodeFirewall = (
	firewalls: RunnerFirewalls,
	node: Pick<GithubRunnerNode, "githubRunnerNodeId" | "githubRunnerPoolId">,
) =>
	firewalls.byNode.get(node.githubRunnerNodeId) ??
	firewalls.byPool.get(node.githubRunnerPoolId) ??
	null;

export type FirewallTargetState = "applied" | "applying" | "error" | "inactive";

/** Where the rules of a firewall stand on a runner machine. */
export const runnerNodeFirewallState = (
	firewall: Pick<Firewall, "firewallId" | "revision">,
	node: Pick<GithubRunnerNode, "enabled" | "phase" | "firewall">,
): { state: FirewallTargetState; error: string | null } => {
	const applied = node.firewall;
	if (applied?.firewallId === firewall.firewallId && applied.error) {
		return { state: "error", error: applied.error };
	}
	if (
		applied?.firewallId === firewall.firewallId &&
		applied.revision === firewall.revision &&
		applied.hash
	) {
		return { state: "applied", error: null };
	}
	if (!node.enabled || node.phase !== "ready") {
		return { state: "inactive", error: null };
	}
	return { state: "applying", error: null };
};

/**
 * Firewalls of an organization, what they apply to and where their rules
 * stand on each machine, with what each platform cannot enforce.
 */
export const listFirewalls = async (organizationId: string) => {
	const rows = await db.query.firewalls.findMany({
		where: eq(firewalls.organizationId, organizationId),
		with: { attachments: true },
		orderBy: (table, { asc }) => [asc(table.name)],
	});
	const poolIds = rows.flatMap((row) =>
		row.attachments.flatMap((item) =>
			item.githubRunnerPoolId ? [item.githubRunnerPoolId] : [],
		),
	);
	const nodeIds = rows.flatMap((row) =>
		row.attachments.flatMap((item) =>
			item.githubRunnerNodeId ? [item.githubRunnerNodeId] : [],
		),
	);
	const [pools, nodes, ownFirewalls] = await Promise.all([
		poolIds.length
			? db.query.githubRunnerPools.findMany({
					where: inArray(githubRunnerPools.githubRunnerPoolId, poolIds),
					columns: { githubRunnerPoolId: true, name: true },
				})
			: [],
		db.query.githubRunnerNodes.findMany({
			where: eq(githubRunnerNodes.organizationId, organizationId),
			columns: {
				githubRunnerNodeId: true,
				githubRunnerPoolId: true,
				name: true,
				platform: true,
				enabled: true,
				phase: true,
				firewall: true,
			},
		}),
		db.query.firewallAttachments.findMany({
			where: eq(firewallAttachments.organizationId, organizationId),
			columns: { githubRunnerNodeId: true },
		}),
	]);
	const withOwn = new Set(
		ownFirewalls.flatMap((row) =>
			row.githubRunnerNodeId ? [row.githubRunnerNodeId] : [],
		),
	);
	const dokployAddresses = await dokployServerAddresses();
	return rows.map((row) => {
		const machines = (predicate: (node: (typeof nodes)[number]) => boolean) =>
			nodes.filter(predicate).map((node) => ({
				githubRunnerNodeId: node.githubRunnerNodeId,
				name: node.name,
				platform: node.platform,
				...runnerNodeFirewallState(row, node),
			}));
		const targets = row.attachments.map((item) =>
			item.githubRunnerPoolId
				? {
						type: "githubRunnerPool" as const,
						id: item.githubRunnerPoolId,
						name:
							pools.find(
								(pool) => pool.githubRunnerPoolId === item.githubRunnerPoolId,
							)?.name ?? "Runner pool",
						// Machines with a firewall of their own follow it instead.
						machines: machines(
							(node) =>
								node.githubRunnerPoolId === item.githubRunnerPoolId &&
								!withOwn.has(node.githubRunnerNodeId),
						),
					}
				: {
						type: "githubRunnerNode" as const,
						id: item.githubRunnerNodeId ?? "",
						name:
							nodes.find(
								(node) => node.githubRunnerNodeId === item.githubRunnerNodeId,
							)?.name ?? "Runner machine",
						machines: machines(
							(node) => node.githubRunnerNodeId === item.githubRunnerNodeId,
						),
					},
		);
		const compiled = compileFirewall(row, { dokployAddresses });
		const platforms = new Set(
			targets.flatMap((target) => target.machines.map((node) => node.platform)),
		);
		return {
			...row,
			targets,
			filtersOutbound: filters(compiled.outbound),
			notes: {
				linux: platforms.has("linux") ? nftablesRuleset(compiled).notes : [],
				macos: platforms.has("macos") ? pfRuleset(compiled).notes : [],
			},
		};
	});
};

/** The firewall of a runner pool or machine, for the runner pages. */
export const firewallOfTarget = async (
	target: FirewallTarget,
	organizationId: string,
) => {
	const row = await db.query.firewallAttachments.findFirst({
		where: and(
			eq(targetColumn(target), target.id),
			eq(firewallAttachments.organizationId, organizationId),
		),
		with: { firewall: { columns: { firewallId: true, name: true } } },
	});
	return row?.firewall ?? null;
};
