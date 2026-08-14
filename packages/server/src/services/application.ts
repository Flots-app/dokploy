import { docker } from "@dokploy/server/constants";
import { db } from "@dokploy/server/db";
import {
	type apiCreateApplication,
	applications,
	buildAppName,
} from "@dokploy/server/db/schema";
import { getAdvancedStats } from "@dokploy/server/monitoring/utils";
import {
	getBuildCommand,
	mechanizeDockerContainer,
} from "@dokploy/server/utils/builders";
import {
	APPLICATION_STABILIZATION_SECONDS,
	assertApplicationBuildServerDeploymentReady,
	assertApplicationBuildServerSelection,
	assertApplicationRuntimeServerSelection,
	getApplicationBuildPushCommand,
	getApplicationCancellationCheckCommand,
	getApplicationCancellationPath,
	getApplicationCancellationRequestCommand,
	getApplicationDeploymentImage,
	getApplicationRuntimePullCommand,
	getCancellableApplicationCommand,
	getRollbackApplicationServiceCommand,
	getWaitApplicationServiceCommand,
} from "@dokploy/server/utils/builders/application-build-server";
import {
	getComposeRegistryLoginCommand,
	normalizeDockerPlatform,
} from "@dokploy/server/utils/builders/compose-build-server";
import { getDockerCommand } from "@dokploy/server/utils/builders/docker-file";
import { sendBuildErrorNotifications } from "@dokploy/server/utils/notifications/build-error";
import { sendBuildSuccessNotifications } from "@dokploy/server/utils/notifications/build-success";
import {
	ExecError,
	execAsync,
	execAsyncRemote,
	execFileAsync,
} from "@dokploy/server/utils/process/execAsync";
import { cloneBitbucketRepository } from "@dokploy/server/utils/providers/bitbucket";
import { buildRemoteDocker } from "@dokploy/server/utils/providers/docker";
import {
	cloneGitRepository,
	getGitCommitInfo,
} from "@dokploy/server/utils/providers/git";
import { cloneGiteaRepository } from "@dokploy/server/utils/providers/gitea";
import { cloneGithubRepository } from "@dokploy/server/utils/providers/github";
import { cloneGitlabRepository } from "@dokploy/server/utils/providers/gitlab";
import { createTraefikConfig } from "@dokploy/server/utils/traefik/application";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { quote } from "shell-quote";
import type { z } from "zod";
import { encodeBase64 } from "../utils/docker/utils";
import { getDokployUrl } from "./admin";
import {
	createDeployment,
	createDeploymentPreview,
	findDeploymentById,
	updateDeployment,
	updateDeploymentStatus,
} from "./deployment";
import { type Domain, getDomainHost } from "./domain";
import {
	createPreviewDeploymentComment,
	getIssueComment,
	issueCommentExists,
	updateIssueComment,
} from "./github";
import { generateApplyPatchesCommand } from "./patch";
import {
	findPreviewDeploymentById,
	updatePreviewDeployment,
} from "./preview-deployment";
import { validUniqueServerAppName } from "./project";
import { findRegistryByIdWithCredentials } from "./registry";
import { findDefaultBuildServer } from "./server";
export type Application = typeof applications.$inferSelect;

export const createApplication = async (
	input: z.infer<typeof apiCreateApplication> & { buildServerId: string },
) => {
	const appName = buildAppName("app", input.appName);

	const valid = await validUniqueServerAppName(appName);
	if (!valid) {
		throw new TRPCError({
			code: "CONFLICT",
			message: "Application with this 'AppName' already exists",
		});
	}

	return await db.transaction(async (tx) => {
		const newApplication = await tx
			.insert(applications)
			.values({
				...input,
				appName,
			})
			.returning()
			.then((value) => value[0]);

		if (!newApplication) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error creating the application",
			});
		}

		if (process.env.NODE_ENV === "development") {
			createTraefikConfig(newApplication.appName);
		}

		return newApplication;
	});
};

export const findApplicationById = async (applicationId: string) => {
	const application = await db.query.applications.findFirst({
		where: eq(applications.applicationId, applicationId),
		with: {
			environment: { with: { project: true } },
			domains: true,
			deployments: true,
			mounts: true,
			redirects: true,
			security: true,
			ports: true,
			gitlab: {
				columns: { secret: false, accessToken: false, refreshToken: false },
			},
			github: {
				columns: {
					githubClientSecret: false,
					githubPrivateKey: false,
					githubWebhookSecret: false,
				},
			},
			bitbucket: { columns: { appPassword: false, apiToken: false } },
			gitea: {
				columns: {
					clientSecret: false,
					accessToken: false,
					refreshToken: false,
				},
			},
			server: true,
			buildServer: true,
			previewDeployments: true,
			registry: { columns: { password: false } },
			buildRegistry: { columns: { password: false } },
			rollbackRegistry: { columns: { password: false } },
		},
	});
	if (!application) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Application not found",
		});
	}
	return application;
};

export const ensureApplicationBuildServer = async (applicationId: string) => {
	let application = await findApplicationById(applicationId);
	const organizationId = application.environment.project.organizationId;
	if (!application.buildServerId) {
		const defaultBuildServer = await findDefaultBuildServer(organizationId);
		if (!defaultBuildServer) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message:
					"No default Build Server is available. Create an active Build Server or select a default before building this Application.",
			});
		}
		await updateApplication(applicationId, {
			buildServerId: defaultBuildServer.serverId,
		});
		application = await findApplicationById(applicationId);
	}

	try {
		assertApplicationBuildServerSelection({
			organizationId,
			server: application.buildServer,
		});
	} catch (error) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				error instanceof Error
					? error.message
					: "Invalid Application Build Server",
		});
	}
	return application;
};

export const findApplicationByName = async (appName: string) => {
	const application = await db.query.applications.findFirst({
		where: eq(applications.appName, appName),
	});

	return application;
};

export const updateApplication = async (
	applicationId: string,
	applicationData: Partial<Application>,
) => {
	const { appName, ...rest } = applicationData;
	const application = await db
		.update(applications)
		.set({
			...rest,
		})
		.where(eq(applications.applicationId, applicationId))
		.returning();

	return application[0];
};

export const updateApplicationStatus = async (
	applicationId: string,
	applicationStatus: Application["applicationStatus"],
) => {
	const application = await db
		.update(applications)
		.set({
			applicationStatus: applicationStatus,
		})
		.where(eq(applications.applicationId, applicationId))
		.returning();

	return application;
};

const applicationDeploymentWasCancelled = async (
	deploymentId: string,
	error: unknown,
) => {
	if (
		error instanceof ExecError &&
		(error.exitCode === 130 ||
			`${error.stdout || ""}${error.stderr || ""}`.includes(
				"Application deployment cancellation requested",
			))
	) {
		return true;
	}
	try {
		return (await findDeploymentById(deploymentId)).status === "cancelled";
	} catch {
		return false;
	}
};

const appendApplicationDeploymentLog = async (
	buildServerId: string,
	logPath: string,
	content: string,
) => {
	if (!content) return;
	await execAsyncRemote(
		buildServerId,
		`printf %s ${quote([encodeBase64(content)])} | base64 -d >> ${quote([
			logPath,
		])}`,
	);
};

const executeApplicationRuntimeCommand = async (
	serverId: string | null,
	command: string,
) => (serverId ? execAsyncRemote(serverId, command) : execAsync(command));

const runApplicationBuildStage = async (
	buildServerId: string,
	logPath: string,
	stage: string,
	command: string,
	cancellationPath: string,
) => {
	await appendApplicationDeploymentLog(
		buildServerId,
		logPath,
		`\n===== ${stage} =====\n`,
	);
	return await execAsyncRemote(
		buildServerId,
		`(${getCancellableApplicationCommand(
			command,
			cancellationPath,
		)}) >> ${quote([logPath])} 2>&1`,
	);
};

const runApplicationRuntimeStage = async (
	runtimeServerId: string | null,
	buildServerId: string,
	logPath: string,
	stage: string,
	command: string,
	cancellationPath?: string,
) => {
	await appendApplicationDeploymentLog(
		buildServerId,
		logPath,
		`\n===== ${stage} =====\n`,
	);
	try {
		const result = await executeApplicationRuntimeCommand(
			runtimeServerId,
			cancellationPath
				? getCancellableApplicationCommand(command, cancellationPath)
				: command,
		);
		await appendApplicationDeploymentLog(
			buildServerId,
			logPath,
			`${result.stdout}${result.stderr}`,
		);
		return result;
	} catch (error) {
		if (error instanceof ExecError) {
			await appendApplicationDeploymentLog(
				buildServerId,
				logPath,
				`${error.stdout || ""}${error.stderr || ""}`,
			);
		}
		throw error;
	}
};

const loginApplicationRegistry = async (
	serverId: string | null,
	registry: Awaited<ReturnType<typeof findRegistryByIdWithCredentials>>,
) => {
	if (serverId) {
		return await execAsyncRemote(
			serverId,
			getComposeRegistryLoginCommand(registry),
			undefined,
			registry.password,
		);
	}
	return await execFileAsync(
		"docker",
		[
			"login",
			...(registry.registryUrl ? [registry.registryUrl] : []),
			"--username",
			registry.username,
			"--password-stdin",
		],
		{
			input: registry.password,
			env: { ...process.env, HOME: process.env.HOME },
		},
	);
};

const loginApplicationRegistryWithLog = async (
	serverId: string | null,
	buildServerId: string,
	logPath: string,
	registry: Awaited<ReturnType<typeof findRegistryByIdWithCredentials>>,
) => {
	try {
		const result = await loginApplicationRegistry(serverId, registry);
		await appendApplicationDeploymentLog(
			buildServerId,
			logPath,
			`${result.stdout}${result.stderr}`,
		);
		return result;
	} catch (error) {
		if (error instanceof ExecError) {
			await appendApplicationDeploymentLog(
				buildServerId,
				logPath,
				`${error.stdout || ""}${error.stderr || ""}`,
			);
		}
		throw error;
	}
};

const inspectApplicationDockerPlatform = async (
	serverId: string | null,
	role: "Build Server" | "Deploy Server",
) => {
	try {
		const result = await executeApplicationRuntimeCommand(
			serverId,
			"docker info --format '{{.OSType}}/{{.Architecture}}'",
		);
		const platform = normalizeDockerPlatform(result.stdout.trim());
		if (!platform) throw new Error("docker info returned an empty platform");
		return platform;
	} catch (error) {
		throw new Error(
			`Unable to determine the ${role} Docker platform: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
};

const getApplicationCloneCommand = async (
	application: Awaited<ReturnType<typeof findApplicationById>>,
) => {
	if (application.sourceType === "github") {
		return await cloneGithubRepository(application);
	}
	if (application.sourceType === "gitlab") {
		return await cloneGitlabRepository(application);
	}
	if (application.sourceType === "gitea") {
		return await cloneGiteaRepository(application);
	}
	if (application.sourceType === "bitbucket") {
		return await cloneBitbucketRepository(application);
	}
	if (application.sourceType === "git") {
		return await cloneGitRepository(application);
	}
	throw new Error("Dockerfile Build Server source is not Git-backed");
};

const deployDockerfileApplicationWithBuildServer = async (
	application: Awaited<ReturnType<typeof findApplicationById>>,
	deployment: Awaited<ReturnType<typeof createDeployment>>,
	options: { cloneRepository: boolean },
) => {
	assertApplicationBuildServerDeploymentReady(application);
	const buildServerId = application.buildServerId as string;
	const runtimeServerId = application.serverId;
	const organizationId = application.environment.project.organizationId;
	const registry = await findRegistryByIdWithCredentials(
		application.buildRegistryId as string,
	);
	assertApplicationBuildServerSelection({
		organizationId,
		server: application.buildServer,
		registry,
	});
	assertApplicationRuntimeServerSelection({
		organizationId,
		buildServerId,
		runtimeServer: application.server,
	});

	const buildApplication = { ...application, serverId: buildServerId };
	const localImage = `${application.appName}:${deployment.deploymentId}`;
	const runtimeImage = getApplicationDeploymentImage(
		registry,
		application.appName,
		deployment.deploymentId,
	);
	const buildCancellationPath = getApplicationCancellationPath(
		application.appName,
		true,
	);
	const runtimeCancellationPath = getApplicationCancellationPath(
		application.appName,
		Boolean(runtimeServerId),
	);
	let previousRuntimeImage: string | null = null;
	let activationAttempted = false;

	try {
		await Promise.all([
			execAsyncRemote(buildServerId, `rm -f ${quote([buildCancellationPath])}`),
			executeApplicationRuntimeCommand(
				runtimeServerId,
				`rm -f ${quote([runtimeCancellationPath])}`,
			),
		]);

		const [buildPlatform, runtimePlatform] = await Promise.all([
			inspectApplicationDockerPlatform(buildServerId, "Build Server"),
			inspectApplicationDockerPlatform(runtimeServerId, "Deploy Server"),
		]);
		await appendApplicationDeploymentLog(
			buildServerId,
			deployment.logPath,
			`\nBuild Server Docker platform: ${buildPlatform}\nDeploy Server Docker platform: ${runtimePlatform}\nBuild target platform: ${runtimePlatform}\n`,
		);

		if (options.cloneRepository) {
			await runApplicationBuildStage(
				buildServerId,
				deployment.logPath,
				"Build: checkout",
				`set -e; ${await getApplicationCloneCommand(buildApplication)}`,
				buildCancellationPath,
			);
		}
		const patchCommand = await generateApplyPatchesCommand({
			id: application.applicationId,
			type: "application",
			serverId: buildServerId,
		});
		if (patchCommand) {
			await runApplicationBuildStage(
				buildServerId,
				deployment.logPath,
				"Build: patches",
				`set -e; ${patchCommand}`,
				buildCancellationPath,
			);
		}

		await appendApplicationDeploymentLog(
			buildServerId,
			deployment.logPath,
			"\n===== Build =====\n",
		);
		await loginApplicationRegistryWithLog(
			buildServerId,
			buildServerId,
			deployment.logPath,
			registry,
		);
		await runApplicationBuildStage(
			buildServerId,
			deployment.logPath,
			"Build and Push",
			`set -e; ${getDockerCommand(buildApplication, {
				image: localImage,
				deploymentId: deployment.deploymentId,
				platform: runtimePlatform,
			})}\n${getApplicationBuildPushCommand(localImage, runtimeImage)}`,
			buildCancellationPath,
		);

		await appendApplicationDeploymentLog(
			buildServerId,
			deployment.logPath,
			"\n===== Pull =====\n",
		);
		await loginApplicationRegistryWithLog(
			runtimeServerId,
			buildServerId,
			deployment.logPath,
			registry,
		);
		await runApplicationRuntimeStage(
			runtimeServerId,
			buildServerId,
			deployment.logPath,
			"Pull immutable image",
			getApplicationRuntimePullCommand(runtimeImage),
			runtimeCancellationPath,
		);
		await runApplicationRuntimeStage(
			runtimeServerId,
			buildServerId,
			deployment.logPath,
			"Pre-activation safety check",
			getApplicationCancellationCheckCommand(runtimeCancellationPath),
		);
		const previousImageResult = await executeApplicationRuntimeCommand(
			runtimeServerId,
			`docker service inspect --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' ${quote(
				[application.appName],
			)} 2>/dev/null || true`,
		);
		previousRuntimeImage = previousImageResult.stdout.trim() || null;

		await appendApplicationDeploymentLog(
			buildServerId,
			deployment.logPath,
			"\n===== Deploy =====\n",
		);
		activationAttempted = true;
		await mechanizeDockerContainer(application, {
			runtimeImage,
			deploymentId: deployment.deploymentId,
			enforceZeroDowntime: true,
		});
		await runApplicationRuntimeStage(
			runtimeServerId,
			buildServerId,
			deployment.logPath,
			"Wait for start-first activation and stabilization",
			getWaitApplicationServiceCommand(
				application.appName,
				runtimeImage,
				undefined,
				APPLICATION_STABILIZATION_SECONDS,
			),
			runtimeCancellationPath,
		);
	} catch (error) {
		if (activationAttempted) {
			try {
				await runApplicationRuntimeStage(
					runtimeServerId,
					buildServerId,
					deployment.logPath,
					"Rollback",
					getRollbackApplicationServiceCommand(
						application.appName,
						runtimeImage,
						previousRuntimeImage,
					),
				);
			} catch (rollbackError) {
				await appendApplicationDeploymentLog(
					buildServerId,
					deployment.logPath,
					`\nRollback warning: ${
						rollbackError instanceof Error
							? rollbackError.message
							: String(rollbackError)
					}\n`,
				);
			}
		}
		throw error;
	} finally {
		await Promise.allSettled([
			execAsyncRemote(buildServerId, `rm -f ${quote([buildCancellationPath])}`),
			executeApplicationRuntimeCommand(
				runtimeServerId,
				`rm -f ${quote([runtimeCancellationPath])}`,
			),
		]);
	}
};

export const requestApplicationDeploymentCancellation = async (
	applicationId: string,
) => {
	const application = await ensureApplicationBuildServer(applicationId);
	const buildPath = getApplicationCancellationPath(application.appName, true);
	const runtimePath = getApplicationCancellationPath(
		application.appName,
		Boolean(application.serverId),
	);
	const results = await Promise.allSettled([
		execAsyncRemote(
			application.buildServerId,
			getApplicationCancellationRequestCommand(buildPath),
		),
		executeApplicationRuntimeCommand(
			application.serverId,
			getApplicationCancellationRequestCommand(runtimePath),
		),
	]);
	if (results.every((result) => result.status === "rejected")) {
		const failure = results.find((result) => result.status === "rejected");
		if (failure?.status === "rejected") throw failure.reason;
	}
	return true;
};

export const deployApplication = async ({
	applicationId,
	titleLog = "Manual deployment",
	descriptionLog = "",
}: {
	applicationId: string;
	titleLog: string;
	descriptionLog: string;
}) => {
	const application = await ensureApplicationBuildServer(applicationId);
	const serverId = application.buildServerId;
	const applicationEntity = {
		...application,
		serverId: serverId,
	};

	const buildLink = `${await getDokployUrl()}/dashboard/project/${application.environment.projectId}/environment/${application.environmentId}/services/application/${application.applicationId}?tab=deployments`;
	const deployment = await createDeployment({
		applicationId: applicationId,
		title: titleLog,
		description: descriptionLog,
	});

	try {
		if (
			application.sourceType !== "docker" &&
			application.buildType === "dockerfile"
		) {
			await deployDockerfileApplicationWithBuildServer(
				application,
				deployment,
				{ cloneRepository: true },
			);
		} else {
			if (application.sourceType !== "docker" && !application.buildRegistryId) {
				throw new Error(
					"A Build Registry is required when an Application builds on a Build Server",
				);
			}
			let command = "set -e;";
			if (application.sourceType === "github") {
				command += await cloneGithubRepository(applicationEntity);
			} else if (application.sourceType === "gitlab") {
				command += await cloneGitlabRepository(applicationEntity);
			} else if (application.sourceType === "gitea") {
				command += await cloneGiteaRepository(applicationEntity);
			} else if (application.sourceType === "bitbucket") {
				command += await cloneBitbucketRepository(applicationEntity);
			} else if (application.sourceType === "git") {
				command += await cloneGitRepository(applicationEntity);
			} else if (application.sourceType === "docker") {
				command += await buildRemoteDocker(applicationEntity);
			}

			if (application.sourceType !== "docker") {
				command += await generateApplyPatchesCommand({
					id: application.applicationId,
					type: "application",
					serverId,
				});
			}
			command += await getBuildCommand(applicationEntity);
			await execAsyncRemote(
				serverId,
				`(${command}) >> ${quote([deployment.logPath])} 2>&1`,
			);
			await mechanizeDockerContainer(application);
		}
		await updateDeploymentStatus(deployment.deploymentId, "done");
		await updateApplicationStatus(applicationId, "done");

		await sendBuildSuccessNotifications({
			projectName: application.environment.project.name,
			applicationName: application.name,
			applicationType: "application",
			buildLink,
			organizationId: application.environment.project.organizationId,
			domains: application.domains,
			environmentName: application.environment.name,
		});
	} catch (error) {
		const cancelled = await applicationDeploymentWasCancelled(
			deployment.deploymentId,
			error,
		);
		let command = "";

		// Only log details for non-ExecError errors
		if (!(error instanceof ExecError)) {
			const message = error instanceof Error ? error.message : String(error);
			const encodedMessage = encodeBase64(message);
			command += `printf %s ${quote([encodedMessage])} | base64 -d >> ${quote([
				deployment.logPath,
			])};`;
		}

		command += cancelled
			? `printf '\nDeployment cancelled. The previous release remains active.\n' >> ${quote(
					[deployment.logPath],
				)};`
			: `printf '\nError occurred ❌, check the logs for details.\n' >> ${quote(
					[deployment.logPath],
				)};`;
		await execAsyncRemote(serverId, command);
		await updateDeploymentStatus(
			deployment.deploymentId,
			cancelled ? "cancelled" : "error",
		);
		await updateApplicationStatus(applicationId, cancelled ? "idle" : "error");

		if (!cancelled) {
			await sendBuildErrorNotifications({
				projectName: application.environment.project.name,
				applicationName: application.name,
				applicationType: "application",
				// @ts-ignore
				errorMessage: error?.message || "Error building",
				buildLink,
				organizationId: application.environment.project.organizationId,
			});
		}

		throw error;
	} finally {
		// Only extract commit info for non-docker sources
		if (application.sourceType !== "docker") {
			const commitInfo = await getGitCommitInfo({
				appName: application.appName,
				type: "application",
				serverId: serverId,
			});
			if (commitInfo) {
				await updateDeployment(deployment.deploymentId, {
					title: commitInfo.message,
					description: `Commit: ${commitInfo.hash}`,
				});
			}
		}
	}
	return true;
};

export const rebuildApplication = async ({
	applicationId,
	titleLog = "Rebuild deployment",
	descriptionLog = "",
}: {
	applicationId: string;
	titleLog: string;
	descriptionLog: string;
}) => {
	const application = await ensureApplicationBuildServer(applicationId);
	const serverId = application.buildServerId;
	const applicationEntity = { ...application, serverId };
	const buildLink = `${await getDokployUrl()}/dashboard/project/${application.environment.projectId}/environment/${application.environmentId}/services/application/${application.applicationId}?tab=deployments`;

	const deployment = await createDeployment({
		applicationId: applicationId,
		title: titleLog,
		description: descriptionLog,
	});

	try {
		if (
			application.sourceType !== "docker" &&
			application.buildType === "dockerfile"
		) {
			await deployDockerfileApplicationWithBuildServer(
				application,
				deployment,
				{ cloneRepository: false },
			);
		} else {
			if (application.sourceType !== "docker" && !application.buildRegistryId) {
				throw new Error(
					"A Build Registry is required when an Application builds on a Build Server",
				);
			}
			const command = `set -e; ${await getBuildCommand(applicationEntity)}`;
			await execAsyncRemote(
				serverId,
				`(${command}) >> ${quote([deployment.logPath])} 2>&1`,
			);
			await mechanizeDockerContainer(application);
		}
		await updateDeploymentStatus(deployment.deploymentId, "done");
		await updateApplicationStatus(applicationId, "done");

		await sendBuildSuccessNotifications({
			projectName: application.environment.project.name,
			applicationName: application.name,
			applicationType: "application",
			buildLink,
			organizationId: application.environment.project.organizationId,
			domains: application.domains,
			environmentName: application.environment.name,
		});
	} catch (error) {
		const cancelled = await applicationDeploymentWasCancelled(
			deployment.deploymentId,
			error,
		);
		let command = "";

		// Only log details for non-ExecError errors
		if (!(error instanceof ExecError)) {
			const message = error instanceof Error ? error.message : String(error);
			const encodedMessage = encodeBase64(message);
			command += `printf %s ${quote([encodedMessage])} | base64 -d >> ${quote([
				deployment.logPath,
			])};`;
		}

		command += cancelled
			? `printf '\nDeployment cancelled. The previous release remains active.\n' >> ${quote(
					[deployment.logPath],
				)};`
			: `printf '\nError occurred ❌, check the logs for details.\n' >> ${quote(
					[deployment.logPath],
				)};`;
		await execAsyncRemote(serverId, command);
		await updateDeploymentStatus(
			deployment.deploymentId,
			cancelled ? "cancelled" : "error",
		);
		await updateApplicationStatus(applicationId, cancelled ? "idle" : "error");
		throw error;
	}

	return true;
};

export const deployPreviewApplication = async ({
	applicationId,
	titleLog = "Preview Deployment",
	descriptionLog = "",
	previewDeploymentId,
}: {
	applicationId: string;
	titleLog: string;
	descriptionLog: string;
	previewDeploymentId: string;
}) => {
	const application = await ensureApplicationBuildServer(applicationId);

	const deployment = await createDeploymentPreview({
		title: titleLog,
		description: descriptionLog,
		previewDeploymentId: previewDeploymentId,
	});

	const previewDeployment =
		await findPreviewDeploymentById(previewDeploymentId);

	await updatePreviewDeployment(previewDeploymentId, {
		createdAt: new Date().toISOString(),
	});

	const previewDomain = getDomainHost(previewDeployment?.domain as Domain);
	const issueParams = {
		owner: application?.owner || "",
		repository: application?.repository || "",
		issue_number: previewDeployment.pullRequestNumber,
		comment_id: Number.parseInt(previewDeployment.pullRequestCommentId),
		githubId: application?.githubId || "",
	};
	try {
		const commentExists = await issueCommentExists({
			...issueParams,
		});
		if (!commentExists) {
			const result = await createPreviewDeploymentComment({
				...issueParams,
				previewDomain,
				appName: previewDeployment.appName,
				githubId: application?.githubId || "",
				previewDeploymentId,
			});

			if (!result) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Pull request comment not found",
				});
			}

			issueParams.comment_id = Number.parseInt(result?.pullRequestCommentId);
		}
		const buildingComment = getIssueComment(
			application.name,
			"running",
			previewDomain,
		);
		await updateIssueComment({
			...issueParams,
			body: `### Dokploy Preview Deployment\n\n${buildingComment}`,
		});
		application.appName = previewDeployment.appName;
		application.env = `${application.previewEnv}\nDOKPLOY_DEPLOY_URL=${previewDeployment?.domain?.host}`;
		application.buildArgs = `${application.previewBuildArgs}\nDOKPLOY_DEPLOY_URL=${previewDeployment?.domain?.host}`;
		application.buildSecrets = `${application.previewBuildSecrets}\nDOKPLOY_DEPLOY_URL=${previewDeployment?.domain?.host}`;
		application.branch = previewDeployment.branch;
		application.rollbackActive = false;
		application.rollbackRegistry = null;
		application.registry = null;
		application.domains = previewDeployment.domain
			? [previewDeployment.domain]
			: [];

		if (application.buildType === "dockerfile") {
			await deployDockerfileApplicationWithBuildServer(
				application,
				deployment,
				{ cloneRepository: true },
			);
		} else if (application.sourceType === "github") {
			const buildApplication = {
				...application,
				serverId: application.buildServerId,
			};
			const command = `set -e;${await cloneGithubRepository(
				buildApplication,
			)}${await getBuildCommand(buildApplication)}`;
			await execAsyncRemote(
				application.buildServerId,
				`(${command}) >> ${quote([deployment.logPath])} 2>&1`,
			);
			await mechanizeDockerContainer(application);
		}
		const successComment = getIssueComment(
			application.name,
			"success",
			previewDomain,
		);
		await updateIssueComment({
			...issueParams,
			body: `### Dokploy Preview Deployment\n\n${successComment}`,
		});
		await updateDeploymentStatus(deployment.deploymentId, "done");
		await updatePreviewDeployment(previewDeploymentId, {
			previewStatus: "done",
		});
	} catch (error) {
		const comment = getIssueComment(application.name, "error", previewDomain);
		await updateIssueComment({
			...issueParams,
			body: `### Dokploy Preview Deployment\n\n${comment}`,
		});
		await updateDeploymentStatus(deployment.deploymentId, "error");
		await updatePreviewDeployment(previewDeploymentId, {
			previewStatus: "error",
		});
		throw error;
	}

	return true;
};

export const rebuildPreviewApplication = async ({
	applicationId,
	titleLog = "Rebuild Preview Deployment",
	descriptionLog = "",
	previewDeploymentId,
}: {
	applicationId: string;
	titleLog: string;
	descriptionLog: string;
	previewDeploymentId: string;
}) => {
	const [application, previewDeployment] = await Promise.all([
		ensureApplicationBuildServer(applicationId),
		findPreviewDeploymentById(previewDeploymentId),
	]);
	const deployment = await createDeploymentPreview({
		title: titleLog,
		description: descriptionLog,
		previewDeploymentId: previewDeployment.previewDeploymentId,
	});

	const previewDomain = getDomainHost(previewDeployment?.domain as Domain);
	const issueParams = {
		owner: application?.owner || "",
		repository: application?.repository || "",
		issue_number: previewDeployment.pullRequestNumber,
		comment_id: Number.parseInt(previewDeployment.pullRequestCommentId),
		githubId: application?.githubId || "",
	};

	try {
		const commentExists = await issueCommentExists({
			...issueParams,
		});
		if (!commentExists) {
			const result = await createPreviewDeploymentComment({
				...issueParams,
				previewDomain,
				appName: previewDeployment.appName,
				githubId: application?.githubId || "",
				previewDeploymentId,
			});

			if (!result) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Pull request comment not found",
				});
			}

			issueParams.comment_id = Number.parseInt(result?.pullRequestCommentId);
		}

		const buildingComment = getIssueComment(
			application.name,
			"running",
			previewDomain,
		);
		await updateIssueComment({
			...issueParams,
			body: `### Dokploy Preview Deployment\n\n${buildingComment}`,
		});

		// Set application properties for preview deployment
		application.appName = previewDeployment.appName;
		application.env = `${application.previewEnv}\nDOKPLOY_DEPLOY_URL=${previewDeployment?.domain?.host}`;
		application.buildArgs = `${application.previewBuildArgs}\nDOKPLOY_DEPLOY_URL=${previewDeployment?.domain?.host}`;
		application.buildSecrets = `${application.previewBuildSecrets}\nDOKPLOY_DEPLOY_URL=${previewDeployment?.domain?.host}`;
		application.branch = previewDeployment.branch;
		application.rollbackActive = false;
		application.rollbackRegistry = null;
		application.registry = null;
		application.domains = previewDeployment.domain
			? [previewDeployment.domain]
			: [];

		if (application.buildType === "dockerfile") {
			await deployDockerfileApplicationWithBuildServer(
				application,
				deployment,
				{ cloneRepository: false },
			);
		} else {
			const buildApplication = {
				...application,
				serverId: application.buildServerId,
			};
			const command = `set -e; ${await getBuildCommand(buildApplication)}`;
			await execAsyncRemote(
				application.buildServerId,
				`(${command}) >> ${quote([deployment.logPath])} 2>&1`,
			);
			await mechanizeDockerContainer(application);
		}

		const successComment = getIssueComment(
			application.name,
			"success",
			previewDomain,
		);
		await updateIssueComment({
			...issueParams,
			body: `### Dokploy Preview Deployment\n\n${successComment}`,
		});
		await updateDeploymentStatus(deployment.deploymentId, "done");
		await updatePreviewDeployment(previewDeploymentId, {
			previewStatus: "done",
		});
	} catch (error) {
		let command = "";

		// Only log details for non-ExecError errors
		if (!(error instanceof ExecError)) {
			const message = error instanceof Error ? error.message : String(error);
			const encodedMessage = encodeBase64(message);
			command += `printf %s ${quote([encodedMessage])} | base64 -d >> ${quote([
				deployment.logPath,
			])};`;
		}

		command += `printf '\nError occurred ❌, check the logs for details.\n' >> ${quote(
			[deployment.logPath],
		)};`;
		await execAsyncRemote(application.buildServerId, command);

		const comment = getIssueComment(application.name, "error", previewDomain);
		await updateIssueComment({
			...issueParams,
			body: `### Dokploy Preview Deployment\n\n${comment}`,
		});
		await updateDeploymentStatus(deployment.deploymentId, "error");
		await updatePreviewDeployment(previewDeploymentId, {
			previewStatus: "error",
		});
		throw error;
	}

	return true;
};

export const getApplicationStats = async (appName: string) => {
	if (appName === "dokploy") {
		return await getAdvancedStats(appName);
	}
	const filter = {
		status: ["running"],
		label: [`com.docker.swarm.service.name=${appName}`],
	};

	const containers = await docker.listContainers({
		filters: JSON.stringify(filter),
	});

	const container = containers[0];
	if (!container || container?.State !== "running") {
		return null;
	}

	const data = await getAdvancedStats(appName);

	return data;
};
