import { promises as fsPromises } from "node:fs";
import { dirname, join } from "node:path";
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
	type ComposeActivationJournal,
	type ComposeBuildServerDomain,
	type ComposeRuntimeReleaseState,
	createComposeReleaseTraefikRouterConfig,
	createComposeReleaseTraefikServiceConfig,
	createRuntimeComposeManifest,
	getAcquireComposeActivationLockCommand,
	getActivateRuntimeManifestCommand,
	getComposeBuildPushCommand,
	getComposeConfigCommand,
	getComposeRegistryLoginCommand,
	getComposeReleaseProjectName,
	getInstallTraefikConfigCommand,
	getObserveTraefikServicesCommand,
	getReleaseComposeActivationLockCommand,
	getRemoveRuntimeReleaseCommand,
	getRemoveTemporaryManifestCommand,
	getRemoveTraefikConfigCommand,
	getRuntimeComposePaths,
	getRuntimeDeployCommand,
	getRuntimePullCommands,
	getRuntimeReleaseDownCommand,
	getTransferRuntimeManifestCommand,
	getWaitTraefikRoutersCommand,
	getWaitTraefikServicesCommand,
	getWriteActivationJournalCommand,
	getWriteReleaseMetadataCommand,
	getWriteRuntimeReleaseStateCommand,
	validateComposeBuildServerSpecification,
} from "@dokploy/server/utils/builders/compose-build-server";
import { randomizeSpecificationFile } from "@dokploy/server/utils/docker/compose";
import {
	cloneCompose,
	loadDockerCompose,
	loadDockerComposeRemote,
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

const readRuntimeJson = async <T>(
	serverId: string | null,
	path: string,
): Promise<T | null> => {
	const result = await executeOnServer(
		serverId,
		`if [ -f ${quote([path])} ]; then cat ${quote([path])}; fi`,
	);
	const value = result.stdout.trim();
	if (!value) return null;
	try {
		return JSON.parse(value) as T;
	} catch {
		throw new Error(`Invalid Dokploy runtime state in ${path}`);
	}
};

const installRuntimeFileAtomically = (source: string, destination: string) =>
	`mkdir -p ${quote([dirname(destination)])} && cp -f ${quote([
		source,
	])} ${quote([`${destination}.tmp`])} && chmod 0644 ${quote([
		`${destination}.tmp`,
	])} && mv -f ${quote([`${destination}.tmp`])} ${quote([destination])}`;

const composeRouterNames = (
	appName: string,
	domains: Array<{
		uniqueConfigKey: number;
		customEntrypoint: string | null;
		https: boolean;
	}>,
) =>
	domains.flatMap((domain) => [
		`${appName}-${domain.uniqueConfigKey}-${domain.customEntrypoint || "web"}`,
		...(!domain.customEntrypoint && domain.https
			? [`${appName}-${domain.uniqueConfigKey}-websecure`]
			: []),
	]);

const traefikRouterTargets = (config: {
	http?: { routers?: Record<string, { service: string }> };
}) =>
	Object.fromEntries(
		Object.entries(config.http?.routers || {}).map(([name, router]) => [
			name,
			router.service,
		]),
	);

const cleanupLegacyComposeProjectCommand = (
	appName: string,
	drainSeconds: number,
) =>
	`containers="$(docker ps -aq --filter label=com.docker.compose.project=${quote(
		[appName],
	)})"; if [ -n "$containers" ]; then docker stop --time ${drainSeconds} $containers && docker rm $containers; fi; docker network rm ${quote(
		[`${appName}_default`],
	)} >/dev/null 2>&1 || true`;

const cleanupRuntimeRelease = async (
	serverId: string | null,
	state: ComposeRuntimeReleaseState,
	drainSeconds: number,
) => {
	await executeOnServer(
		serverId,
		getRuntimeReleaseDownCommand(state, drainSeconds),
	);
	await executeOnServer(
		serverId,
		`${getRemoveTraefikConfigCommand(
			state.serviceConfigPath,
		)}; ${getRemoveRuntimeReleaseCommand(state)}`,
	);
};

const recoverInterruptedComposeActivation = async (
	compose: Pick<Compose, "appName" | "serverId"> & {
		domains: ComposeBuildServerDomain[];
	},
) => {
	const runtimePaths = getRuntimeComposePaths(compose, "recovery");
	const journal = await readRuntimeJson<ComposeActivationJournal>(
		compose.serverId,
		runtimePaths.activationJournal,
	);
	if (!journal) {
		return;
	}
	const active = await readRuntimeJson<ComposeRuntimeReleaseState>(
		compose.serverId,
		runtimePaths.activeState,
	);
	if (active?.deploymentId === journal.candidate.deploymentId) {
		if (journal.previous) {
			try {
				await cleanupRuntimeRelease(
					compose.serverId,
					journal.previous,
					DEFAULT_RUNTIME_DRAIN_SECONDS,
				);
			} catch {
				await executeOnServer(
					compose.serverId,
					getWriteRuntimeReleaseStateCommand(
						runtimePaths.cleanupPending,
						journal.previous,
					),
				);
			}
		} else if (journal.legacyFallback) {
			try {
				await executeOnServer(
					compose.serverId,
					cleanupLegacyComposeProjectCommand(
						compose.appName,
						DEFAULT_RUNTIME_DRAIN_SECONDS,
					),
				);
			} catch {
				// The next activation retries stale legacy project cleanup.
			}
		}
		await executeOnServer(
			compose.serverId,
			`rm -f ${quote([runtimePaths.activationJournal])}`,
		);
		return;
	}

	let restoreRouter = getRemoveTraefikConfigCommand(runtimePaths.traefikRouter);
	if (journal.previous) {
		const previousRouterConfig = createComposeReleaseTraefikRouterConfig({
			appName: compose.appName,
			domains: compose.domains,
			candidate: journal.previous,
		});
		restoreRouter = `${installRuntimeFileAtomically(
			journal.previous.routerConfigPath,
			runtimePaths.traefikRouter,
		)} && ${getWaitTraefikRoutersCommand(
			traefikRouterTargets(previousRouterConfig),
		)}`;
	} else if (journal.legacyFallback) {
		const legacyRouterTargets = Object.fromEntries(
			composeRouterNames(compose.appName, compose.domains).map((name) => [
				name,
				name,
			]),
		);
		restoreRouter = `${restoreRouter} && ${getWaitTraefikRoutersCommand(
			legacyRouterTargets,
			30,
			"docker",
		)}`;
	}
	await executeOnServer(compose.serverId, restoreRouter);
	await cleanupRuntimeRelease(
		compose.serverId,
		journal.candidate,
		DEFAULT_RUNTIME_DRAIN_SECONDS,
	);
	await executeOnServer(
		compose.serverId,
		`rm -f ${quote([runtimePaths.activationJournal])}`,
	);
};

const DEFAULT_RUNTIME_DRAIN_SECONDS = 30;

const assertComposeDeploymentNotCancelled = async (
	serverId: string | null,
	cancellationRequest: string,
) => {
	try {
		await executeOnServer(
			serverId,
			`if [ -f ${quote([cancellationRequest])} ]; then echo "Compose deployment cancellation requested" >&2; exit 130; fi`,
		);
	} catch (error) {
		if (
			error instanceof ExecError &&
			error.stderr?.includes("Compose deployment cancellation requested")
		) {
			throw new Error("Compose deployment cancellation requested");
		}
		throw error;
	}
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
	compose: Pick<Compose, "appName" | "serverId"> & {
		domains: Parameters<typeof composeRouterNames>[1];
	},
) => {
	const runtimePaths = getRuntimeComposePaths(compose, "legacy");
	const active = await readRuntimeJson<ComposeRuntimeReleaseState>(
		compose.serverId,
		runtimePaths.activeState,
	);
	if (active) {
		const legacyRouterTargets = Object.fromEntries(
			composeRouterNames(compose.appName, compose.domains).map((name) => [
				name,
				name,
			]),
		);
		await executeOnServer(
			compose.serverId,
			`${getWaitTraefikRoutersCommand(
				legacyRouterTargets,
				30,
				"docker",
			)} && ${getRemoveTraefikConfigCommand(
				runtimePaths.traefikRouter,
			)} && ${getRuntimeReleaseDownCommand(
				active,
				DEFAULT_RUNTIME_DRAIN_SECONDS,
				false,
			)} && ${getRemoveRuntimeReleaseCommand(active)} && rm -f ${quote([
				runtimePaths.activeState,
				runtimePaths.activationJournal,
			])}`,
		);
	}
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
	const cancellationPath = getRuntimeComposePaths(
		{ appName: compose.appName, serverId: runtimeServerId },
		"cancel",
	).cancellationRequest;
	let temporaryManifest: string | null = null;
	let runtimePaths: ReturnType<typeof getRuntimeComposePaths> | null = null;
	let candidateState: ComposeRuntimeReleaseState | null = null;
	let previousState: ComposeRuntimeReleaseState | null = null;
	let lockAcquired = false;
	let routeSwitched = false;
	let promoted = false;
	let legacyFallback = false;
	let candidateCleanupComplete = false;
	let interruptedRecoveryComplete = false;
	let runtimeMutationAttempted = false;
	let validation: ReturnType<
		typeof validateComposeBuildServerSpecification
	> | null = null;

	try {
		await executeOnServer(
			runtimeServerId,
			`rm -f ${quote([cancellationPath])}`,
		);
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

		const envCommand = getCreateEnvFileCommand(
			buildCompose,
			deployment.deploymentId,
		);
		await runBuildServerStage(
			buildServerId,
			deployment.logPath,
			"Build: resolve",
			`set -e; ${envCommand}`,
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

		validation = validateComposeBuildServerSpecification(
			specification,
			registry,
			deployment.deploymentId,
			compose.mounts,
			compose.domains,
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

		const projectName = getComposeReleaseProjectName(
			compose.appName,
			deployment.deploymentId,
		);
		const manifest = createRuntimeComposeManifest(specification, {
			appName: compose.appName,
			composeId: compose.composeId,
			deploymentId: deployment.deploymentId,
		});
		runtimePaths = getRuntimeComposePaths(
			{ appName: compose.appName, serverId: runtimeServerId },
			deployment.deploymentId,
		);
		const traefikRelease = createComposeReleaseTraefikServiceConfig({
			appName: compose.appName,
			deploymentId: deployment.deploymentId,
			domains: compose.domains,
			settings: validation.zeroDowntime,
		});
		candidateState = {
			version: 1,
			composeId: compose.composeId,
			deploymentId: deployment.deploymentId,
			projectName,
			manifestPath: runtimePaths.manifest,
			serviceConfigPath: runtimePaths.traefikService,
			routerConfigPath: runtimePaths.routerConfig,
			domainServices: traefikRelease.domainServices,
			activatedAt: new Date().toISOString(),
		};

		temporaryManifest = runtimePaths.temporary;
		await runRuntimeStage(
			runtimeServerId,
			buildServerId,
			deployment.logPath,
			"Pull: prepare runtime manifest",
			getTransferRuntimeManifestCommand(manifest, runtimePaths),
		);
		temporaryManifest = null;

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
				projectName,
				runtimePaths.manifest,
				validation.builtServices,
			).join(" && "),
		);
		await assertComposeDeploymentNotCancelled(
			runtimeServerId,
			cancellationPath,
		);

		await runRuntimeStage(
			runtimeServerId,
			buildServerId,
			deployment.logPath,
			"Deploy: acquire activation lock",
			getAcquireComposeActivationLockCommand(
				runtimePaths.lockDirectory,
				deployment.deploymentId,
				runtimePaths.activationJournal,
			),
		);
		lockAcquired = true;
		await recoverInterruptedComposeActivation(compose);
		interruptedRecoveryComplete = true;
		const pendingCleanup = await readRuntimeJson<ComposeRuntimeReleaseState>(
			runtimeServerId,
			runtimePaths.cleanupPending,
		);
		if (pendingCleanup) {
			try {
				await runRuntimeStage(
					runtimeServerId,
					buildServerId,
					deployment.logPath,
					"Deploy: retry previous cleanup",
					`${getRuntimeReleaseDownCommand(
						pendingCleanup,
						DEFAULT_RUNTIME_DRAIN_SECONDS,
					)} && ${getRemoveRuntimeReleaseCommand(
						pendingCleanup,
					)} && rm -f ${quote([runtimePaths.cleanupPending])}`,
				);
			} catch (cleanupError) {
				await appendDeploymentLog(
					buildServerId,
					deployment.logPath,
					`\nWarning: a previous release still needs cleanup: ${
						cleanupError instanceof Error
							? cleanupError.message
							: String(cleanupError)
					}\n`,
				);
			}
		}
		previousState = await readRuntimeJson<ComposeRuntimeReleaseState>(
			runtimeServerId,
			runtimePaths.activeState,
		);
		const legacy = await executeOnServer(
			runtimeServerId,
			`docker ps -q --filter label=com.docker.compose.project=${quote([
				compose.appName,
			])} | head -n 1`,
		);
		if (!previousState) {
			legacyFallback = Boolean(legacy.stdout.trim());
		} else if (legacy.stdout.trim()) {
			try {
				await runRuntimeStage(
					runtimeServerId,
					buildServerId,
					deployment.logPath,
					"Deploy: retry legacy cleanup",
					cleanupLegacyComposeProjectCommand(
						compose.appName,
						DEFAULT_RUNTIME_DRAIN_SECONDS,
					),
				);
			} catch (cleanupError) {
				await appendDeploymentLog(
					buildServerId,
					deployment.logPath,
					`\nWarning: a legacy Compose project still needs cleanup: ${
						cleanupError instanceof Error
							? cleanupError.message
							: String(cleanupError)
					}\n`,
				);
			}
		}

		const activeRouterConfig = createComposeReleaseTraefikRouterConfig({
			appName: compose.appName,
			domains: compose.domains,
			candidate: candidateState,
		});
		const cutoverRouterConfig = createComposeReleaseTraefikRouterConfig({
			appName: compose.appName,
			domains: compose.domains,
			candidate: candidateState,
			previous: previousState,
			legacyFallback,
		});
		const preparedJournal: ComposeActivationJournal = {
			version: 1,
			phase: "prepared",
			candidate: candidateState,
			previous: previousState,
			legacyFallback,
		};
		await runRuntimeStage(
			runtimeServerId,
			buildServerId,
			deployment.logPath,
			"Deploy: prepare release state",
			`${getWriteReleaseMetadataCommand(
				runtimePaths,
				candidateState,
				traefikRelease.config,
				activeRouterConfig,
			)} && ${getWriteActivationJournalCommand(
				runtimePaths.activationJournal,
				preparedJournal,
			)}`,
		);

		await assertComposeDeploymentNotCancelled(
			runtimeServerId,
			cancellationPath,
		);
		runtimeMutationAttempted = true;
		await runRuntimeStage(
			runtimeServerId,
			buildServerId,
			deployment.logPath,
			"Deploy: start candidate",
			getRuntimeDeployCommand(
				projectName,
				runtimePaths.manifest,
				validation.zeroDowntime.readinessTimeoutSeconds,
			),
		);
		await assertComposeDeploymentNotCancelled(
			runtimeServerId,
			cancellationPath,
		);
		await runRuntimeStage(
			runtimeServerId,
			buildServerId,
			deployment.logPath,
			"Deploy: stage candidate in Traefik",
			`${getInstallTraefikConfigCommand(
				traefikRelease.config,
				runtimePaths.traefikService,
			)} && ${getWaitTraefikServicesCommand(
				Object.values(traefikRelease.domainServices),
				validation.zeroDowntime.readinessTimeoutSeconds,
			)}`,
		);

		await assertComposeDeploymentNotCancelled(
			runtimeServerId,
			cancellationPath,
		);
		await runRuntimeStage(
			runtimeServerId,
			buildServerId,
			deployment.logPath,
			"Deploy: atomic traffic cutover",
			getInstallTraefikConfigCommand(
				cutoverRouterConfig,
				runtimePaths.traefikRouter,
			),
		);
		routeSwitched = true;
		const routedJournal: ComposeActivationJournal = {
			...preparedJournal,
			phase: "routed",
		};
		await executeOnServer(
			runtimeServerId,
			getWriteActivationJournalCommand(
				runtimePaths.activationJournal,
				routedJournal,
			),
		);
		await assertComposeDeploymentNotCancelled(
			runtimeServerId,
			cancellationPath,
		);
		await runRuntimeStage(
			runtimeServerId,
			buildServerId,
			deployment.logPath,
			"Deploy: verify and stabilize",
			`${getWaitTraefikRoutersCommand(
				traefikRouterTargets(cutoverRouterConfig),
			)} && ${getObserveTraefikServicesCommand(
				Object.values(traefikRelease.domainServices),
				validation.zeroDowntime.stabilizationSeconds,
			)}`,
		);

		await assertComposeDeploymentNotCancelled(
			runtimeServerId,
			cancellationPath,
		);
		candidateState = {
			...candidateState,
			activatedAt: new Date().toISOString(),
		};
		const promotedJournal: ComposeActivationJournal = {
			...routedJournal,
			phase: "promoted",
			candidate: candidateState,
		};
		await runRuntimeStage(
			runtimeServerId,
			buildServerId,
			deployment.logPath,
			"Deploy: promote release",
			`${getInstallTraefikConfigCommand(
				activeRouterConfig,
				runtimePaths.traefikRouter,
			)} && ${getWaitTraefikRoutersCommand(
				traefikRouterTargets(activeRouterConfig),
			)} && ${getWriteActivationJournalCommand(
				runtimePaths.activationJournal,
				promotedJournal,
			)} && ${getActivateRuntimeManifestCommand(runtimePaths, candidateState)}`,
		);
		promoted = true;
		routeSwitched = false;

		try {
			if (previousState) {
				await runRuntimeStage(
					runtimeServerId,
					buildServerId,
					deployment.logPath,
					"Deploy: drain previous release",
					`${getRuntimeReleaseDownCommand(
						previousState,
						validation.zeroDowntime.drainSeconds,
					)} && ${getRemoveRuntimeReleaseCommand(previousState)}`,
				);
			} else if (legacyFallback) {
				await runRuntimeStage(
					runtimeServerId,
					buildServerId,
					deployment.logPath,
					"Deploy: drain legacy release",
					cleanupLegacyComposeProjectCommand(
						compose.appName,
						validation.zeroDowntime.drainSeconds,
					),
				);
			}
		} catch (cleanupError) {
			if (previousState) {
				await executeOnServer(
					runtimeServerId,
					getWriteRuntimeReleaseStateCommand(
						runtimePaths.cleanupPending,
						previousState,
					),
				);
			}
			await appendDeploymentLog(
				buildServerId,
				deployment.logPath,
				`\nWarning: the new release is active, but cleanup of the previous release failed: ${
					cleanupError instanceof Error
						? cleanupError.message
						: String(cleanupError)
				}\n`,
			);
		}
		try {
			await executeOnServer(
				runtimeServerId,
				`rm -f ${quote([runtimePaths.activationJournal])}`,
			);
		} catch (journalError) {
			await appendDeploymentLog(
				buildServerId,
				deployment.logPath,
				`\nWarning: release is active but the activation journal could not be finalized: ${
					journalError instanceof Error
						? journalError.message
						: String(journalError)
				}\n`,
			);
		}
	} catch (error) {
		if (routeSwitched && !promoted && runtimePaths && candidateState) {
			try {
				let restoreRouter = getRemoveTraefikConfigCommand(
					runtimePaths.traefikRouter,
				);
				if (previousState) {
					const previousRouterConfig = createComposeReleaseTraefikRouterConfig({
						appName: compose.appName,
						domains: compose.domains,
						candidate: previousState,
					});
					restoreRouter = `${installRuntimeFileAtomically(
						previousState.routerConfigPath,
						runtimePaths.traefikRouter,
					)} && ${getWaitTraefikRoutersCommand(
						traefikRouterTargets(previousRouterConfig),
					)}`;
				} else if (legacyFallback) {
					const legacyRouterTargets = Object.fromEntries(
						composeRouterNames(compose.appName, compose.domains).map((name) => [
							name,
							name,
						]),
					);
					restoreRouter = `${restoreRouter} && ${getWaitTraefikRoutersCommand(
						legacyRouterTargets,
						30,
						"docker",
					)}`;
				}
				await runRuntimeStage(
					runtimeServerId,
					buildServerId,
					deployment.logPath,
					"Deploy: rollback traffic",
					restoreRouter,
				);
				routeSwitched = false;
			} catch {
				// Keep the candidate and journal intact: the failover router still
				// references it, and the next activation can retry recovery safely.
			}
		}
		if (!promoted && candidateState && !routeSwitched) {
			try {
				if (runtimeMutationAttempted) {
					await cleanupRuntimeRelease(
						runtimeServerId,
						candidateState,
						validation?.zeroDowntime.drainSeconds ||
							DEFAULT_RUNTIME_DRAIN_SECONDS,
					);
				} else {
					await executeOnServer(
						runtimeServerId,
						getRemoveRuntimeReleaseCommand(candidateState),
					);
				}
				candidateCleanupComplete = true;
			} catch {
				// Preserve the original deployment failure.
			}
		}
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
		if (
			runtimePaths &&
			candidateCleanupComplete &&
			interruptedRecoveryComplete
		) {
			try {
				await executeOnServer(
					runtimeServerId,
					`rm -f ${quote([runtimePaths.activationJournal])}`,
				);
			} catch {
				// Preserve the original deployment failure.
			}
		}
		throw error;
	} finally {
		try {
			await executeOnServer(
				runtimeServerId,
				`rm -f ${quote([cancellationPath])}`,
			);
		} catch {
			// A stale cancellation request is cleared by the next deployment.
		}
		if (lockAcquired && runtimePaths) {
			try {
				await executeOnServer(
					runtimeServerId,
					getReleaseComposeActivationLockCommand(runtimePaths.lockDirectory),
				);
			} catch {
				// A stale lock is reclaimed by the next activation.
			}
		}
	}
};

export const requestComposeDeploymentCancellation = async (
	composeId: string,
) => {
	const compose = await findComposeById(composeId);
	if (!compose.buildServerId || !compose.buildRegistryId) return false;
	const cancellationRequest = getRuntimeComposePaths(
		compose,
		"cancel",
	).cancellationRequest;
	await executeOnServer(
		compose.serverId,
		`mkdir -p ${quote([
			dirname(cancellationRequest),
		])} && touch ${quote([cancellationRequest])}`,
	);
	return true;
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
		const activeRelease =
			compose.composeType === "docker-compose"
				? await readRuntimeJson<ComposeRuntimeReleaseState>(
						compose.serverId,
						runtimePaths.activeState,
					)
				: null;

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
			const activeCleanup = activeRelease
				? `${getRuntimeReleaseDownCommand(
						activeRelease,
						DEFAULT_RUNTIME_DRAIN_SECONDS,
						deleteVolumes,
					)} || true;`
				: "";
			const legacyManifest = `[ -f ${quote([runtimePaths.active])} ] && printf %s ${quote(
				[runtimePaths.active],
			)} || printf %s ${quote([join(codePath, sourcePath)])}`;
			const command = `
				${getRemoveTraefikConfigCommand(runtimePaths.traefikRouter)};
				${activeCleanup}
				legacy_containers="$(docker ps -aq --filter label=com.docker.compose.project=${quote(
					[compose.appName],
				)})";
				if [ -n "$legacy_containers" ]; then
					legacy_manifest="$(${legacyManifest})";
					if [ -f "$legacy_manifest" ]; then
						env -i PATH="$PATH" HOME="$HOME" docker compose -p ${quote([
							compose.appName,
						])} -f "$legacy_manifest" down ${deleteVolumes ? "--volumes" : ""} || true;
					fi;
				fi;
				containers="$(docker ps -aq --filter label=com.dokploy.compose-id=${quote(
					[compose.composeId],
				)})";
				projects="";
				if [ -n "$containers" ]; then
					projects="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' $containers | sort -u)";
					docker rm -f ${deleteVolumes ? "-v " : ""}$containers;
				fi;
				for project in $projects; do
					networks="$(docker network ls -q --filter label=com.docker.compose.project="$project")";
					if [ -n "$networks" ]; then docker network rm $networks >/dev/null 2>&1 || true; fi;
				done;
				find ${quote([
					paths(!!compose.serverId).DYNAMIC_TRAEFIK_PATH,
				])} -maxdepth 1 -type f -name ${quote([
					`${compose.appName}.zdt.*.yml`,
				])} -delete;
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
		const activeRelease = await readRuntimeJson<ComposeRuntimeReleaseState>(
			compose.serverId,
			runtimePaths.activeState,
		);
		const baseCommand = activeRelease
			? (() => {
					const activeRouterConfig = createComposeReleaseTraefikRouterConfig({
						appName: compose.appName,
						domains: compose.domains,
						candidate: activeRelease,
					});
					return `${getRuntimeDeployCommand(
						activeRelease.projectName,
						activeRelease.manifestPath,
					)} && ${installRuntimeFileAtomically(
						join(dirname(activeRelease.manifestPath), "service.yml"),
						activeRelease.serviceConfigPath,
					)} && ${getWaitTraefikServicesCommand(
						Object.values(activeRelease.domainServices),
						DEFAULT_RUNTIME_DRAIN_SECONDS,
					)} && ${installRuntimeFileAtomically(
						activeRelease.routerConfigPath,
						runtimePaths.traefikRouter,
					)} && ${getWaitTraefikRoutersCommand(
						traefikRouterTargets(activeRouterConfig),
					)}`;
				})()
			: `if [ -f ${quote([runtimePaths.active])} ]; then env -i PATH="$PATH" HOME="$HOME" docker compose -p ${quote([compose.appName])} -f ${quote([runtimePaths.active])} up -d --no-build --pull never; else cd ${quote([projectPath])} && env -i PATH="$PATH" HOME="$HOME" docker compose -p ${quote([compose.appName])} -f ${quote([path])} up -d; fi`;
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
			const activeRelease = await readRuntimeJson<ComposeRuntimeReleaseState>(
				compose.serverId,
				runtimePaths.activeState,
			);
			const command = activeRelease
				? `${getRemoveTraefikConfigCommand(
						runtimePaths.traefikRouter,
					)} && env -i PATH="$PATH" HOME="$HOME" docker compose -p ${quote([
						activeRelease.projectName,
					])} -f ${quote([
						activeRelease.manifestPath,
					])} stop --timeout ${DEFAULT_RUNTIME_DRAIN_SECONDS}`
				: `if [ -f ${quote([runtimePaths.active])} ]; then env -i PATH="$PATH" HOME="$HOME" docker compose -p ${quote([compose.appName])} -f ${quote([runtimePaths.active])} stop; else cd ${quote([projectPath])} && env -i PATH="$PATH" HOME="$HOME" docker compose -p ${quote([compose.appName])} -f ${quote([sourcePath])} stop; fi`;
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
