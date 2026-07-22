import { promises as fsPromises } from "node:fs";
import { join } from "node:path";
import { paths } from "@dokploy/server/constants";
import { db } from "@dokploy/server/db";
import {
	type apiCreateCompose,
	buildAppName,
	cleanAppName,
	compose,
} from "@dokploy/server/db/schema";
import { findRegistryByIdWithCredentials } from "@dokploy/server/services/registry";
import {
	getBuildComposeCommand,
	getCreateEnvFileCommand,
} from "@dokploy/server/utils/builders/compose";
import {
	assertComposeBuildServerSupported,
	createRuntimeComposeManifest,
	getActivateRuntimeManifestCommand,
	getComposeBuildPushCommand,
	getComposeConfigCommand,
	getComposeRegistryLoginCommand,
	getRemoveTemporaryManifestCommand,
	getRuntimeComposePaths,
	getRuntimeDeployCommand,
	getRuntimePullCommands,
	getTransferRuntimeManifestCommand,
	validateComposeBuildServerSpecification,
} from "@dokploy/server/utils/builders/compose-build-server";
import { randomizeSpecificationFile } from "@dokploy/server/utils/docker/compose";
import {
	cloneCompose,
	loadDockerCompose,
	loadDockerComposeRemote,
	writeDomainsToCompose,
} from "@dokploy/server/utils/docker/domain";
import type { ComposeSpecification } from "@dokploy/server/utils/docker/types";
import { sendBuildErrorNotifications } from "@dokploy/server/utils/notifications/build-error";
import { sendBuildSuccessNotifications } from "@dokploy/server/utils/notifications/build-success";
import {
	ExecError,
	execAsync,
	execAsyncRemote,
	execFileAsync,
} from "@dokploy/server/utils/process/execAsync";
import { cloneBitbucketRepository } from "@dokploy/server/utils/providers/bitbucket";
import {
	cloneGitRepository,
	getGitCommitInfo,
} from "@dokploy/server/utils/providers/git";
import { cloneGiteaRepository } from "@dokploy/server/utils/providers/gitea";
import { cloneGithubRepository } from "@dokploy/server/utils/providers/github";
import { cloneGitlabRepository } from "@dokploy/server/utils/providers/gitlab";
import { getCreateComposeFileCommand } from "@dokploy/server/utils/providers/raw";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { quote } from "shell-quote";
import type { z } from "zod";
import { encodeBase64 } from "../utils/docker/utils";
import { getDokployUrl } from "./admin";
import {
	createDeploymentCompose,
	updateDeployment,
	updateDeploymentStatus,
} from "./deployment";
import { generateApplyPatchesCommand } from "./patch";
import { validUniqueServerAppName } from "./project";

export type Compose = typeof compose.$inferSelect;

const appendDeploymentLog = async (
	serverId: string | null,
	logPath: string,
	content: string,
) => {
	if (!content) return;
	const command = `echo ${quote([encodeBase64(content)])} | base64 -d >> ${quote(
		[logPath],
	)}`;
	if (serverId) {
		await execAsyncRemote(serverId, command);
	} else {
		await fsPromises.appendFile(logPath, content);
	}
};

const executeOnServer = async (serverId: string | null, command: string) => {
	if (serverId) return await execAsyncRemote(serverId, command);
	return await execAsync(command);
};

const runBuildServerStage = async (
	serverId: string,
	logPath: string,
	stage: string,
	command: string,
) => {
	await appendDeploymentLog(serverId, logPath, `\n===== ${stage} =====\n`);
	return await execAsyncRemote(
		serverId,
		`(${command}) >> ${quote([logPath])} 2>&1`,
	);
};

const runRuntimeStage = async (
	runtimeServerId: string | null,
	buildServerId: string,
	logPath: string,
	stage: string,
	command: string,
) => {
	await appendDeploymentLog(buildServerId, logPath, `\n===== ${stage} =====\n`);
	try {
		const result = await executeOnServer(runtimeServerId, command);
		await appendDeploymentLog(
			buildServerId,
			logPath,
			`${result.stdout}${result.stderr}`,
		);
		return result;
	} catch (error) {
		if (error instanceof ExecError) {
			await appendDeploymentLog(
				buildServerId,
				logPath,
				`${error.stdout || ""}${error.stderr || ""}`,
			);
		}
		throw error;
	}
};

const loginComposeRegistry = async (
	serverId: string | null,
	registry: Awaited<ReturnType<typeof findRegistryByIdWithCredentials>>,
) => {
	const command = getComposeRegistryLoginCommand(registry);
	if (serverId) {
		return await execAsyncRemote(
			serverId,
			command,
			undefined,
			registry.password,
		);
	}
	const args = [
		"login",
		...(registry.registryUrl ? [registry.registryUrl] : []),
		"--username",
		registry.username,
		"--password-stdin",
	];
	return await execFileAsync("docker", args, {
		input: registry.password,
		env: { ...process.env, HOME: process.env.HOME },
	});
};

const loginComposeRegistryWithLog = async (
	serverId: string | null,
	buildServerId: string,
	logPath: string,
	registry: Awaited<ReturnType<typeof findRegistryByIdWithCredentials>>,
) => {
	try {
		const result = await loginComposeRegistry(serverId, registry);
		await appendDeploymentLog(
			buildServerId,
			logPath,
			`${result.stdout}${result.stderr}`,
		);
		return result;
	} catch (error) {
		if (error instanceof ExecError) {
			await appendDeploymentLog(
				buildServerId,
				logPath,
				`${error.stdout || ""}${error.stderr || ""}`,
			);
		}
		throw error;
	}
};

const removeActiveRuntimeManifest = async (
	compose: Pick<Compose, "appName" | "serverId">,
) => {
	const runtimePaths = getRuntimeComposePaths(compose, "legacy");
	await executeOnServer(
		compose.serverId,
		`rm -f ${quote([runtimePaths.active])}`,
	);
};

export const createCompose = async (
	input: z.infer<typeof apiCreateCompose>,
) => {
	const appName = buildAppName("compose", input.appName);

	const valid = await validUniqueServerAppName(appName);
	if (!valid) {
		throw new TRPCError({
			code: "CONFLICT",
			message: "Service with this 'AppName' already exists",
		});
	}

	const newDestination = await db
		.insert(compose)
		.values({
			...input,
			composeFile: input.composeFile || "",
			appName,
		})
		.returning()
		.then((value) => value[0]);

	if (!newDestination) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error input: Inserting compose",
		});
	}

	return newDestination;
};

export const createComposeByTemplate = async (
	input: typeof compose.$inferInsert,
) => {
	const appName = cleanAppName(input.appName);
	if (appName) {
		const valid = await validUniqueServerAppName(appName);

		if (!valid) {
			throw new TRPCError({
				code: "CONFLICT",
				message: "Service with this 'AppName' already exists",
			});
		}
	}
	const newDestination = await db
		.insert(compose)
		.values({
			...input,
			appName,
		})
		.returning()
		.then((value) => value[0]);

	if (!newDestination) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error input: Inserting compose",
		});
	}

	return newDestination;
};

export const findComposeById = async (composeId: string) => {
	const result = await db.query.compose.findFirst({
		where: eq(compose.composeId, composeId),
		with: {
			environment: {
				with: {
					project: true,
				},
			},
			deployments: true,
			mounts: true,
			domains: true,
			github: true,
			gitlab: true,
			bitbucket: true,
			gitea: true,
			server: true,
			buildServer: true,
			buildRegistry: {
				columns: {
					password: false,
				},
			},
			backups: {
				with: {
					destination: {
						columns: {
							accessKey: false,
							secretAccessKey: false,
						},
					},
					deployments: true,
				},
			},
		},
	});
	if (!result) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Compose not found",
		});
	}
	return result;
};

export const loadServices = async (
	composeId: string,
	type: "fetch" | "cache" = "fetch",
) => {
	const compose = await findComposeById(composeId);
	const sourceServerId = compose.buildServerId || compose.serverId;
	const sourceCompose = { ...compose, serverId: sourceServerId };

	if (type === "fetch") {
		const command = await cloneCompose(sourceCompose);
		if (sourceServerId) {
			await execAsyncRemote(sourceServerId, command);
		} else {
			await execAsync(command);
		}
	}

	let composeData: ComposeSpecification | null;

	if (sourceServerId) {
		composeData = await loadDockerComposeRemote(sourceCompose);
	} else {
		composeData = await loadDockerCompose(sourceCompose);
	}

	if (compose.randomize && composeData) {
		const randomizedCompose = randomizeSpecificationFile(
			composeData,
			compose.suffix,
		);
		composeData = randomizedCompose;
	}

	if (!composeData?.services) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Services not found",
		});
	}

	const services = Object.keys(composeData.services);

	return [...services];
};

export const updateCompose = async (
	composeId: string,
	composeData: Partial<Compose>,
) => {
	const { appName, ...rest } = composeData;
	const composeResult = await db
		.update(compose)
		.set({
			...rest,
		})
		.where(eq(compose.composeId, composeId))
		.returning();

	return composeResult[0];
};

const deployComposeWithBuildServer = async (
	compose: Awaited<ReturnType<typeof findComposeById>>,
	deployment: Awaited<ReturnType<typeof createDeploymentCompose>>,
	options: { cloneRepository: boolean },
) => {
	if (!compose.buildServerId || !compose.buildRegistryId) {
		throw new Error(
			"Build Server and Build Registry must be configured together",
		);
	}
	assertComposeBuildServerSupported(compose);

	const buildServerId = compose.buildServerId;
	const runtimeServerId = compose.serverId;
	const buildCompose = {
		...compose,
		serverId: buildServerId,
		type: "compose" as const,
	};
	const registry = await findRegistryByIdWithCredentials(
		compose.buildRegistryId,
	);
	let temporaryManifest: string | null = null;

	try {
		if (options.cloneRepository) {
			let cloneCommand = "set -e;";
			if (compose.sourceType === "github") {
				cloneCommand += await cloneGithubRepository(buildCompose);
			} else if (compose.sourceType === "gitlab") {
				cloneCommand += await cloneGitlabRepository(buildCompose);
			} else if (compose.sourceType === "bitbucket") {
				cloneCommand += await cloneBitbucketRepository(buildCompose);
			} else if (compose.sourceType === "git") {
				cloneCommand += await cloneGitRepository(buildCompose);
			} else if (compose.sourceType === "gitea") {
				cloneCommand += await cloneGiteaRepository(buildCompose);
			}
			await runBuildServerStage(
				buildServerId,
				deployment.logPath,
				"Build: checkout",
				cloneCommand,
			);
		}

		const patchCommand = await generateApplyPatchesCommand({
			id: compose.composeId,
			type: "compose",
			serverId: buildServerId,
		});
		if (patchCommand) {
			await runBuildServerStage(
				buildServerId,
				deployment.logPath,
				"Build: patches",
				`set -e; ${patchCommand}`,
			);
		}

		const domainsCommand = await writeDomainsToCompose(
			buildCompose,
			compose.domains,
		);
		const envCommand = getCreateEnvFileCommand(
			buildCompose,
			deployment.deploymentId,
		);
		await runBuildServerStage(
			buildServerId,
			deployment.logPath,
			"Build: resolve",
			`set -e; ${domainsCommand} ${envCommand}`,
		);

		let resolved: { stdout: string; stderr: string };
		try {
			resolved = await execAsyncRemote(
				buildServerId,
				getComposeConfigCommand(buildCompose, deployment.deploymentId),
			);
		} catch (error) {
			if (error instanceof ExecError) {
				await appendDeploymentLog(
					buildServerId,
					deployment.logPath,
					`${error.stdout || ""}${error.stderr || ""}`,
				);
			}
			throw error;
		}
		if (resolved.stderr) {
			await appendDeploymentLog(
				buildServerId,
				deployment.logPath,
				resolved.stderr,
			);
		}

		let specification: ComposeSpecification;
		try {
			specification = JSON.parse(resolved.stdout) as ComposeSpecification;
		} catch (error) {
			throw new Error(
				`Docker Compose returned an invalid JSON configuration: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}

		const validation = validateComposeBuildServerSpecification(
			specification,
			registry,
			deployment.deploymentId,
			compose.mounts,
		);

		await appendDeploymentLog(
			buildServerId,
			deployment.logPath,
			"\n===== Build =====\n",
		);
		await loginComposeRegistryWithLog(
			buildServerId,
			buildServerId,
			deployment.logPath,
			registry,
		);
		await runBuildServerStage(
			buildServerId,
			deployment.logPath,
			"Push (docker compose build --push)",
			getComposeBuildPushCommand(buildCompose, deployment.deploymentId),
		);

		const manifest = createRuntimeComposeManifest(specification);
		const runtimePaths = getRuntimeComposePaths(
			{ appName: compose.appName, serverId: runtimeServerId },
			deployment.deploymentId,
		);
		temporaryManifest = runtimePaths.temporary;
		await runRuntimeStage(
			runtimeServerId,
			buildServerId,
			deployment.logPath,
			"Pull: prepare runtime manifest",
			getTransferRuntimeManifestCommand(manifest, runtimePaths),
		);

		await appendDeploymentLog(
			buildServerId,
			deployment.logPath,
			"\n===== Pull =====\n",
		);
		await loginComposeRegistryWithLog(
			runtimeServerId,
			buildServerId,
			deployment.logPath,
			registry,
		);
		await runRuntimeStage(
			runtimeServerId,
			buildServerId,
			deployment.logPath,
			"Pull images",
			getRuntimePullCommands(
				compose,
				runtimePaths.temporary,
				validation.builtServices,
			).join(" && "),
		);

		await runRuntimeStage(
			runtimeServerId,
			buildServerId,
			deployment.logPath,
			"Deploy",
			`${getRuntimeDeployCommand(
				compose,
				runtimePaths.temporary,
			)} && ${getActivateRuntimeManifestCommand(runtimePaths)}`,
		);
		temporaryManifest = null;
	} catch (error) {
		if (temporaryManifest) {
			try {
				await executeOnServer(
					runtimeServerId,
					getRemoveTemporaryManifestCommand(temporaryManifest),
				);
			} catch {
				// Preserve the original deployment failure.
			}
		}
		throw error;
	}
};

export const deployCompose = async ({
	composeId,
	titleLog = "Manual deployment",
	descriptionLog = "",
}: {
	composeId: string;
	titleLog: string;
	descriptionLog: string;
}) => {
	const compose = await findComposeById(composeId);

	const buildLink = `${await getDokployUrl()}/dashboard/project/${
		compose.environment.projectId
	}/environment/${compose.environmentId}/services/compose/${compose.composeId}?tab=deployments`;
	const deployment = await createDeploymentCompose({
		composeId: composeId,
		title: titleLog,
		description: descriptionLog,
	});

	try {
		if (Boolean(compose.buildServerId) !== Boolean(compose.buildRegistryId)) {
			throw new Error(
				"Build Server and Build Registry must be configured together",
			);
		}
		if (compose.buildServerId && compose.buildRegistryId) {
			await deployComposeWithBuildServer(compose, deployment, {
				cloneRepository: true,
			});
		} else {
			const entity = {
				...compose,
				type: "compose" as const,
			};
			let command = "set -e;";
			if (compose.sourceType === "github") {
				command += await cloneGithubRepository(entity);
			} else if (compose.sourceType === "gitlab") {
				command += await cloneGitlabRepository(entity);
			} else if (compose.sourceType === "bitbucket") {
				command += await cloneBitbucketRepository(entity);
			} else if (compose.sourceType === "git") {
				command += await cloneGitRepository(entity);
			} else if (compose.sourceType === "gitea") {
				command += await cloneGiteaRepository(entity);
			} else if (compose.sourceType === "raw") {
				command += getCreateComposeFileCommand(entity);
			}

			let commandWithLog = `(${command}) >> ${deployment.logPath} 2>&1`;
			if (compose.serverId) {
				await execAsyncRemote(compose.serverId, commandWithLog);
			} else {
				await execAsync(commandWithLog);
			}
			if (compose.sourceType !== "raw") {
				command = "set -e;";
				command += await generateApplyPatchesCommand({
					id: compose.composeId,
					type: "compose",
					serverId: compose.serverId,
				});
				commandWithLog = `(${command}) >> ${deployment.logPath} 2>&1`;
				if (compose.serverId) {
					await execAsyncRemote(compose.serverId, commandWithLog);
				} else {
					await execAsync(commandWithLog);
				}
			}

			command = "set -e;";
			command += await getBuildComposeCommand(entity, deployment.deploymentId);
			commandWithLog = `(${command}) >> ${deployment.logPath} 2>&1`;
			if (compose.serverId) {
				await execAsyncRemote(compose.serverId, commandWithLog);
			} else {
				await execAsync(commandWithLog);
			}
			await removeActiveRuntimeManifest(compose);
		}

		await updateDeploymentStatus(deployment.deploymentId, "done");
		await updateCompose(composeId, {
			composeStatus: "done",
		});

		await sendBuildSuccessNotifications({
			projectName: compose.environment.project.name,
			applicationName: compose.name,
			applicationType: "compose",
			buildLink,
			organizationId: compose.environment.project.organizationId,
			domains: compose.domains,
			environmentName: compose.environment.name,
		});
	} catch (error) {
		let command = "";

		// Only log details for non-ExecError errors
		if (!(error instanceof ExecError)) {
			const message = error instanceof Error ? error.message : String(error);
			const encodedMessage = encodeBase64(message);
			command += `echo "${encodedMessage}" | base64 -d >> "${deployment.logPath}";`;
		}

		command += `echo "\nError occurred ❌, check the logs for details." >> ${deployment.logPath};`;
		const logServerId = compose.buildServerId || compose.serverId;
		if (logServerId) {
			await execAsyncRemote(logServerId, command);
		} else {
			await execAsync(command);
		}
		await updateDeploymentStatus(deployment.deploymentId, "error");
		await updateCompose(composeId, {
			composeStatus: "error",
		});
		await sendBuildErrorNotifications({
			projectName: compose.environment.project.name,
			applicationName: compose.name,
			applicationType: "compose",
			// @ts-ignore
			errorMessage: error?.message || "Error building",
			buildLink,
			organizationId: compose.environment.project.organizationId,
		});
		throw error;
	} finally {
		if (compose.sourceType !== "raw") {
			const commitInfo = await getGitCommitInfo({
				...compose,
				serverId: compose.buildServerId || compose.serverId,
				type: "compose",
			});
			if (commitInfo) {
				await updateDeployment(deployment.deploymentId, {
					title: commitInfo.message,
					description: `Commit: ${commitInfo.hash}`,
				});
			}
		}
	}
};

export const rebuildCompose = async ({
	composeId,
	titleLog = "Rebuild deployment",
	descriptionLog = "",
}: {
	composeId: string;
	titleLog: string;
	descriptionLog: string;
}) => {
	const compose = await findComposeById(composeId);

	const deployment = await createDeploymentCompose({
		composeId: composeId,
		title: titleLog,
		description: descriptionLog,
	});

	try {
		if (Boolean(compose.buildServerId) !== Boolean(compose.buildRegistryId)) {
			throw new Error(
				"Build Server and Build Registry must be configured together",
			);
		}
		if (compose.buildServerId && compose.buildRegistryId) {
			await deployComposeWithBuildServer(compose, deployment, {
				cloneRepository: false,
			});
		} else {
			let command = "set -e;";
			if (compose.sourceType === "raw") {
				command += getCreateComposeFileCommand(compose);
			}

			let commandWithLog = `(${command}) >> ${deployment.logPath} 2>&1`;
			if (compose.serverId) {
				await execAsyncRemote(compose.serverId, commandWithLog);
			} else {
				await execAsync(commandWithLog);
			}

			if (compose.sourceType !== "raw") {
				command = "set -e;";
				command += await generateApplyPatchesCommand({
					id: compose.composeId,
					type: "compose",
					serverId: compose.serverId,
				});
				commandWithLog = `(${command}) >> ${deployment.logPath} 2>&1`;
				if (compose.serverId) {
					await execAsyncRemote(compose.serverId, commandWithLog);
				} else {
					await execAsync(commandWithLog);
				}
			}

			command = "set -e;";
			command += await getBuildComposeCommand(compose, deployment.deploymentId);
			commandWithLog = `(${command}) >> ${deployment.logPath} 2>&1`;
			if (compose.serverId) {
				await execAsyncRemote(compose.serverId, commandWithLog);
			} else {
				await execAsync(commandWithLog);
			}
			await removeActiveRuntimeManifest(compose);
		}

		await updateDeploymentStatus(deployment.deploymentId, "done");
		await updateCompose(composeId, {
			composeStatus: "done",
		});
	} catch (error) {
		let command = "";

		// Only log details for non-ExecError errors
		if (!(error instanceof ExecError)) {
			const message = error instanceof Error ? error.message : String(error);
			const encodedMessage = encodeBase64(message);
			command += `echo "${encodedMessage}" | base64 -d >> "${deployment.logPath}";`;
		}

		command += `echo "\nError occurred ❌, check the logs for details." >> ${deployment.logPath};`;
		const logServerId = compose.buildServerId || compose.serverId;
		if (logServerId) {
			await execAsyncRemote(logServerId, command);
		} else {
			await execAsync(command);
		}
		await updateDeploymentStatus(deployment.deploymentId, "error");
		await updateCompose(composeId, {
			composeStatus: "error",
		});
		throw error;
	}

	return true;
};

export const removeCompose = async (
	compose: Compose,
	deleteVolumes: boolean,
) => {
	try {
		const { COMPOSE_PATH } = paths(!!compose.serverId);
		const projectPath = join(COMPOSE_PATH, compose.appName);
		const codePath = join(projectPath, "code");
		const sourcePath =
			compose.sourceType === "raw" ? "docker-compose.yml" : compose.composePath;
		const runtimePaths = getRuntimeComposePaths(compose, "remove");

		if (compose.composeType === "stack") {
			const command = `
			docker network disconnect ${compose.appName} dokploy-traefik;
			docker stack rm ${compose.appName};
			rm -rf ${projectPath}`;

			if (compose.serverId) {
				await execAsyncRemote(compose.serverId, command);
			} else {
				await execAsync(command);
			}
		} else {
			const command = `
			docker network disconnect ${quote([compose.appName])} dokploy-traefik >/dev/null 2>&1 || true;
			if [ -f ${quote([runtimePaths.active])} ]; then
				env -i PATH="$PATH" HOME="$HOME" docker compose -p ${quote([compose.appName])} -f ${quote([runtimePaths.active])} down ${deleteVolumes ? "--volumes" : ""};
			elif [ -f ${quote([join(codePath, sourcePath)])} ]; then
				cd ${quote([codePath])} && env -i PATH="$PATH" HOME="$HOME" docker compose -p ${quote([compose.appName])} -f ${quote([sourcePath])} down ${deleteVolumes ? "--volumes" : ""};
			fi;
			rm -rf ${quote([projectPath])}`;

			if (compose.serverId) {
				await execAsyncRemote(compose.serverId, command);
			} else {
				await execAsync(command);
			}
		}
	} catch (error) {
		throw error;
	}

	return true;
};

export const startCompose = async (composeId: string) => {
	const compose = await findComposeById(composeId);
	try {
		const { COMPOSE_PATH } = paths(!!compose.serverId);

		const projectPath = join(COMPOSE_PATH, compose.appName, "code");
		const path =
			compose.sourceType === "raw" ? "docker-compose.yml" : compose.composePath;
		const runtimePaths = getRuntimeComposePaths(compose, "start");
		const baseCommand = `if [ -f ${quote([runtimePaths.active])} ]; then env -i PATH="$PATH" HOME="$HOME" docker compose -p ${quote([compose.appName])} -f ${quote([runtimePaths.active])} up -d --no-build --pull never; else cd ${quote([projectPath])} && env -i PATH="$PATH" HOME="$HOME" docker compose -p ${quote([compose.appName])} -f ${quote([path])} up -d; fi`;
		if (compose.composeType === "docker-compose") {
			await executeOnServer(compose.serverId, baseCommand);
		}

		await updateCompose(composeId, {
			composeStatus: "done",
		});
	} catch (error) {
		await updateCompose(composeId, {
			composeStatus: "idle",
		});
		throw error;
	}

	return true;
};

export const stopCompose = async (composeId: string) => {
	const compose = await findComposeById(composeId);
	try {
		const { COMPOSE_PATH } = paths(!!compose.serverId);
		if (compose.composeType === "docker-compose") {
			const projectPath = join(COMPOSE_PATH, compose.appName, "code");
			const sourcePath =
				compose.sourceType === "raw"
					? "docker-compose.yml"
					: compose.composePath;
			const runtimePaths = getRuntimeComposePaths(compose, "stop");
			const command = `if [ -f ${quote([runtimePaths.active])} ]; then env -i PATH="$PATH" HOME="$HOME" docker compose -p ${quote([compose.appName])} -f ${quote([runtimePaths.active])} stop; else cd ${quote([projectPath])} && env -i PATH="$PATH" HOME="$HOME" docker compose -p ${quote([compose.appName])} -f ${quote([sourcePath])} stop; fi`;
			await executeOnServer(compose.serverId, command);
		}

		if (compose.composeType === "stack") {
			if (compose.serverId) {
				await execAsyncRemote(
					compose.serverId,
					`docker stack rm ${compose.appName}`,
				);
			} else {
				await execAsync(`docker stack rm ${compose.appName}`);
			}
		}

		await updateCompose(composeId, {
			composeStatus: "idle",
		});
	} catch (error) {
		await updateCompose(composeId, {
			composeStatus: "error",
		});
		throw error;
	}

	return true;
};
