/**
 * Reserving and releasing a preview worker, on a real database: every check
 * runs under the server row lock, and a refused change never reaches Swarm.
 */
import { db } from "@dokploy/server/db";
import {
	applications,
	compose,
	environments,
	projects,
	server,
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
	await removeCreatedRows();
});

beforeEach(() => {
	swarm.configure.mockReset();
	swarm.configure.mockResolvedValue("node-1");
});

describe("preview worker reservation", () => {
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

	it("rolls back when Swarm refuses the change", async () => {
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
