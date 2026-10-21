import { TRPCError } from "@trpc/server";

/**
 * Drizzle query errors carry the SQL and its parameters, encrypted secrets
 * included. Matched by shape: the app and the server package may load
 * separate copies of drizzle-orm.
 */
const isDatabaseError = (
	error: unknown,
): error is Error & { cause?: { code?: string } } =>
	error instanceof Error && "query" in error && "params" in error;

/**
 * The error a runner procedure returns to the browser. Database errors are
 * logged here and never sent: only a unique violation is worth explaining.
 */
export const toClientError = (error: unknown): TRPCError => {
	if (error instanceof TRPCError) return error;
	if (isDatabaseError(error)) {
		console.error("GitHub runners: database error", error.cause);
		return error.cause?.code === "23505"
			? new TRPCError({
					code: "CONFLICT",
					message: "This name is already used in the organization",
				})
			: new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message: "The change could not be saved",
				});
	}
	return new TRPCError({
		code: "BAD_REQUEST",
		message: error instanceof Error ? error.message : String(error),
	});
};
