import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { paths } from "@dokploy/server/constants";
import { quote } from "shell-quote";
import { stringify } from "yaml";
import { getCreateEnvFileCommand } from "../utils/builders/compose";
import { getComposeRegistryLoginCommand } from "../utils/builders/compose-build-server";
import { isolatePreviewCompose } from "../utils/docker/compose-preview";
import {
	assignPreviewImages,
	createPreviewStack,
	previewImageRemovalReferences,
} from "../utils/docker/compose-preview-stack";
import { loadDockerComposeRemote } from "../utils/docker/domain";
import type { ComposeSpecification } from "../utils/docker/types";
import { encodeBase64 } from "../utils/docker/utils";
import { execAsync, execAsyncRemote } from "../utils/process/execAsync";
import { cloneGithubRepository } from "../utils/providers/github";
import { getRemoteDocker } from "../utils/servers/remote-docker";
import { findComposeById, updateCompose } from "./compose";
import { createDeploymentCompose, updateDeployment } from "./deployment";
import { readPreviewFirewall } from "./preview-firewall";
import { findRegistryByIdWithCredentials } from "./registry";
import { findServerById } from "./server";

const writeFile = (file: string, contents: string) =>
	`mkdir -p ${quote([dirname(file)])}; umask 077; printf %s ${quote([encodeBase64(contents)])} | base64 -d > ${quote([file])}`;

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
		throw new Error("Preview ownership mismatch");
	const worker = await assertPreviewSwarmWorker(instance.serverId, false);
	if (worker.organizationId !== instance.environment.project.organizationId)
		throw new Error("Preview worker ownership mismatch");
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
		throw new Error("Preview stack ownership mismatch");
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
			throw new Error("Preview cleanup is waiting for Swarm tasks to stop");
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

export const runPreviewManager = (serverId: string | null, command: string) =>
	serverId ? execAsyncRemote(serverId, command) : execAsync(command);

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
		throw new Error("Configure this server's Swarm worker settings first");
	if (worker.swarmManagerId) {
		const managerServer = await findServerById(worker.swarmManagerId);
		if (
			managerServer.organizationId !== worker.organizationId ||
			!managerServer.sshKeyId
		)
			throw new Error(
				"Preview manager ownership or SSH configuration mismatch",
			);
	}
	const engine = await getRemoteDocker(workerId);
	const info = await engine.info();
	if (info.Swarm?.NodeID !== worker.swarmNodeId || info.Swarm?.ControlAvailable)
		throw new Error(
			"The SSH endpoint must be the selected Swarm worker's Docker engine",
		);
	const manager = await getRemoteDocker(worker.swarmManagerId);
	const node = await manager.getNode(worker.swarmNodeId).inspect();
	if (
		node.Spec.Role !== "worker" ||
		(requireReady &&
			(node.Status.State !== "ready" || node.Spec.Availability !== "active"))
	)
		throw new Error("Preview Swarm worker is not ready and active");
	return worker;
}

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
		throw new Error("Invalid preview instance");
	const worker = await assertPreviewSwarmWorker(instance.serverId);
	if (worker.organizationId !== instance.environment.project.organizationId)
		throw new Error("Preview worker ownership mismatch");
	if (!(await readPreviewFirewall(instance.serverId)).healthy)
		throw new Error(
			"Preview firewall agents must be healthy before deployment",
		);
	const registry = await findRegistryByIdWithCredentials(
		instance.previewSettings.registryId,
	);
	if (registry.organizationId !== instance.environment.project.organizationId)
		throw new Error("Preview registry belongs to another organization");
	const deployment = await createDeploymentCompose({
		composeId,
		title: "Build and deploy PR stack",
		description: `Commit: ${instance.previewCommitSha}`,
	});
	const generation = deployment.deploymentId;
	const codePath = join(paths(true).COMPOSE_PATH, instance.appName, "code");
	const buildFile = join(codePath, instance.composePath);
	const managerDirectory = join(
		paths(!!worker.swarmManagerId).COMPOSE_PATH,
		instance.appName,
	);
	const stackFile = join(managerDirectory, "preview-stack.yml");
	const log = (command: string) =>
		execAsyncRemote(
			instance.serverId,
			`(${command}) >> ${quote([deployment.logPath])} 2>&1`,
		);
	let phase = "initialization";
	try {
		phase = "worker disk capacity check";
		await execAsyncRemote(
			instance.serverId,
			"test $(df -Pk /var/lib/docker | awk 'NR==2 {print $4}') -ge 10485760",
		);
		phase = "GitHub checkout";
		await updateCompose(composeId, { composeStatus: "running" });
		await log(await cloneGithubRepository({ ...instance, type: "compose" }));
		await checkRepositoryPaths(instance.serverId, codePath, [
			buildFile,
			join(dirname(buildFile), ".env"),
		]);
		phase = "Compose validation";
		const raw = await loadDockerComposeRemote(instance);
		if (!raw) throw new Error("Preview Compose file not found");
		const specification = assignPreviewImages(
			isolatePreviewCompose(raw, instance.appName, instance.previewSettings),
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
		await checkRepositoryPaths(instance.serverId, codePath, repositoryFiles);
		await log(
			`set -e; ${writeFile(buildFile, stringify(specification))}; ${getCreateEnvFileCommand(instance, generation)}`,
		);
		const composeCommand = `env -i PATH="$PATH" HOME="$HOME" docker compose --env-file ${quote([join(dirname(buildFile), ".env")])} -p ${quote([instance.appName])} -f ${quote([buildFile])}`;
		const resolved = await execAsyncRemote(
			instance.serverId,
			`${composeCommand} config --format json`,
		);
		const config = JSON.parse(resolved.stdout) as ComposeSpecification;
		await execAsyncRemote(
			instance.serverId,
			getComposeRegistryLoginCommand(registry),
			undefined,
			registry.password,
		);
		phase = "image build";
		await log(`${composeCommand} build --pull`);
		const builtImages = [
			...new Set(
				Object.values(config.services || {})
					.filter((service) => service.build)
					.map((service) => service.image)
					.filter((image): image is string => !!image),
			),
		];
		phase = "image publishing";
		assertCompleted(
			await Promise.allSettled(
				builtImages.map(async (image) => {
					await log(`docker push ${quote([image])}`);
					const inspected = await execAsyncRemote(
						instance.serverId,
						`docker image inspect ${quote([image])} --format '{{json .RepoDigests}}'`,
					);
					const digest = (JSON.parse(inspected.stdout) as string[]).find(
						(value) =>
							value.startsWith(`${image.slice(0, image.lastIndexOf(":"))}@`),
					);
					if (!digest)
						throw new Error(
							"Registry did not return an immutable preview image digest",
						);
					for (const service of Object.values(config.services || {}))
						if (service.image === image) service.image = digest;
				}),
			),
		);
		phase = "Swarm manifest preparation";
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
						throw new Error(
							"Preview configs and secrets must use repository files",
						);
					const source = entry.file;
					const checked = await execAsyncRemote(
						instance.serverId,
						`set -e; resolved="$(realpath ${quote([source])})"; case "$resolved" in ${quote([`${codePath}/`])}*) base64 "$resolved";; *) exit 1;; esac`,
					);
					const target = join(managerDirectory, kind, name);
					await runPreviewManager(
						worker.swarmManagerId,
						`mkdir -p ${quote([dirname(target)])}; umask 077; printf %s ${quote([checked.stdout.replace(/\s/g, "")])} | base64 -d > ${quote([target])}`,
					);
					entry.file = target;
				}),
			),
		);
		await runPreviewManager(
			worker.swarmManagerId,
			writeFile(stackFile, stringify(escapeInterpolation(stack))),
		);
		// Manager needs registry auth to distribute credentials with the task.
		if (worker.swarmManagerId)
			await execAsyncRemote(
				worker.swarmManagerId,
				getComposeRegistryLoginCommand(registry),
				undefined,
				registry.password,
			);
		else
			await execAsync(
				`printf %s ${quote([encodeBase64(registry.password)])} | base64 -d | ${getComposeRegistryLoginCommand(registry)}`,
			);
		phase = "Swarm stack deployment";
		await runPreviewManager(
			worker.swarmManagerId,
			`docker stack deploy --with-registry-auth --resolve-image always --prune -c ${quote([stackFile])} ${quote([instance.appName])}`,
		);
		// Stack's legacy Compose schema lacks the Swarm process limit. Services
		// are created stopped, then activated with their limit already applied.
		const manager = await getRemoteDocker(worker.swarmManagerId);
		const services = await manager.listServices({
			filters: JSON.stringify({
				label: [`com.docker.stack.namespace=${instance.appName}`],
			}),
		});
		if (
			services.length !== Object.keys(stack.services || {}).length ||
			services.some(
				(service) =>
					service.Spec?.Labels?.["com.dokploy.compose-preview"] !== previewId,
			)
		)
			throw new Error("Preview stack ownership mismatch before activation");
		assertCompleted(
			await Promise.allSettled(
				services.map(async (service) => {
					if (!service.ID) throw new Error("Preview service has no identity");
					await runPreviewManager(
						worker.swarmManagerId,
						`docker service update --detach --with-registry-auth --limit-pids 512 --replicas 1 ${quote([service.ID])}`,
					);
				}),
			),
		);
		phase = "Swarm task health checks";
		await waitForPreviewStack(
			instance.serverId,
			previewId,
			generation,
			Object.keys(stack.services || {}).length,
		);
		await execAsyncRemote(
			instance.serverId,
			`docker network inspect ${quote([`${instance.appName}_default`])} --format '{{json .Containers}}' | grep -q '"Name":"dokploy-traefik"' || docker network connect ${quote([`${instance.appName}_default`])} dokploy-traefik`,
		);
		phase = "preview ingress";
		await writePreviewIngress(
			instance,
			worker.swarmManagerId,
			worker.ipAddress,
		);
		phase = "unused preview resource cleanup";
		await cleanupUnusedPreviewResources(
			instance.serverId,
			worker.swarmManagerId,
			instance.appName,
			previewId,
		);
		await updateDeployment(deployment.deploymentId, {
			status: "done",
			finishedAt: new Date().toISOString(),
		});
		await updateCompose(composeId, { composeStatus: "done" });
	} catch {
		await updateDeployment(deployment.deploymentId, {
			status: "error",
			finishedAt: new Date().toISOString(),
			errorMessage: `Preview stack deployment failed during ${phase}; see deployment logs`,
		});
		await updateCompose(composeId, { composeStatus: "error" });
		// Remote execution errors contain command text, potentially credentials.
		throw new Error(
			`Preview stack deployment failed during ${phase}; see deployment logs`,
		);
	}
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
	await execAsyncRemote(
		workerId,
		`set -e; for file in ${quote(files)}; do resolved="$(realpath -m "$file")"; case "$resolved" in ${quote([root])}|${quote([`${root}/`])}*) ;; *) echo 'Preview repository path escapes its checkout' >&2; exit 1;; esac; done`,
	);
}

async function waitForPreviewStack(
	workerId: string,
	previewId: string,
	generation: string,
	services: number,
) {
	const deadline = Date.now() + 300000;
	const docker = await getRemoteDocker(workerId);
	while (Date.now() < deadline) {
		const containers = await docker.listContainers({
			filters: JSON.stringify({
				label: [
					`com.dokploy.preview-id=${previewId}`,
					`com.dokploy.preview-generation=${generation}`,
				],
			}),
		});
		if (containers.length === services) {
			const states = await Promise.all(
				containers.map(
					async (container) =>
						(await docker.getContainer(container.Id).inspect()).State,
				),
			);
			if (
				states.every(
					(state) =>
						state.Running &&
						(!state.Health || state.Health.Status === "healthy"),
				)
			)
				return;
		}
		await delay(3000);
	}
	throw new Error("Preview stack did not become healthy within five minutes");
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
	await runPreviewManager(
		managerId,
		`${writeFile(`${file}.tmp`, stringify(config))}; mv ${quote([`${file}.tmp`])} ${quote([file])}`,
	);
}
