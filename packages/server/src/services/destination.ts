import { db } from "@dokploy/server/db";
import {
	type apiCreateDestination,
	destinations,
} from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";

export type Destination = typeof destinations.$inferSelect;

export const redactDestinationEncryptionSecrets = <T extends Destination>(
	destination: T,
) => ({
	...destination,
	encryptionPassword: null,
	encryptionPassword2: null,
});

type DestinationStorageIdentity = Pick<
	Destination,
	"additionalFlags" | "bucket" | "endpoint" | "provider" | "region"
>;

export const assertEncryptedDestinationStorageUnchanged = (
	current: DestinationStorageIdentity & Pick<Destination, "encryptionEnabled">,
	next: DestinationStorageIdentity,
) => {
	if (!current.encryptionEnabled) return;

	const fields = [
		"provider",
		"bucket",
		"region",
		"endpoint",
		"additionalFlags",
	] as const;
	const changedFields = fields.filter((field) => {
		if (field === "additionalFlags") {
			return (
				JSON.stringify(current.additionalFlags ?? []) !==
				JSON.stringify(next.additionalFlags ?? [])
			);
		}
		return (current[field] ?? "") !== (next[field] ?? "");
	});

	if (changedFields.length > 0) {
		throw new Error(
			`Encrypted destination storage settings are immutable: ${changedFields.join(", ")}`,
		);
	}
};

export const createDestination = async (
	input: z.infer<typeof apiCreateDestination>,
	organizationId: string,
) => {
	const { serverId: _serverId, ...destination } = input;
	const newDestination = await db
		.insert(destinations)
		.values({
			...destination,
			organizationId: organizationId,
		})
		.returning()
		.then((value) => value[0]);

	if (!newDestination) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error input: Inserting destination",
		});
	}

	return newDestination;
};

export const findDestinationById = async (destinationId: string) => {
	const destination = await db.query.destinations.findFirst({
		where: and(eq(destinations.destinationId, destinationId)),
	});
	if (!destination) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Destination not found",
		});
	}
	return destination;
};

export const removeDestinationById = async (
	destinationId: string,
	organizationId: string,
) => {
	const result = await db
		.delete(destinations)
		.where(
			and(
				eq(destinations.destinationId, destinationId),
				eq(destinations.organizationId, organizationId),
			),
		)
		.returning();

	return result[0];
};

export const updateDestinationById = async (
	destinationId: string,
	destinationData: Partial<Destination>,
) => {
	const result = await db
		.update(destinations)
		.set({
			...destinationData,
		})
		.where(
			and(
				eq(destinations.destinationId, destinationId),
				eq(destinations.organizationId, destinationData.organizationId || ""),
			),
		)
		.returning();

	return result[0];
};
