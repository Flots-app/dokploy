import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { paths } from "@dokploy/server/constants";
import { quote } from "shell-quote";
import { stringify } from "yaml";
import { getCreateEnvFileCommand } from "../utils/builders/compose";
import { getComposeRegistryLoginCommand } from "../utils/builders/compose-build-server";
import {
	ComposePreviewError,
	isComposePreviewError,
	isolatePreviewCompose,
} from "../utils/docker/compose-preview";
import {
	assignPreviewImages,
	createPreviewStack,
	findPushedImageDigest,
	formatPreviewStackTasks,
	getPreviewStackTasksCommand,
	previewImageRemovalReferences,
	previewServiceName,
} from "../utils/docker/compose-preview-stack";
import { collectContainerDiagnostics } from "../utils/docker/deployment-diagnostics";
import { loadDockerComposeRemote } from "../utils/docker/domain";
import type { ComposeSpecification } from "../utils/docker/types";
import { encodeBase64 } from "../utils/docker/utils";
import { formatDeploymentError } from "../utils/process/deployment-error";
import { ExecError } from "../utils/process/ExecError";
import {
	execAsync,
	execAsyncRemote,
	execFileAsync,
} from "../utils/process/execAsync";
import { cloneGithubRepository } from "../utils/providers/github";
import { getRemoteDocker } from "../utils/servers/remote-docker";
import { findComposeById, updateCompose } from "./compose";
import { createDeploymentCompose, updateDeployment } from "./deployment";
import { readPreviewFirewall } from "./preview-firewall";
import { findRegistryByIdWithCredentials } from "./registry";
import { findServerById } from "./server";

/**
 * Atomically write a private file on a worker (or on the local Dokploy host
 * when `serverId` is null). Contents go through stdin: a single command
 * argument is capped at 128 KiB on Linux (MAX_ARG_STRLEN).
 */
async function writeRemoteFile(
	serverId: string | null,
	file: string,
	contents: string | { base64: string },
) {
	const temporary = `${file}.tmp`;
	const base64 =
		typeof contents === "string" ? encodeBase64(contents) : contents.base64;
	await runPreviewManager(
		serverId,
		`set -e; mkdir -p ${quote([dirname(file)])}; umask 077; base64 -d > ${quote([temporary])}; mv ${quote([temporary, file])}`,
		base64,
	);
}

async function removeIfPresent(remove: () => Promise<unknown>) {
	try {
		await remove();
	} catch (error) {
		if ((error as { statusCode?: number }).statusCode !== 404) throw error;
	}
}

// Finish every independent operation before releasing the lifecycle lock,
// including when one fails. Dependent phases remain sequential.
function assertCompleted(results: PromiseSettledResult<unknown>[]) {
	const failure = results.find((result) => result.status === "rejected");
	if (failure?.status === "rejected") throw failure.reason;
}

export async function cleanupComposePreviewStack(
	instance: Awaited<ReturnType<typeof findComposeById>>,
	previewId: string,
) {
	if (!instance.previewParentId || !instance.serverId)
		throw new ComposePreviewError("Preview ownership mismatch");
	const worker = await assertPreviewSwarmWorker(instance.serverId, false);
	if (worker.organizationId !== instance.environment.project.organizationId)
		throw new ComposePreviewError("Preview worker ownership mismatch");
	const manager = await getRemoteDocker(worker.swarmManagerId);
	const services = await manager.listServices({
		filters: JSON.stringify({
			label: [`com.docker.stack.namespace=${instance.appName}`],
		}),
	});
	if (
		services.some(
			(service) =>
				service.Spec?.Labels?.["com.dokploy.compose-preview"] !== previewId,
		)
	)
		throw new ComposePreviewError("Preview stack ownership mismatch");
	const ingress = join(
		paths(!!worker.swarmManagerId).DYNAMIC_TRAEFIK_PATH,
		`${instance.appName}.yml`,
	);
	await runPreviewManager(
		worker.swarmManagerId,
		`rm -f -- ${quote([ingress])}`,
	);
	const network = `${instance.appName}_default`;
	const engine = await getRemoteDocker(instance.serverId);
	const networks = await engine.listNetworks({
		filters: JSON.stringify({ name: [network] }),
	});
	if (networks.some((entry) => entry.Name === network)) {
		await execAsyncRemote(
			instance.serverId,
			`docker network disconnect ${quote([network])} dokploy-traefik || true`,
		);
	}
	if (services.length)
		await runPreviewManager(
			worker.swarmManagerId,
			`docker stack rm ${quote([instance.appName])}`,
		);
	const deadline = Date.now() + 120000;
	while (true) {
		const remaining = await engine.listContainers({
			all: true,
			filters: JSON.stringify({
				label: [`com.dokploy.preview-id=${previewId}`],
			}),
		});
		const running = remaining.filter(
			(container) => container.State === "running",
		);
		if (!running.length) {
			assertCompleted(
				await Promise.allSettled(
					remaining.map((container) =>
						removeIfPresent(() =>
							engine.getContainer(container.Id).remove({ v: true }),
						),
					),
				),
			);
			break;
		}
		if (Date.now() >= deadline)
			throw new ComposePreviewError(
				"Preview cleanup is waiting for Swarm tasks to stop",
			);
		await delay(2000);
	}
	const leftover = await manager.listNetworks({
		filters: JSON.stringify({
			label: [`com.docker.stack.namespace=${instance.appName}`],
		}),
	});
	assertCompleted(
		await Promise.allSettled(
			leftover.map((entry) =>
				removeIfPresent(() => manager.getNetwork(entry.Id).remove()),
			),
		),
	);
	const volumes = await engine.listVolumes({
		filters: JSON.stringify({ label: [`com.dokploy.preview-id=${previewId}`] }),
	});
	assertCompleted(
		await Promise.allSettled(
			(volumes.Volumes || []).map((volume) =>
				removeIfPresent(() => engine.getVolume(volume.Name).remove()),
			),
		),
	);
	await cleanupUnusedPreviewResources(
		instance.serverId,
		worker.swarmManagerId,
		instance.appName,
		previewId,
	);
	await execAsyncRemote(
		instance.serverId,
		`rm -rf -- ${quote([join(paths(true).COMPOSE_PATH, instance.appName), join(paths(true).LOGS_PATH, instance.appName)])}`,
	);
	await runPreviewManager(
		worker.swarmManagerId,
		`rm -rf -- ${quote([join(paths(!!worker.swarmManagerId).COMPOSE_PATH, instance.appName)])}`,
	);
}

/** Run on the Swarm manager: a remote server, or the Dokploy host when null.
 * `input` goes to stdin, never to the command line (`ps` shows arguments). */
export const runPreviewManager = (
	serverId: string | null,
	command: string,
	input?: string,
) =>
	serverId
		? execAsyncRemote(serverId, command, undefined, input)
		: input === undefined
			? execAsync(command)
			: execFileAsync("sh", ["-c", command], { input });

function escapeInterpolation(value: unknown): unknown {
	if (typeof value === "string") return value.replaceAll("$", "$$$$");
	if (Array.isArray(value)) return value.map(escapeInterpolation);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [
				key,
				escapeInterpolation(item),
			]),
		);
	return value;
}

export async function assertPreviewSwarmWorker(
	workerId: string,
	requireReady = true,
) {
	const worker = await findServerById(workerId);
	if (!worker.swarmNodeId || !worker.sshKeyId || worker.serverType !== "deploy")
		throw new ComposePreviewError(
			"Configure this server's Swarm worker settings first",
		);
	// Cleanup (requireReady false) must still work after a server is released.
	if (requireReady && !worker.previewOnly)
		throw new ComposePreviewError(
			"Reserve this server for Compose previews first: PR code never shares a server with regular services",
		);
	if (worker.swarmManagerId) {
		const managerServer = await findServerById(worker.swarmManagerId);
		if (
			managerServer.organizationId !== worker.organizationId ||
			!managerServer.sshKeyId
		)
			throw new ComposePreviewError(
				"Preview manager ownership or SSH configuration mismatch",
			);
	}
	const engine = await getRemoteDocker(workerId);
	const info = await engine.info();
	if (info.Swarm?.NodeID !== worker.swarmNodeId || info.Swarm?.ControlAvailable)
		throw new ComposePreviewError(
			"The SSH endpoint must be the selected Swarm worker's Docker engine",
		);
	const manager = await getRemoteDocker(worker.swarmManagerId);
	const node = await manager.getNode(worker.swarmNodeId).inspect();
	if (
		node.Spec.Role !== "worker" ||
		(requireReady &&
			(node.Status.State !== "ready" || node.Spec.Availability !== "active"))
	)
		throw new ComposePreviewError(
			"Preview Swarm worker is not ready and active",
		);
	return worker;
}

/** Longest a PR image build may run before it is killed. */
const PREVIEW_BUILD_TIMEOUT_SECONDS = 30 * 60;
/** Longest a single image push may run before it is killed. */
const PREVIEW_PUSH_TIMEOUT_SECONDS = 15 * 60;
/** Longest the stack may take to become healthy after activation. */
const PREVIEW_HEALTH_TIMEOUT_MS = 5 * 60_000;
/** Every task must stay running (and healthy) this long to count as ready. */
const PREVIEW_STABLE_MS = 20_000;
/** Builds need room for layers and the build cache. */
const PREVIEW_MIN_FREE_DISK_KIB = 10 * 1024 * 1024;

export async function deployComposePreviewStack(
	composeId: string,
	previewId: string,
) {
	const instance = await findComposeById(composeId);
	if (
		!instance.previewParentId ||
		!instance.serverId ||
		!instance.previewSettings ||
		!instance.previewCommitSha
	)
		throw new ComposePreviewError("Invalid preview instance");
	const workerId = instance.serverId;
	const settings = instance.previewSettings;
	// Record the attempt first, so every later failure has a log to read.
	let deployment: Awaited<ReturnType<typeof createDeploymentCompose>>;
	try {
		deployment = await createDeploymentCompose({
			composeId,
			title: "Build and deploy PR stack",
			description: `Commit: ${instance.previewCommitSha}`,
		});
	} catch (error) {
		console.error(
			`[compose-preview ${previewId}] unable to create the deployment log on worker ${workerId}: ${formatDeploymentError(error)}`,
		);
		throw new ComposePreviewError(
			"Preview worker is unreachable over SSH; check the server in Dokploy",
		);
	}
	const generation = deployment.deploymentId;
	const codePath = join(paths(true).COMPOSE_PATH, instance.appName, "code");
	const buildFile = join(codePath, instance.composePath);
	const log = (command: string) =>
		execAsyncRemote(
			workerId,
			`(${command}) >> ${quote([deployment.logPath])} 2>&1`,
		);
	// Streamed through stdin: a command argument is capped at 128 KiB on Linux.
	const appendLog = (content: string) =>
		execAsyncRemote(
			workerId,
			`cat >> ${quote([deployment.logPath])}`,
			undefined,
			content,
		);
	const step = async (name: string) => {
		phase = name;
		await appendLog(`\n===== ${name} =====\n`);
	};
	let phase = "initialization";
	let stackDeployed = false;
	let managerId: string | null = null;
	try {
		await step("Preview worker checks");
		const worker = await assertPreviewSwarmWorker(workerId);
		managerId = worker.swarmManagerId;
		if (worker.organizationId !== instance.environment.project.organizationId)
			throw new ComposePreviewError("Preview worker ownership mismatch");
		const firewall = await readPreviewFirewall(workerId);
		if (!firewall.healthy)
			throw new ComposePreviewError(
				`Preview firewall is not healthy: ${firewall.reason ?? "unknown state"}`,
			);
		const registry = await findRegistryByIdWithCredentials(settings.registryId);
		if (registry.organizationId !== instance.environment.project.organizationId)
			throw new ComposePreviewError(
				"Preview registry belongs to another organization",
			);
		const managerDirectory = join(
			paths(!!managerId).COMPOSE_PATH,
			instance.appName,
		);
		const stackFile = join(managerDirectory, "preview-stack.yml");
		const free = await execAsyncRemote(
			workerId,
			"df -Pk /var/lib/docker | awk 'NR==2 {print $4}'",
		);
		if (Number(free.stdout.trim()) < PREVIEW_MIN_FREE_DISK_KIB)
			throw new ComposePreviewError(
				`Preview worker has less than 10 GiB free in /var/lib/docker (${Math.floor(Number(free.stdout.trim()) / 1048576)} GiB); close PRs or free disk space`,
			);

		await step(`GitHub checkout of ${instance.previewCommitSha.slice(0, 12)}`);
		await updateCompose(composeId, { composeStatus: "running" });
		await log(await cloneGithubRepository({ ...instance, type: "compose" }));
		await checkRepositoryPaths(workerId, codePath, [
			buildFile,
			join(dirname(buildFile), ".env"),
		]);

		await step("Compose validation");
		const raw = await loadDockerComposeRemote(instance);
		if (!raw)
			throw new ComposePreviewError(
				`Compose file ${instance.composePath} was not found in the PR branch`,
			);
		const specification = assignPreviewImages(
			isolatePreviewCompose(raw, instance.appName, settings),
			instance.appName,
			generation,
			registry,
		);
		const repositoryFiles: string[] = [];
		for (const service of Object.values(specification.services || {})) {
			if (service.build) {
				const build =
					typeof service.build === "string"
						? { context: service.build }
						: service.build;
				const context = resolve(dirname(buildFile), build.context || ".");
				repositoryFiles.push(
					context,
					resolve(context, build.dockerfile || "Dockerfile"),
				);
			}
			for (const entry of Array.isArray(service.env_file)
				? service.env_file
				: service.env_file
					? [service.env_file]
					: [])
				repositoryFiles.push(
					resolve(
						dirname(buildFile),
						typeof entry === "string" ? entry : entry.path,
					),
				);
		}
		for (const entry of Object.values({
			...specification.configs,
			...specification.secrets,
		}))
			if (entry && typeof entry.file === "string")
				repositoryFiles.push(resolve(dirname(buildFile), entry.file));
		await checkRepositoryPaths(workerId, codePath, repositoryFiles);
		await writeRemoteFile(workerId, buildFile, stringify(specification));
		await log(`set -e; ${getCreateEnvFileCommand(instance, generation)}`);
		const composeCommand = `env -i PATH="$PATH" HOME="$HOME" docker compose --env-file ${quote([join(dirname(buildFile), ".env")])} -p ${quote([instance.appName])} -f ${quote([buildFile])}`;
		let config: ComposeSpecification;
		try {
			const resolved = await execAsyncRemote(
				workerId,
				`${composeCommand} config --format json`,
			);
			config = JSON.parse(resolved.stdout) as ComposeSpecification;
		} catch (error) {
			const detail =
				error instanceof ExecError
					? (error.stderr ?? "").trim().split("\n").pop()
					: "";
			throw new ComposePreviewError(
				`docker compose config rejected the preview file${detail ? `: ${detail.slice(0, 200)}` : ""}`,
			);
		}
		await execAsyncRemote(
			workerId,
			getComposeRegistryLoginCommand(registry),
			undefined,
			registry.password,
		);

		await step("Image build");
		await log(
			`timeout -k 30 ${PREVIEW_BUILD_TIMEOUT_SECONDS} ${composeCommand} build --pull`,
		);
		const builtImages = [
			...new Set(
				Object.values(config.services || {})
					.filter((service) => service.build)
					.map((service) => service.image)
					.filter((image): image is string => !!image),
			),
		];

		await step("Image publishing");
		assertCompleted(
			await Promise.allSettled(
				builtImages.map(async (image) => {
					await log(
						`timeout -k 30 ${PREVIEW_PUSH_TIMEOUT_SECONDS} docker push ${quote([image])}`,
					);
					const inspected = await execAsyncRemote(
						workerId,
						`docker image inspect ${quote([image])} --format '{{json .RepoDigests}}'`,
					);
					const digest = findPushedImageDigest(
						image,
						JSON.parse(inspected.stdout) as string[],
					);
					if (!digest)
						throw new ComposePreviewError(
							`Registry did not return an immutable digest for ${image}`,
						);
					for (const service of Object.values(config.services || {}))
						if (service.image === image) service.image = digest;
				}),
			),
		);

		await step("Swarm manifest preparation");
		const manager = await getRemoteDocker(managerId);
		const listStackServices = () =>
			manager.listServices({
				filters: JSON.stringify({
					label: [`com.docker.stack.namespace=${instance.appName}`],
				}),
			});
		const existing = await listStackServices();
		if (
			existing.some(
				(service) =>
					service.Spec?.Labels?.["com.dokploy.compose-preview"] !== previewId,
			)
		)
			throw new ComposePreviewError("Preview stack ownership mismatch");
		const stack = createPreviewStack(config, {
			appName: instance.appName,
			previewId,
			nodeId: worker.swarmNodeId as string,
			generation,
			domains: instance.domains,
		});
		const repositoryEntries = Object.entries({
			configs: stack.configs,
			secrets: stack.secrets,
		}).flatMap(([kind, entries]) =>
			Object.entries(entries || {}).map(([name, entry]) => ({
				kind,
				name,
				entry,
			})),
		);
		assertCompleted(
			await Promise.allSettled(
				repositoryEntries.map(async ({ kind, name, entry }) => {
					if (!entry || typeof entry.file !== "string")
						throw new ComposePreviewError(
							"Preview configs and secrets must use repository files",
						);
					const checked = await execAsyncRemote(
						workerId,
						`set -e; resolved="$(realpath ${quote([entry.file])})"; case "$resolved" in ${quote([`${codePath}/`])}*) base64 "$resolved";; *) echo 'Preview repository path escapes its checkout' >&2; exit 1;; esac`,
					);
					const target = join(managerDirectory, kind, name);
					await writeRemoteFile(managerId, target, {
						base64: checked.stdout.replace(/\s/g, ""),
					});
					entry.file = target;
				}),
			),
		);
		await writeRemoteFile(
			managerId,
			stackFile,
			stringify(escapeInterpolation(stack)),
		);
		// Stack schema 3.12 (process limits) needs Docker CLI 25 or later.
		const cli = await runPreviewManager(
			managerId,
			"docker version --format '{{.Client.Version}}'",
		);
		if (!(Number.parseInt(cli.stdout.trim(), 10) >= 25))
			throw new ComposePreviewError(
				`The Swarm manager runs Docker CLI ${cli.stdout.trim()}; PR environments need Docker 25 or later`,
			);
		// The manager needs registry auth to distribute credentials with tasks.
		await runPreviewManager(
			managerId,
			getComposeRegistryLoginCommand(registry),
			registry.password,
		);

		await step("Swarm stack deployment");
		stackDeployed = true;
		await runPreviewManager(
			managerId,
			`docker stack deploy --with-registry-auth --resolve-image always --prune -c ${quote([stackFile])} ${quote([instance.appName])}`,
		);
		const services = await listStackServices();
		if (
			services.length !== Object.keys(stack.services || {}).length ||
			services.some(
				(service) =>
					service.Spec?.Labels?.["com.dokploy.compose-preview"] !== previewId,
			)
		)
			throw new ComposePreviewError(
				"Preview stack ownership mismatch after deployment",
			);
		if (
			services.some(
				(service) => !service.Spec?.TaskTemplate?.Resources?.Limits?.Pids,
			)
		) {
			// Fail closed: never leave this PR's tasks running without their
			// process limit (the stack is verified to be this preview's above).
			await runPreviewManager(
				managerId,
				`docker stack rm ${quote([instance.appName])}`,
			).catch(() => {});
			throw new ComposePreviewError(
				"Swarm did not apply the process limit to the PR services; the stack was removed. Check the manager's Docker version",
			);
		}

		await step("Health checks");
		await waitForPreviewStack(
			workerId,
			previewId,
			generation,
			Object.keys(stack.services || {}).length,
		);
		// Swarm may have rolled a failing service back to the previous commit:
		// its old tasks would then look healthy, so check the update state too.
		const rolledBack = (await listStackServices()).filter((service) =>
			service.UpdateStatus?.State?.startsWith("rollback"),
		);
		if (rolledBack.length)
			throw new ComposePreviewError(
				`Swarm rolled back ${rolledBack.map((service) => previewServiceName(instance.appName, service.Spec?.Name || "")).join(", ")} to the previous commit because the new version failed to start`,
			);
		await execAsyncRemote(
			workerId,
			`docker network inspect ${quote([`${instance.appName}_default`])} --format '{{json .Containers}}' | grep -q '"Name":"dokploy-traefik"' || docker network connect ${quote([`${instance.appName}_default`])} dokploy-traefik`,
		);

		await step("Preview ingress");
		await writePreviewIngress(instance, managerId, worker.ipAddress);

		phase = "unused preview resource cleanup";
		await cleanupUnusedPreviewResources(
			workerId,
			managerId,
			instance.appName,
			previewId,
		);
		await appendLog("\n✅ PR environment is ready\n");
		await updateDeployment(deployment.deploymentId, {
			status: "done",
			finishedAt: new Date().toISOString(),
		});
		await updateCompose(composeId, { composeStatus: "done" });
	} catch (error) {
		// Our own messages are safe to show. Anything else may carry command
		// text, so it only goes to the deployment log, formatted and redacted.
		const reason = isComposePreviewError(error) ? error.message : undefined;
		const failure = reason
			? `Preview failed during ${phase.toLowerCase()}: ${reason}`
			: `Preview failed during ${phase.toLowerCase()}; see the deployment log`;
		console.error(
			`[compose-preview ${previewId}] deployment ${deployment.deploymentId} failed during ${phase}: ${formatDeploymentError(error).split("\n")[0]}`,
		);
		await appendLog(
			`\n❌ ${failure}\n${reason ? "" : `${formatDeploymentError(error)}\n`}`,
		).catch(() => {});
		const diagnostics = stackDeployed
			? await capturePreviewDiagnostics(
					instance.appName,
					workerId,
					managerId,
					previewId,
					generation,
					appendLog,
				)
			: "";
		await updateDeployment(deployment.deploymentId, {
			status: "error",
			finishedAt: new Date().toISOString(),
			errorMessage: diagnostics ? `${failure}\n\n${diagnostics}` : failure,
		});
		await updateCompose(composeId, { composeStatus: "error" });
		throw new ComposePreviewError(failure);
	}
}

/**
 * Records Swarm task errors and the state and logs of every container of the
 * failed generation. Swarm replaces failing tasks and prunes their containers,
 * so this is the only durable copy. Never throws.
 */
async function capturePreviewDiagnostics(
	appName: string,
	workerId: string,
	managerId: string | null,
	previewId: string,
	generation: string,
	appendLog: (content: string) => Promise<unknown>,
) {
	const summaries: string[] = [];
	try {
		let tasks: ReturnType<typeof formatPreviewStackTasks>;
		try {
			const { stdout } = await runPreviewManager(
				managerId,
				getPreviewStackTasksCommand(appName),
			);
			tasks = formatPreviewStackTasks(stdout, appName);
		} catch (error) {
			const message = `Swarm task diagnostics could not be collected: ${formatDeploymentError(error).replace(/\n+/g, " ")}`;
			tasks = {
				section: `\n===== Diagnostics: Swarm tasks =====\n${message}\n`,
				summary: message,
			};
		}
		await appendLog(tasks.section);
		if (tasks.summary) summaries.push(tasks.summary);
		const containers = await collectContainerDiagnostics(
			(command) => execAsyncRemote(workerId, command),
			{
				labels: [
					`com.dokploy.preview-id=${previewId}`,
					`com.dokploy.preview-generation=${generation}`,
				],
				serviceLabel: "com.docker.swarm.service.name",
				title: "Diagnostics: preview containers",
				serviceName: (name) => previewServiceName(appName, name),
			},
		);
		summaries.push(containers.summary);
		await appendLog(containers.report);
	} catch {
		// Preserve the original deployment failure.
	}
	return summaries.join("\n\n");
}

async function cleanupUnusedPreviewResources(
	workerId: string,
	managerId: string | null,
	appName: string,
	previewId: string,
) {
	const engine = await getRemoteDocker(workerId);
	const [images, containers] = await Promise.all([
		engine.listImages({
			filters: JSON.stringify({
				label: [`com.dokploy.preview-app=${appName}`],
			}),
		}),
		engine.listContainers({ all: true }),
	]);
	const inUse = new Set(containers.map((container) => container.ImageID));
	const references = images.flatMap((image) =>
		previewImageRemovalReferences(image, appName, inUse),
	);
	assertCompleted(
		await Promise.allSettled(
			references.map(async (reference) => {
				try {
					await engine.getImage(reference).remove();
				} catch (error) {
					if (
						![404, 409].includes(
							(error as { statusCode?: number }).statusCode || 0,
						)
					)
						throw error;
				}
			}),
		),
	);
	const manager = await getRemoteDocker(managerId);
	const filters = JSON.stringify({
		label: [`com.dokploy.preview-id=${previewId}`],
	});
	const [configs, secrets] = await Promise.all([
		manager.listConfigs({ filters }),
		manager.listSecrets({ filters }),
	]);
	assertCompleted(
		await Promise.allSettled(
			[
				...configs.map((entry) =>
					entry.ID ? manager.getConfig(entry.ID) : null,
				),
				...secrets.map((entry) =>
					entry.ID ? manager.getSecret(entry.ID) : null,
				),
			].map(async (resource) => {
				if (!resource) return;
				try {
					await resource.remove();
				} catch (error) {
					if (
						![400, 404, 409].includes(
							(error as { statusCode?: number }).statusCode || 0,
						)
					)
						throw error;
				}
			}),
		),
	);
}

async function checkRepositoryPaths(
	workerId: string,
	root: string,
	files: string[],
) {
	if (!files.length) return;
	try {
		await execAsyncRemote(
			workerId,
			`set -e; for file in ${quote(files)}; do resolved="$(realpath -m "$file")"; case "$resolved" in ${quote([root])}|${quote([`${root}/`])}*) ;; *) echo "$file" >&2; exit 3;; esac; done`,
		);
	} catch (error) {
		if (error instanceof ExecError && error.exitCode === 3)
			throw new ComposePreviewError(
				`${(error.stderr ?? "").trim().replace(`${root}/`, "")} resolves outside the repository checkout (symlink or ../ path)`,
			);
		throw error;
	}
}

/**
 * Wait until every service of this generation runs (and passes its
 * healthcheck) continuously for PREVIEW_STABLE_MS. A crash-looping service is
 * replaced by Swarm with a new container, which resets the window.
 */
async function waitForPreviewStack(
	workerId: string,
	previewId: string,
	generation: string,
	services: number,
) {
	const deadline = Date.now() + PREVIEW_HEALTH_TIMEOUT_MS;
	const docker = await getRemoteDocker(workerId);
	let stableSince: number | null = null;
	let stableSet = "";
	let lastProblem = "no container started yet";
	while (Date.now() < deadline) {
		const containers = await docker.listContainers({
			filters: JSON.stringify({
				label: [
					`com.dokploy.preview-id=${previewId}`,
					`com.dokploy.preview-generation=${generation}`,
				],
			}),
		});
		const inspected = await Promise.all(
			containers.map((container) =>
				docker.getContainer(container.Id).inspect(),
			),
		);
		const waiting = inspected.filter(
			(container) =>
				!container.State.Running ||
				(container.State.Health && container.State.Health.Status !== "healthy"),
		);
		if (containers.length === services && !waiting.length) {
			const ids = inspected
				.map((container) => container.Id)
				.sort()
				.join(",");
			if (ids !== stableSet) {
				stableSet = ids;
				stableSince = Date.now();
			}
			if (stableSince && Date.now() - stableSince >= PREVIEW_STABLE_MS) return;
		} else {
			stableSet = "";
			stableSince = null;
			lastProblem = waiting.length
				? waiting
						.map(
							(container) =>
								`${container.Config.Labels?.["com.docker.swarm.service.name"] || container.Name} is ${container.State.Health?.Status || container.State.Status}`,
						)
						.join(", ")
				: `${containers.length} of ${services} services have a running container`;
		}
		await delay(3000);
	}
	throw new ComposePreviewError(
		`Services did not stay healthy within ${PREVIEW_HEALTH_TIMEOUT_MS / 60_000} minutes (${lastProblem})`,
	);
}

export async function writePreviewIngress(
	instance: Awaited<ReturnType<typeof findComposeById>>,
	managerId: string | null,
	address: string,
) {
	const routers: Record<string, unknown> = {};
	for (const domain of instance.domains) {
		const rule = `Host(\`${domain.host}\`)`;
		const name = `${instance.appName}-${domain.uniqueConfigKey}`;
		routers[`${name}-web`] = {
			rule,
			entryPoints: ["web"],
			service: instance.appName,
			...(domain.https ? { middlewares: ["redirect-to-https@file"] } : {}),
		};
		if (domain.https)
			routers[`${name}-secure`] = {
				rule,
				entryPoints: ["websecure"],
				service: instance.appName,
				tls:
					domain.certificateType === "letsencrypt"
						? { certResolver: "letsencrypt" }
						: {},
			};
	}
	const config = {
		http: {
			routers,
			services: {
				[instance.appName]: {
					loadBalancer: {
						passHostHeader: true,
						servers: [{ url: `http://${address}:9080` }],
					},
				},
			},
		},
	};
	const file = join(
		paths(!!managerId).DYNAMIC_TRAEFIK_PATH,
		`${instance.appName}.yml`,
	);
	await writeRemoteFile(managerId, file, stringify(config));
}
