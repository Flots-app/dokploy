/**
 * Reserving and releasing a preview worker, on a real database: the checks
 * wait for concurrent writes on the server row, and a refused change never
 * reaches Swarm.
 */
import { db } from "@dokploy/server/db";
import {
	applications,
	compose,
	environments,
	projects,
	server,
	sshKeys,
} from "@dokploy/server/db/schema";
import { eq } from "drizzle-orm";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { serverRouter } from "@/server/api/routers/server";
import {
	contextOf,
	createOrganization,
	type Person,
	removeCreatedRows,
} from "./fixtures";

const swarm = vi.hoisted(() => ({ configure: vi.fn() }));
vi.mock("@dokploy/server/services/preview-worker", () => ({
	configurePreviewWorker: swarm.configure,
	PREVIEW_NODE_LABEL: "com.dokploy.preview-only",
	REGULAR_NODE_CONSTRAINT: "node.labels.com.dokploy.preview-only!=true",
}));

type Context = Parameters<typeof serverRouter.createCaller>[0];

let owner: Person;
let workerId: string;
let managerId: string;
let environmentId: string;
let sourceId: string;
const caller = () =>
	serverRouter.createCaller(contextOf(owner) as unknown as Context);
const policy = (previewOnly: boolean) =>
	caller().updatePreviewPolicy({
		serverId: workerId,
		previewOnly,
		swarmManagerId: null,
		previewCapacity: 3,
	});
const reservation = async () =>
	(await db.query.server.findFirst({ where: eq(server.serverId, workerId) }))
		?.previewOnly;

beforeAll(async () => {
	owner = await createOrganization("preview-policy");
	const [worker] = await db
		.insert(server)
		.values({
			name: "worker",
			ipAddress: "100.64.0.30",
			port: 2222,
			createdAt: new Date().toISOString(),
			organizationId: owner.organizationId,
		})
		.returning();
	workerId = worker!.serverId;
	const [key] = await db
		.insert(sshKeys)
		.values({
			name: "manager",
			publicKey: "ssh-ed25519 AAAA manager",
			organizationId: owner.organizationId,
		})
		.returning();
	const [manager] = await db
		.insert(server)
		.values({
			name: "manager",
			ipAddress: "100.64.0.31",
			port: 22,
			createdAt: new Date().toISOString(),
			organizationId: owner.organizationId,
			sshKeyId: key!.sshKeyId,
		})
		.returning();
	managerId = manager!.serverId;
	const [project] = await db
		.insert(projects)
		.values({ name: "policy", organizationId: owner.organizationId })
		.returning();
	const [environment] = await db
		.insert(environments)
		.values({ name: "production", projectId: project!.projectId })
		.returning();
	environmentId = environment!.environmentId;
	const [source] = await db
		.insert(compose)
		.values({ name: "source", environmentId })
		.returning();
	sourceId = source!.composeId;
});

afterAll(async () => {
	await db.delete(compose).where(eq(compose.previewParentId, sourceId));
	await db.delete(applications).where(eq(applications.serverId, workerId));
	await db.delete(server).where(eq(server.serverId, workerId));
	await db.delete(server).where(eq(server.serverId, managerId));
	await removeCreatedRows();
});

beforeEach(() => {
	swarm.configure.mockReset();
	swarm.configure.mockResolvedValue("node-1");
});

describe("preview worker reservation", () => {
	it("waits for a concurrent service creation, then sees it and refuses", async () => {
		let commit!: () => void;
		const held = new Promise<void>((resolve) => {
			commit = resolve;
		});
		let inserted!: () => void;
		const ready = new Promise<void>((resolve) => {
			inserted = resolve;
		});
		// An application creation on this server, not committed yet: its
		// foreign key holds FOR KEY SHARE on the server row.
		const creation = db.transaction(async (tx) => {
			await tx
				.insert(applications)
				.values({ name: "racing", environmentId, serverId: workerId });
			inserted();
			await held;
		});
		await ready;
		let settled = false;
		const attempt = policy(true).finally(() => {
			settled = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 500));
		// The policy update waits on the server row lock instead of checking
		// a state that is about to change.
		expect(settled).toBe(false);
		commit();
		await creation;
		await expect(attempt).rejects.toThrow("Move regular services");
		expect(swarm.configure).not.toHaveBeenCalled();
		expect(await reservation()).toBe(false);
		await db.delete(applications).where(eq(applications.serverId, workerId));
	});

	it("refuses to reserve a server that runs regular services, before Swarm", async () => {
		const [app] = await db
			.insert(applications)
			.values({ name: "web", environmentId, serverId: workerId })
			.returning();
		await expect(policy(true)).rejects.toThrow(
			"Move regular services before reserving",
		);
		expect(swarm.configure).not.toHaveBeenCalled();
		expect(await reservation()).toBe(false);
		await db
			.delete(applications)
			.where(eq(applications.applicationId, app!.applicationId));
	});

	it("reserves an empty server", async () => {
		await policy(true);
		expect(swarm.configure).toHaveBeenCalledWith(workerId, null, true);
		expect(await reservation()).toBe(true);
	});

	it("refuses to release a server while PR code runs on it, before Swarm", async () => {
		const [child] = await db
			.insert(compose)
			.values({
				name: "source · PR #1",
				environmentId,
				serverId: workerId,
				previewParentId: sourceId,
			})
			.returning();
		await expect(policy(false)).rejects.toThrow(
			"Remove the PR environments running on this server",
		);
		expect(swarm.configure).not.toHaveBeenCalled();
		expect(await reservation()).toBe(true);
		await db.delete(compose).where(eq(compose.composeId, child!.composeId));
	});

	it("refuses to change managers while PR code runs, before Swarm", async () => {
		const [child] = await db
			.insert(compose)
			.values({
				name: "source · PR #2",
				environmentId,
				serverId: workerId,
				previewParentId: sourceId,
			})
			.returning();
		await expect(
			caller().updatePreviewPolicy({
				serverId: workerId,
				previewOnly: true,
				swarmManagerId: managerId,
				previewCapacity: 3,
			}),
		).rejects.toThrow("Remove active previews before changing managers");
		expect(swarm.configure).not.toHaveBeenCalled();
		await db.delete(compose).where(eq(compose.composeId, child!.composeId));
	});

	it("saves nothing when Swarm refuses the change", async () => {
		swarm.configure.mockRejectedValue(new Error("node is not ready"));
		await expect(policy(false)).rejects.toThrow("node is not ready");
		expect(await reservation()).toBe(true);
	});

	it("releases the server once it is empty", async () => {
		await policy(false);
		expect(swarm.configure).toHaveBeenCalledWith(workerId, null, false);
		expect(await reservation()).toBe(false);
	});
});
