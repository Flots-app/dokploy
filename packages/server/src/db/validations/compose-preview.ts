import { z } from "zod";

export const composePreviewSettingsSchema = z.object({
	enabled: z.boolean().default(false),
	serverId: z.string().min(1),
	registryId: z.string().min(1),
	baseBranch: z.string().min(1).max(255),
	composePath: z
		.string()
		.min(1)
		.refine(
			(path) =>
				!path.startsWith("/") &&
				!path.startsWith("~") &&
				!path.includes("\\") &&
				!path.includes("$") &&
				![...path].some((character) => character.charCodeAt(0) < 32) &&
				!path.split("/").includes(".."),
			"Use a path inside the repository",
		),
	limit: z.number().int().min(1).max(50).default(3),
	ttlHours: z.number().int().min(1).max(720).default(72),
	domain: z
		.string()
		.max(180)
		.toLowerCase()
		.regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/),
	https: z.boolean().default(true),
	certificateType: z.enum(["none", "letsencrypt"]).default("letsencrypt"),
	labels: z.array(z.string().min(1).max(100)).max(20).default([]),
	cpuLimit: z.number().min(0.1).max(64).default(2),
	memoryLimitMb: z.number().int().min(64).max(65536).default(1024),
});

export const apiUpdateComposePreviewSettings = z.object({
	composeId: z.string().min(1),
	settings: composePreviewSettingsSchema,
	env: z.string().max(200000),
	composeFile: z.string().max(500000).default(""),
});
