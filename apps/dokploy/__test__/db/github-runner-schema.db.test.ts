import { randomUUID } from "node:crypto";
import { db } from "@dokploy/server/db";
import {
	firewallAttachments,
	firewalls,
	githubRunnerNodes,
	githubRunnerPools,
	organization,
} from "@dokploy/server/db/schema";
import {
	attachFirewall,
	createFirewall,
	detachFirewall,
	findFirewall,
	listFirewalls,
} from "@dokploy/server/services/firewall";
import {
	findGithubRunnerNode,
	findGithubRunnerPool,
} from "@dokploy/server/services/github-runner";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createOrganization,
	insertNode,
	insertPool,
	type Person,
	pgErrorCode,
	removeCreatedRows,
} from "./fixtures";

const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";

let a: Person;
let b: Person;

beforeAll(async () => {
	a = await createOrganization("schema-a");
	b = await createOrganization("schema-b");
});

afterAll(removeCreatedRows);

describe("migration 0180 on an empty database", () => {
	it("creates the runner and firewall tables with their constraints", async () => {
		const tables = await db.execute<{ table_name: string }>(sql`
			select table_name from information_schema.tables
			where table_schema = 'public'
				and (table_name like 'github_runner%' or table_name like 'firewall%')
			order by table_name`);
		expect(tables.map((row) => row.table_name)).toEqual([
			"firewall",
			"firewall_attachment",
			"github_runner_alert",
			"github_runner_controller",
			"github_runner_job",
			"github_runner_leader",
			"github_runner_metric",
			"github_runner_node",
			"github_runner_operation",
			"github_runner_pool",
			"github_runner_reroute",
		]);
		const checks = await db.execute<{ conname: string }>(sql`
			select conname from pg_constraint
			where contype = 'c' and conname in (
				'firewall_attachment_one_target', 'github_runner_leader_single',
				'github_runner_node_budget', 'github_runner_pool_repository_scope')
			order by conname`);
		expect(checks).toHaveLength(4);
	});
});

describe("constraints", () => {
	it("refuses a budget out of range", async () => {
		const pool = await insertPool(a.organizationId, "budget");
		for (const values of [
			{ cpuPercent: 5 },
			{ memoryPercent: 101 },
			{ maxRunners: 33 },
			{ diskReserveGb: -1 },
			{ diskCleanupPercent: 49 },
			{ diskCleanupPercent: 100 },
		]) {
			expect(await pgErrorCode(insertNode(pool, "out-of-range", values))).toBe(
				CHECK_VIOLATION,
			);
		}
		const node = await insertNode(pool, "in-range", { diskCleanupPercent: 99 });
		expect(node).toMatchObject({ cpuPercent: 70, diskCleanupPercent: 99 });
	});

	it("needs a repository exactly for repository pools", async () => {
		const pool = (values: Partial<typeof githubRunnerPools.$inferInsert>) =>
			db.insert(githubRunnerPools).values({
				organizationId: a.organizationId,
				name: `scope-${randomUUID()}`,
				owner: "example",
				authType: "token",
				scope: "repository",
				...values,
			});
		expect(await pgErrorCode(pool({ repository: null }))).toBe(CHECK_VIOLATION);
		expect(
			await pgErrorCode(pool({ scope: "organization", repository: "ci" })),
		).toBe(CHECK_VIOLATION);
		expect(
			await pgErrorCode(pool({ scope: "organization", repository: null })),
		).toBeNull();
	});

	it("keeps names unique per organization, not across organizations", async () => {
		const poolA = await insertPool(a.organizationId, "names");
		const poolB = await insertPool(b.organizationId, "names");
		expect(await pgErrorCode(insertPool(a.organizationId, "names"))).toBe(
			UNIQUE_VIOLATION,
		);
		await insertNode(poolA, "m4");
		expect(await pgErrorCode(insertNode(poolA, "m4"))).toBe(UNIQUE_VIOLATION);
		expect(await pgErrorCode(insertNode(poolB, "m4"))).toBeNull();
	});

	it("attaches a firewall to exactly one pool or machine, once", async () => {
		const pool = await insertPool(a.organizationId, "attach-rules");
		const node = await insertNode(pool, "attach-rules");
		const firewall = await createFirewall(
			{
				name: "attach-rules",
				description: null,
				inboundPolicy: "allow",
				outboundPolicy: "allow",
				rules: [],
			},
			a.organizationId,
		);
		const attach = (values: Partial<typeof firewallAttachments.$inferInsert>) =>
			db.insert(firewallAttachments).values({
				firewallId: firewall.firewallId,
				organizationId: a.organizationId,
				...values,
			});
		expect(await pgErrorCode(attach({}))).toBe(CHECK_VIOLATION);
		expect(
			await pgErrorCode(
				attach({
					githubRunnerPoolId: pool.githubRunnerPoolId,
					githubRunnerNodeId: node.githubRunnerNodeId,
				}),
			),
		).toBe(CHECK_VIOLATION);
		expect(
			await pgErrorCode(
				attach({ githubRunnerPoolId: pool.githubRunnerPoolId }),
			),
		).toBeNull();
		expect(
			await pgErrorCode(
				attach({ githubRunnerPoolId: pool.githubRunnerPoolId }),
			),
		).toBe(UNIQUE_VIOLATION);
	});

	it("deletes an organization's pools, machines and firewalls with it, and nothing else", async () => {
		const gone = await createOrganization("schema-gone");
		const pool = await insertPool(gone.organizationId, "gone");
		const node = await insertNode(pool, "gone");
		const firewall = await createFirewall(
			{
				name: "gone",
				description: null,
				inboundPolicy: "allow",
				outboundPolicy: "deny",
				rules: [],
			},
			gone.organizationId,
		);
		await attachFirewall(
			{
				firewallId: firewall.firewallId,
				target: { type: "githubRunnerNode", id: node.githubRunnerNodeId },
			},
			gone.organizationId,
		);
		const keptPool = await insertPool(b.organizationId, "kept");

		await db
			.delete(organization)
			.where(eq(organization.id, gone.organizationId));

		const left = await Promise.all([
			db.query.githubRunnerPools.findMany({
				where: inArray(githubRunnerPools.githubRunnerPoolId, [
					pool.githubRunnerPoolId,
					keptPool.githubRunnerPoolId,
				]),
			}),
			db.query.githubRunnerNodes.findMany({
				where: eq(
					githubRunnerNodes.githubRunnerNodeId,
					node.githubRunnerNodeId,
				),
			}),
			db.query.firewalls.findMany({
				where: eq(firewalls.firewallId, firewall.firewallId),
			}),
			db.query.firewallAttachments.findMany({
				where: eq(firewallAttachments.firewallId, firewall.firewallId),
			}),
		]);
		expect(left[0].map((row) => row.githubRunnerPoolId)).toEqual([
			keptPool.githubRunnerPoolId,
		]);
		expect(left.slice(1).map((rows) => rows.length)).toEqual([0, 0, 0]);
	});
});

describe("services keep each organization to its own rows", () => {
	it("finds pools, machines and firewalls only in their organization", async () => {
		const pool = await insertPool(a.organizationId, "isolated");
		const node = await insertNode(pool, "isolated");
		const firewall = await createFirewall(
			{
				name: "isolated",
				description: null,
				inboundPolicy: "allow",
				outboundPolicy: "allow",
				rules: [],
			},
			a.organizationId,
		);
		await expect(
			findGithubRunnerPool(pool.githubRunnerPoolId, a.organizationId),
		).resolves.toMatchObject({ name: "isolated" });
		await expect(
			findGithubRunnerPool(pool.githubRunnerPoolId, b.organizationId),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			findGithubRunnerNode(node.githubRunnerNodeId, b.organizationId),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			findFirewall(firewall.firewallId, b.organizationId),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(
			(await listFirewalls(b.organizationId)).map((row) => row.firewallId),
		).not.toContain(firewall.firewallId);
	});

	it("attaches and detaches firewalls within the organization only", async () => {
		const poolA = await insertPool(a.organizationId, "fw-a");
		const nodeA = await insertNode(poolA, "fw-a");
		const poolB = await insertPool(b.organizationId, "fw-b");
		const firewall = (person: Person, name: string) =>
			createFirewall(
				{
					name,
					description: null,
					inboundPolicy: "allow",
					outboundPolicy: "deny",
					rules: [],
				},
				person.organizationId,
			);
		const [first, second, foreign] = await Promise.all([
			firewall(a, "fw-a-1"),
			firewall(a, "fw-a-2"),
			firewall(b, "fw-b"),
		]);
		const attachments = (id: string) =>
			db.query.firewallAttachments.findMany({
				where: eq(firewallAttachments.githubRunnerPoolId, id),
			});

		// Another organization's firewall, or another organization's pool.
		await expect(
			attachFirewall(
				{
					firewallId: foreign.firewallId,
					target: { type: "githubRunnerPool", id: poolA.githubRunnerPoolId },
				},
				a.organizationId,
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			attachFirewall(
				{
					firewallId: foreign.firewallId,
					target: { type: "githubRunnerPool", id: poolA.githubRunnerPoolId },
				},
				b.organizationId,
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(await attachments(poolA.githubRunnerPoolId)).toEqual([]);

		// A second firewall replaces the first one on the same pool.
		for (const { firewallId } of [first, second]) {
			await attachFirewall(
				{
					firewallId,
					target: { type: "githubRunnerPool", id: poolA.githubRunnerPoolId },
				},
				a.organizationId,
			);
		}
		expect(
			(await attachments(poolA.githubRunnerPoolId)).map(
				(row) => row.firewallId,
			),
		).toEqual([second.firewallId]);
		await attachFirewall(
			{
				firewallId: first.firewallId,
				target: { type: "githubRunnerNode", id: nodeA.githubRunnerNodeId },
			},
			a.organizationId,
		);

		// Detaching from the other organization changes nothing.
		await expect(
			detachFirewall(
				{ type: "githubRunnerPool", id: poolA.githubRunnerPoolId },
				b.organizationId,
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(await attachments(poolA.githubRunnerPoolId)).toHaveLength(1);
		await detachFirewall(
			{ type: "githubRunnerPool", id: poolA.githubRunnerPoolId },
			a.organizationId,
		);
		expect(await attachments(poolA.githubRunnerPoolId)).toEqual([]);
		expect(
			await db.query.firewallAttachments.findMany({
				where: eq(
					firewallAttachments.githubRunnerNodeId,
					nodeA.githubRunnerNodeId,
				),
			}),
		).toHaveLength(1);
		expect(await attachments(poolB.githubRunnerPoolId)).toEqual([]);
	});
});
