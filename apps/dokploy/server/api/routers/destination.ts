import {
	assertEncryptedDestinationStorageUnchanged,
	buildRcloneCommand,
	createDestination,
	execAsync,
	execAsyncRemote,
	execFileAsync,
	findDestinationById,
	getRcloneEnvironment,
	getRcloneExecOptions,
	getRcloneRemotePath,
	IS_CLOUD,
	redactDestinationEncryptionSecrets,
	redactRcloneCredentials,
	removeDestinationById,
	resolveDestinationEncryptionKeyMaterial,
	updateDestinationById,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import { TRPCError } from "@trpc/server";
import { desc, eq } from "drizzle-orm";
import { createTRPCRouter, withPermission } from "@/server/api/trpc";
import { audit } from "@/server/api/utils/audit";
import {
	apiCreateDestination,
	apiFindOneDestination,
	apiRemoveDestination,
	apiUpdateDestination,
	destinations,
} from "@/server/db/schema";

const getTargetServerId = (serverId?: string) =>
	serverId && serverId !== "none" ? serverId : undefined;

const obscureRclonePassword = async (password: string, serverId?: string) => {
	const input = `${password}\n`;
	const result = IS_CLOUD
		? await execAsyncRemote(
				serverId || "",
				"rclone obscure -",
				undefined,
				input,
			)
		: await execFileAsync("rclone", ["obscure", "-"], { input });
	const obscured = result.stdout.trim();

	if (!obscured) {
		throw new Error("rclone did not return an obscured password");
	}

	return obscured;
};

const prepareDestinationEncryptionSecrets = async (
	input: {
		encryptionEnabled: boolean;
		encryptionKeyManagement: "dokploy" | "customer";
		encryptionPassword?: string;
		encryptionPassword2?: string;
	},
	serverId?: string,
) => {
	const keyMaterial = resolveDestinationEncryptionKeyMaterial(input);
	if (!keyMaterial) {
		return {
			encryptionPassword: undefined,
			encryptionPassword2: undefined,
		};
	}

	return {
		encryptionPassword: await obscureRclonePassword(
			keyMaterial.password,
			serverId,
		),
		encryptionPassword2: keyMaterial.password2
			? await obscureRclonePassword(keyMaterial.password2, serverId)
			: undefined,
	};
};

export const destinationRouter = createTRPCRouter({
	create: withPermission("destination", "create")
		.input(apiCreateDestination)
		.mutation(async ({ input, ctx }) => {
			try {
				const serverId = getTargetServerId(input.serverId);
				if (IS_CLOUD && input.encryptionEnabled && !serverId) {
					throw new Error("A server is required to configure encryption");
				}
				const { encryptionPassword, encryptionPassword2 } =
					await prepareDestinationEncryptionSecrets(input, serverId);
				const result = await createDestination(
					{
						...input,
						serverId,
						encryptionPassword,
						encryptionPassword2,
						encryptionKeyManagement: input.encryptionEnabled
							? input.encryptionKeyManagement
							: "dokploy",
						encryptionDirectoryNames:
							input.encryptionFilenameMode === "off"
								? false
								: input.encryptionDirectoryNames,
					},
					ctx.session.activeOrganizationId,
				);
				await audit(ctx, {
					action: "create",
					resourceType: "destination",
					resourceId: result.destinationId,
					resourceName: input.name,
				});
				return redactDestinationEncryptionSecrets(result);
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error creating the destination",
					cause: error,
				});
			}
		}),
	testConnection: withPermission("destination", "create")
		.input(apiCreateDestination)
		.mutation(async ({ input }) => {
			try {
				const serverId = getTargetServerId(input.serverId);
				if (IS_CLOUD && !serverId) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "Server not found",
					});
				}
				const { encryptionPassword, encryptionPassword2 } =
					await prepareDestinationEncryptionSecrets(input, serverId);
				const destination = {
					...input,
					destinationId: "connection-test",
					encryptionPassword: encryptionPassword ?? null,
					encryptionPassword2: encryptionPassword2 ?? null,
				};
				const rcloneCommand = buildRcloneCommand(destination, [
					"ls",
					"--retries",
					"1",
					"--low-level-retries",
					"1",
					"--timeout",
					"10s",
					"--contimeout",
					"5s",
					getRcloneRemotePath(destination),
				]);

				if (IS_CLOUD) {
					await execAsyncRemote(
						serverId || "",
						rcloneCommand,
						undefined,
						undefined,
						getRcloneEnvironment(destination),
					);
				} else {
					await execAsync(rcloneCommand, getRcloneExecOptions(destination));
				}
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message:
						error instanceof Error
							? redactRcloneCredentials(error.message)
							: "Error connecting to bucket",
					cause: new Error(redactRcloneCredentials(String(error))),
				});
			}
		}),
	one: withPermission("destination", "read")
		.input(apiFindOneDestination)
		.query(async ({ input, ctx }) => {
			const destination = await findDestinationById(input.destinationId);
			if (destination.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not allowed to access this destination",
				});
			}
			return redactDestinationEncryptionSecrets(destination);
		}),
	all: withPermission("destination", "read").query(async ({ ctx }) => {
		const results = await db.query.destinations.findMany({
			where: eq(destinations.organizationId, ctx.session.activeOrganizationId),
			orderBy: [desc(destinations.createdAt)],
		});
		return results.map(redactDestinationEncryptionSecrets);
	}),
	remove: withPermission("destination", "delete")
		.input(apiRemoveDestination)
		.mutation(async ({ input, ctx }) => {
			try {
				const destination = await findDestinationById(input.destinationId);

				if (destination.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not allowed to delete this destination",
					});
				}
				const result = await removeDestinationById(
					input.destinationId,
					ctx.session.activeOrganizationId,
				);
				await audit(ctx, {
					action: "delete",
					resourceType: "destination",
					resourceId: input.destinationId,
					resourceName: destination.name,
				});
				return result ? redactDestinationEncryptionSecrets(result) : undefined;
			} catch (error) {
				throw error;
			}
		}),
	update: withPermission("destination", "create")
		.input(apiUpdateDestination)
		.mutation(async ({ input, ctx }) => {
			try {
				const destination = await findDestinationById(input.destinationId);
				if (destination.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not allowed to update this destination",
					});
				}
				assertEncryptedDestinationStorageUnchanged(destination, input);
				const result = await updateDestinationById(input.destinationId, {
					...input,
					organizationId: ctx.session.activeOrganizationId,
				});
				await audit(ctx, {
					action: "update",
					resourceType: "destination",
					resourceId: input.destinationId,
					resourceName: input.name,
				});
				return result ? redactDestinationEncryptionSecrets(result) : undefined;
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message:
						error instanceof Error
							? error?.message
							: "Error connecting to bucket",
					cause: error,
				});
			}
		}),
});
