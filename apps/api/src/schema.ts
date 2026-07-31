import { z } from "zod";

export const deployJobSchema = z.discriminatedUnion("applicationType", [
	z.object({
		applicationId: z.string(),
		titleLog: z.string().optional(),
		descriptionLog: z.string().optional(),
		server: z.boolean().optional(),
		type: z.enum(["deploy", "redeploy"]),
		applicationType: z.literal("application"),
		serverId: z.string().min(1),
		// Build Server chosen for this deployment. Absent keeps the one
		// configured on the application, null builds on the deploy server.
		buildServerId: z.string().min(1).nullable().optional(),
	}),
	z.object({
		composeId: z.string(),
		titleLog: z.string().optional(),
		descriptionLog: z.string().optional(),
		server: z.boolean().optional(),
		type: z.enum(["deploy", "redeploy"]),
		applicationType: z.literal("compose"),
		serverId: z.string().min(1),
	}),
	z.object({
		applicationId: z.string(),
		previewDeploymentId: z.string(),
		titleLog: z.string().optional(),
		descriptionLog: z.string().optional(),
		server: z.boolean().optional(),
		type: z.enum(["deploy", "redeploy"]),
		applicationType: z.literal("application-preview"),
		serverId: z.string().min(1),
	}),
]);

export type DeployJob = z.infer<typeof deployJobSchema>;

/**
 * Machine that actually runs the build: the Build Server picked for this
 * deployment when there is one, otherwise the deploy server. Deployments are
 * serialized against this machine, so one Build Server shared by several deploy
 * servers still honours a single concurrency limit.
 */
export const getBuildTargetId = (job: DeployJob): string =>
	(job.applicationType === "application" ? job.buildServerId : null) ??
	job.serverId;

export const cancelDeploymentSchema = z.discriminatedUnion("applicationType", [
	z.object({
		applicationId: z.string(),
		applicationType: z.literal("application"),
	}),
	z.object({
		composeId: z.string(),
		applicationType: z.literal("compose"),
	}),
]);

export type CancelDeploymentJob = z.infer<typeof cancelDeploymentSchema>;
