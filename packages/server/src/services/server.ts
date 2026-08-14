import { db } from "@dokploy/server/db";
import {
	type apiCreateServer,
	applications,
	compose,
	member,
	organization,
	server,
} from "@dokploy/server/db/schema";
import { hasValidLicense } from "@dokploy/server/services/proprietary/license-key";
import { TRPCError } from "@trpc/server";
import { and, eq, isNotNull, ne } from "drizzle-orm";
import type { z } from "zod";

export type Server = typeof server.$inferSelect;

export const createServer = async (
	input: z.infer<typeof apiCreateServer>,
	organizationId: string,
) => {
	const newServer = await db.transaction(async (tx) => {
		const currentDefault =
			input.serverType === "build"
				? await tx.query.server.findFirst({
						where: and(
							eq(server.organizationId, organizationId),
							eq(server.serverType, "build"),
							eq(server.isDefaultBuildServer, true),
						),
					})
				: null;

		return await tx
			.insert(server)
			.values({
				...input,
				organizationId,
				createdAt: new Date().toISOString(),
				isDefaultBuildServer:
					input.serverType === "build" &&
					Boolean(input.sshKeyId) &&
					!currentDefault,
			} as typeof server.$inferInsert)
			.returning()
			.then((value) => value[0]);
	});

	if (!newServer) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error creating the server",
		});
	}

	return newServer;
};

export const findServerById = async (serverId: string) => {
	const currentServer = await db.query.server.findFirst({
		where: eq(server.serverId, serverId),
		with: {
			deployments: true,
			sshKey: true,
		},
	});
	if (!currentServer) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Server not found",
		});
	}
	return currentServer;
};

/**
 * Removes the SSH private key material from a server record before it is sent
 * to a client. `findServerById` eagerly loads the `sshKey` relation (needed for
 * server-side SSH operations), but the private key must never leave the server:
 * no client feature consumes it, and returning it exposed it to any member with
 * only `server:read`. Server-side callers keep using `findServerById` directly.
 */
export const redactServerSshKey = <
	T extends { sshKey?: { privateKey: string } | null },
>(
	serverRecord: T,
): T => {
	if (!serverRecord.sshKey) {
		return serverRecord;
	}
	return {
		...serverRecord,
		sshKey: { ...serverRecord.sshKey, privateKey: "" },
	};
};

export const findServersByUserId = async (userId: string) => {
	const orgs = await db.query.organization.findMany({
		where: eq(organization.ownerId, userId),
		with: {
			servers: true,
		},
	});

	const servers = orgs.flatMap((org) => org.servers);

	return servers;
};

export const deleteServer = async (serverId: string) => {
	return await db.transaction(async (tx) => {
		const current = await tx.query.server.findFirst({
			where: eq(server.serverId, serverId),
		});
		if (!current) return undefined;

		if (current.serverType === "build" && current.isDefaultBuildServer) {
			const remaining = await tx.query.server.findMany({
				where: and(
					eq(server.organizationId, current.organizationId),
					eq(server.serverType, "build"),
					eq(server.serverStatus, "active"),
					isNotNull(server.sshKeyId),
					ne(server.serverId, serverId),
				),
			});
			if (remaining.length > 1) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message:
						"Select another default Build Server before deleting this one",
				});
			}
			if (remaining[0]) {
				await tx
					.update(server)
					.set({ isDefaultBuildServer: false })
					.where(eq(server.serverId, serverId));
				await tx
					.update(server)
					.set({ isDefaultBuildServer: true })
					.where(eq(server.serverId, remaining[0].serverId));
			}
		}

		await tx
			.update(applications)
			.set({
				buildServerId: null,
				buildRegistryId: null,
			})
			.where(eq(applications.buildServerId, serverId));

		await tx
			.update(compose)
			.set({
				buildServerId: null,
				buildRegistryId: null,
			})
			.where(eq(compose.buildServerId, serverId));

		return await tx
			.delete(server)
			.where(eq(server.serverId, serverId))
			.returning()
			.then((value) => value[0]);
	});
};

export const haveActiveServices = async (serverId: string) => {
	const currentServer = await db.query.server.findFirst({
		where: eq(server.serverId, serverId),
		with: {
			applications: true,
			buildApplications: true,
			compose: true,
			buildCompose: true,
			libsql: true,
			mariadb: true,
			mongo: true,
			mysql: true,
			postgres: true,
			redis: true,
		},
	});

	if (!currentServer) {
		return false;
	}

	const total =
		currentServer?.applications?.length +
		currentServer?.buildApplications?.length +
		currentServer?.compose?.length +
		currentServer?.buildCompose?.length +
		currentServer?.libsql?.length +
		currentServer?.mariadb?.length +
		currentServer?.mongo?.length +
		currentServer?.mysql?.length +
		currentServer?.postgres?.length +
		currentServer?.redis?.length;

	if (total === 0) {
		return false;
	}

	return true;
};

export const updateServerById = async (
	serverId: string,
	serverData: Partial<Server>,
) => {
	return await db.transaction(async (tx) => {
		const current = await tx.query.server.findFirst({
			where: eq(server.serverId, serverId),
			with: { buildApplications: true, buildCompose: true },
		});
		if (!current) return undefined;

		let isDefaultBuildServer = current.isDefaultBuildServer;
		const desiredServerType = serverData.serverType ?? current.serverType;
		const desiredServerStatus = serverData.serverStatus ?? current.serverStatus;
		const desiredSshKeyId =
			serverData.sshKeyId === undefined
				? current.sshKeyId
				: serverData.sshKeyId;
		const remainsEligibleBuildServer =
			desiredServerType === "build" &&
			desiredServerStatus === "active" &&
			Boolean(desiredSshKeyId);

		if (current.isDefaultBuildServer && !remainsEligibleBuildServer) {
			if (
				current.buildApplications.length > 0 ||
				current.buildCompose.length > 0
			) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message:
						"Reassign every Application and Compose using this Build Server before making it unavailable for builds",
				});
			}

			const remaining = await tx.query.server.findMany({
				where: and(
					eq(server.organizationId, current.organizationId),
					eq(server.serverType, "build"),
					eq(server.serverStatus, "active"),
					isNotNull(server.sshKeyId),
					ne(server.serverId, serverId),
				),
			});
			if (remaining.length > 1) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message:
						"Select another default Build Server before making this server unavailable for builds",
				});
			}
			if (remaining[0]) {
				await tx
					.update(server)
					.set({ isDefaultBuildServer: false })
					.where(eq(server.serverId, serverId));
				await tx
					.update(server)
					.set({ isDefaultBuildServer: true })
					.where(eq(server.serverId, remaining[0].serverId));
			}
			isDefaultBuildServer = false;
		} else if (
			!current.isDefaultBuildServer &&
			remainsEligibleBuildServer &&
			(current.serverType !== "build" ||
				current.serverStatus !== "active" ||
				!current.sshKeyId)
		) {
			const currentDefault = await tx.query.server.findFirst({
				where: and(
					eq(server.organizationId, current.organizationId),
					eq(server.serverType, "build"),
					eq(server.isDefaultBuildServer, true),
				),
			});
			isDefaultBuildServer = !currentDefault;
		}

		return await tx
			.update(server)
			.set({ ...serverData, isDefaultBuildServer })
			.where(eq(server.serverId, serverId))
			.returning()
			.then((res) => res[0]);
	});
};

export const findDefaultBuildServer = async (organizationId: string) => {
	return await db.query.server.findFirst({
		where: and(
			eq(server.organizationId, organizationId),
			eq(server.serverType, "build"),
			eq(server.serverStatus, "active"),
			isNotNull(server.sshKeyId),
			eq(server.isDefaultBuildServer, true),
		),
	});
};

export const setDefaultBuildServer = async (
	serverId: string,
	organizationId: string,
) => {
	return await db.transaction(async (tx) => {
		const selected = await tx.query.server.findFirst({
			where: and(
				eq(server.serverId, serverId),
				eq(server.organizationId, organizationId),
			),
		});
		if (!selected) {
			throw new TRPCError({ code: "NOT_FOUND", message: "Server not found" });
		}
		if (
			selected.serverType !== "build" ||
			selected.serverStatus !== "active" ||
			!selected.sshKeyId
		) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message:
					"The default Build Server must be active, accessible by SSH, and have serverType build",
			});
		}

		await tx
			.update(server)
			.set({ isDefaultBuildServer: false })
			.where(
				and(
					eq(server.organizationId, organizationId),
					eq(server.isDefaultBuildServer, true),
				),
			);
		return await tx
			.update(server)
			.set({ isDefaultBuildServer: true })
			.where(eq(server.serverId, serverId))
			.returning()
			.then((rows) => rows[0]);
	});
};

export const getAllServers = async () => {
	const servers = await db.query.server.findMany();
	return servers;
};

export const getAccessibleServerIds = async (session: {
	userId: string;
	activeOrganizationId: string;
}): Promise<Set<string>> => {
	const { userId, activeOrganizationId } = session;

	const allOrgServers = await db.query.server.findMany({
		where: eq(server.organizationId, activeOrganizationId),
		columns: {
			serverId: true,
		},
	});

	const memberRecord = await db.query.member.findFirst({
		where: and(
			eq(member.userId, userId),
			eq(member.organizationId, activeOrganizationId),
		),
		columns: { accessedServers: true, role: true },
	});

	if (memberRecord?.role === "owner" || memberRecord?.role === "admin") {
		return new Set(allOrgServers.map((s) => s.serverId));
	}

	const licensed = await hasValidLicense(activeOrganizationId);

	if (!licensed) {
		return new Set(allOrgServers.map((s) => s.serverId));
	}

	return new Set(memberRecord?.accessedServers ?? []);
};
