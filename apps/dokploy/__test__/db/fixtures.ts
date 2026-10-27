import { randomUUID } from "node:crypto";
import { db } from "@dokploy/server/db";
import {
	githubRunnerNodes,
	githubRunnerPools,
	member,
	organization,
	user,
} from "@dokploy/server/db/schema";
import { inArray } from "drizzle-orm";

export type Role = "owner" | "admin" | "member";

export interface Person {
	userId: string;
	email: string;
	organizationId: string;
	role: Role;
}

/** Rows of every file get their own ids, so files never share or delete each other's rows. */
const createdUsers: string[] = [];

const createUser = async (label: string) => {
	const id = `user-${label}-${randomUUID().slice(0, 8)}`;
	await db.insert(user).values({
		id,
		email: `${id}@example.test`,
		emailVerified: true,
		updatedAt: new Date(),
	});
	createdUsers.push(id);
	return id;
};

/** An organization and its owner. */
export const createOrganization = async (label: string): Promise<Person> => {
	const ownerId = await createUser(`${label}-owner`);
	const organizationId = `org-${label}-${randomUUID().slice(0, 8)}`;
	await db.insert(organization).values({
		id: organizationId,
		name: label,
		createdAt: new Date(),
		ownerId,
	});
	await db.insert(member).values({
		organizationId,
		userId: ownerId,
		role: "owner",
		createdAt: new Date(),
	});
	return {
		userId: ownerId,
		email: `${ownerId}@example.test`,
		organizationId,
		role: "owner",
	};
};

/** Another user of the organization, with a static role. */
export const addMember = async (
	organizationId: string,
	role: Role,
): Promise<Person> => {
	const userId = await createUser(role);
	await db
		.insert(member)
		.values({ organizationId, userId, role, createdAt: new Date() });
	return {
		userId,
		email: `${userId}@example.test`,
		organizationId,
		role,
	};
};

/** Users go with their organizations, pools, machines and firewalls (cascade). */
export const removeCreatedRows = async () => {
	if (createdUsers.length) {
		await db.delete(user).where(inArray(user.id, createdUsers.splice(0)));
	}
};

/** A repository pool, without credentials: nothing here calls GitHub. */
export const insertPool = async (organizationId: string, name: string) => {
	const [pool] = await db
		.insert(githubRunnerPools)
		.values({
			organizationId,
			name,
			scope: "repository",
			owner: "example",
			repository: "ci",
			authType: "token",
			labels: ["dokploy-db-test"],
			routingVariable: null,
		})
		.returning();
	if (!pool) throw new Error("pool not created");
	return pool;
};

export const insertNode = async (
	pool: { githubRunnerPoolId: string; organizationId: string },
	name: string,
	values: Partial<typeof githubRunnerNodes.$inferInsert> = {},
) => {
	const [node] = await db
		.insert(githubRunnerNodes)
		.values({
			githubRunnerPoolId: pool.githubRunnerPoolId,
			organizationId: pool.organizationId,
			name,
			host: "192.0.2.10",
			username: "dokploy-manager",
			platform: "linux",
			...values,
		})
		.returning();
	if (!node) throw new Error("machine not created");
	return node;
};

/** The tRPC context a signed-in request gets, for routers' createCaller. */
export const contextOf = (
	person: Person,
	organizationId = person.organizationId,
) => ({
	db,
	req: {},
	res: {},
	session: {
		id: `session-${person.userId}`,
		userId: person.userId,
		token: randomUUID(),
		expiresAt: new Date(Date.now() + 3_600_000),
		createdAt: new Date(),
		updatedAt: new Date(),
		activeOrganizationId: organizationId,
	},
	user: {
		id: person.userId,
		email: person.email,
		name: person.email,
		emailVerified: true,
		createdAt: new Date(),
		updatedAt: new Date(),
		role: person.role,
		ownerId: person.userId,
		enableEnterpriseFeatures: false,
		isValidEnterpriseLicense: false,
	},
});

/** The Postgres error code under drizzle's wrapper, or null when it went through. */
export const pgErrorCode = async (query: PromiseLike<unknown>) => {
	try {
		await query;
		return null;
	} catch (error) {
		const cause = (error as { cause?: { code?: string } }).cause;
		return cause?.code ?? (error as { code?: string }).code ?? "unknown";
	}
};
