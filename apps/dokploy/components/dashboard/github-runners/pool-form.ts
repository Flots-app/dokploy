import { updatePolicySchema } from "@dokploy/server/utils/github-runners/updates";
import { z } from "zod";
import { parseLabels } from "./budget-values";
import type { RunnerPool } from "./format";

// Fields shown only for some scopes or authentication methods, and the
// collapsed advanced settings, are unmounted and then read as undefined.
const optional = z.string().trim().optional();

export const poolFormSchema = z
	.object({
		name: z.string().trim().min(1, "Name is required").max(64),
		description: z.string().max(500).optional(),
		scope: z.enum(["organization", "repository"]),
		owner: z.string().trim().min(1, "Enter the organization or owner"),
		repository: optional,
		runnerGroup: optional,
		labels: z.string(),
		authType: z.enum(["token", "app", "provider"]),
		token: optional,
		appId: z.string().regex(/^\d*$/, "Digits only").optional(),
		appPrivateKey: optional,
		githubId: optional,
		runnerVersion: z
			.string()
			.trim()
			.regex(
				/^(\d+\.\d+\.\d+)?$/,
				"Use a version such as 2.329.0, or leave empty",
			)
			.optional(),
		apiUrl: z.string().trim().url().optional(),
		runnerEnv: z.string().optional(),
		jobStartedHook: optional,
		jobCompletedHook: optional,
		rerunInterruptedJobs: z.boolean().optional(),
		routingEnabled: z.boolean(),
		routingVariable: z
			.string()
			.trim()
			.regex(
				/^[A-Za-z_][A-Za-z0-9_]*$/,
				"Letters, digits and underscores, not starting with a digit",
			)
			.refine((name) => !/^github_/i.test(name), "Cannot start with GITHUB_"),
		fallbackLabels: z.string(),
		placement: z.enum(["fastest", "spread"]),
		updatePolicy: updatePolicySchema,
		rolloutPolicy: z.object({
			maxUnavailable: z.number().int().min(1).max(32),
			canary: z.boolean(),
		}),
		autonomyReserve: z.number().int().min(0).max(10),
	})
	.refine((value) => value.scope === "organization" || value.repository, {
		path: ["repository"],
		message: "Repository is required",
	})
	.refine(
		(value) => !value.routingEnabled || parseLabels(value.labels).length > 0,
		{
			path: ["labels"],
			message: "The fallback needs a label to tell this pool's jobs apart",
		},
	);

export type PoolFormValues = z.infer<typeof poolFormSchema>;

export const poolFormDefaults = (pool?: RunnerPool): PoolFormValues => ({
	name: pool?.name ?? "",
	description: pool?.description ?? "",
	scope: pool?.scope ?? "organization",
	owner: pool?.owner ?? "",
	repository: pool?.repository ?? "",
	runnerGroup: pool?.runnerGroup ?? "Default",
	labels: pool?.labels.join(", ") ?? "",
	// A token is the quickest way in; an App is offered next to it.
	authType: pool?.authType ?? "token",
	token: "",
	appId: pool?.appId ? String(pool.appId) : "",
	appPrivateKey: "",
	githubId: pool?.githubId ?? "",
	runnerVersion: pool?.runnerVersion ?? "",
	apiUrl: pool?.apiUrl ?? "https://api.github.com",
	runnerEnv: "",
	jobStartedHook: pool?.jobStartedHook ?? "",
	jobCompletedHook: pool?.jobCompletedHook ?? "",
	rerunInterruptedJobs: pool?.rerunInterruptedJobs ?? true,
	// New pools send their jobs to GitHub-hosted runners when no machine is ON.
	routingEnabled: pool ? Boolean(pool.routingVariable) : true,
	routingVariable: pool?.routingVariable ?? "DOKPLOY_RUNS_ON",
	fallbackLabels: (pool?.fallbackLabels ?? ["ubuntu-24.04"]).join(", "),
	placement: pool?.placement ?? "fastest",
	updatePolicy: pool?.updatePolicy ?? { auto: true, window: null },
	rolloutPolicy: pool?.rolloutPolicy ?? { maxUnavailable: 1, canary: true },
	autonomyReserve: pool?.autonomyReserve ?? 2,
});

/** Undefined (an unmounted field) keeps the stored value; empty clears it. */
const keepOr = <T>(value: string | undefined, stored: T | null | undefined) =>
	value === undefined ? (stored ?? null) : value || null;

export const toPoolInput = (values: PoolFormValues, pool?: RunnerPool) => ({
	name: values.name,
	description: values.description || null,
	scope: values.scope,
	owner: values.owner,
	repository: values.scope === "repository" ? values.repository || null : null,
	runnerGroup:
		values.scope === "organization"
			? values.runnerGroup || "Default"
			: "Default",
	labels: parseLabels(values.labels),
	apiUrl: values.apiUrl || pool?.apiUrl || "https://api.github.com",
	authType: values.authType,
	// Secrets are never sent back: an empty field keeps the stored one.
	token: values.authType === "token" ? values.token || null : null,
	appId:
		values.authType === "app" && values.appId ? Number(values.appId) : null,
	// Dokploy finds the installation of the App on the owner by itself.
	appInstallationId: null,
	appPrivateKey:
		values.authType === "app" ? values.appPrivateKey || null : null,
	githubId: values.authType === "provider" ? values.githubId || null : null,
	runnerVersion: keepOr(values.runnerVersion, pool?.runnerVersion),
	runnerEnv: values.runnerEnv ?? "",
	jobStartedHook: keepOr(values.jobStartedHook, pool?.jobStartedHook),
	jobCompletedHook: keepOr(values.jobCompletedHook, pool?.jobCompletedHook),
	rerunInterruptedJobs: values.rerunInterruptedJobs ?? true,
	routingVariable: values.routingEnabled ? values.routingVariable : null,
	placement: values.placement,
	updatePolicy: values.updatePolicy,
	rolloutPolicy: values.rolloutPolicy,
	autonomyReserve: values.autonomyReserve,
	fallbackLabels: parseLabels(values.fallbackLabels).length
		? parseLabels(values.fallbackLabels)
		: ["ubuntu-24.04"],
});
