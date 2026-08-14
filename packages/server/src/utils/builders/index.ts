import { findRegistryByIdWithCredentials } from "@dokploy/server/services/registry";
import type { InferResultType } from "@dokploy/server/types/with";
import type { CreateServiceOptions } from "dockerode";
import { getRegistryTag, uploadImageRemoteCommand } from "../cluster/upload";
import {
	calculateResources,
	generateBindMounts,
	generateConfigContainer,
	generateFileMounts,
	generateVolumeMounts,
	prepareEnvironmentVariables,
} from "../docker/utils";
import { getRemoteDocker } from "../servers/remote-docker";
import { getDockerCommand } from "./docker-file";
import { getHerokuCommand } from "./heroku";
import { getNixpacksCommand } from "./nixpacks";
import { getPaketoCommand } from "./paketo";
import { getRailpackCommand } from "./railpack";
import { getStaticCommand } from "./static";

// NIXPACKS codeDirectory = where is the path of the code directory
// HEROKU codeDirectory = where is the path of the code directory
// PAKETO codeDirectory = where is the path of the code directory
// DOCKERFILE codeDirectory = where is the exact path of the (Dockerfile)
export type ApplicationNested = InferResultType<
	"applications",
	{
		mounts: true;
		security: true;
		redirects: true;
		ports: true;
		registry: { columns: { password: false } };
		buildRegistry: { columns: { password: false } };
		rollbackRegistry: { columns: { password: false } };
		deployments: true;
		environment: { with: { project: true } };
	}
>;

export const getBuildCommand = async (application: ApplicationNested) => {
	let command = "";

	if (application.sourceType !== "docker") {
		const { buildType } = application;
		switch (buildType) {
			case "nixpacks":
				command = getNixpacksCommand(application);
				break;
			case "heroku_buildpacks":
				command = getHerokuCommand(application);
				break;
			case "paketo_buildpacks":
				command = getPaketoCommand(application);
				break;
			case "static":
				command = getStaticCommand(application);
				break;
			case "dockerfile":
				command = getDockerCommand(application);
				break;
			case "railpack":
				command = getRailpackCommand(application);
				break;
		}
	}

	if (
		application.registry ||
		application.buildRegistry ||
		application.rollbackRegistry
	) {
		command += await uploadImageRemoteCommand(application);
	}

	return command;
};

export const mechanizeDockerContainer = async (
	application: ApplicationNested,
	options: {
		runtimeImage?: string;
		deploymentId?: string;
		enforceZeroDowntime?: boolean;
	} = {},
) => {
	const {
		appName,
		env,
		mounts,
		cpuLimit,
		memoryLimit,
		memoryReservation,
		cpuReservation,
		command,
		args,
		ports,
	} = application;

	const resources = calculateResources({
		memoryLimit,
		memoryReservation,
		cpuLimit,
		cpuReservation,
	});

	const volumesMount = generateVolumeMounts(mounts);

	const {
		HealthCheck,
		RestartPolicy,
		Placement,
		Labels,
		Mode,
		RollbackConfig,
		UpdateConfig,
		Networks,
		StopGracePeriod,
		EndpointSpec,
		Ulimits,
	} = generateConfigContainer(application);

	const bindsMount = generateBindMounts(mounts);
	const filesMount = generateFileMounts(appName, application);
	const envVariables = prepareEnvironmentVariables(
		env,
		application.environment.project.env,
		application.environment.env,
	).filter((value) => !value.startsWith("DOKPLOY_DEPLOYMENT_ID="));
	if (options.deploymentId) {
		envVariables.push(`DOKPLOY_DEPLOYMENT_ID=${options.deploymentId}`);
	}

	const image = options.runtimeImage || (await getImageName(application));
	const authConfig = await getAuthConfig(application);
	const docker = await getRemoteDocker(application.serverId);
	const reservedLabels: Record<string, string> = options.deploymentId
		? {
				"com.dokploy.application-id": application.applicationId,
				"com.dokploy.deployment-id": options.deploymentId,
				"com.dokploy.runtime-service": appName,
			}
		: {};
	const zeroDowntimeUpdateConfig = options.enforceZeroDowntime
		? {
				Parallelism: 1,
				Order: "start-first",
				FailureAction: "rollback",
				Monitor: 30_000_000_000,
				MaxFailureRatio: 0,
			}
		: UpdateConfig;
	const zeroDowntimeRollbackConfig = options.enforceZeroDowntime
		? {
				Parallelism: 1,
				Order: "start-first",
				Monitor: 30_000_000_000,
				FailureAction: "pause",
			}
		: RollbackConfig;

	const settings: CreateServiceOptions = {
		authconfig: authConfig,
		Name: appName,
		Labels: reservedLabels,
		TaskTemplate: {
			ContainerSpec: {
				HealthCheck,
				Image: image,
				Env: envVariables,
				Mounts: [...volumesMount, ...bindsMount, ...filesMount],
				...(StopGracePeriod !== null &&
					StopGracePeriod !== undefined && { StopGracePeriod }),
				...(command && {
					Command: command.split(" "),
				}),
				...(args &&
					args.length > 0 && {
						Args: args,
					}),
				...(Ulimits && { Ulimits }),
				Labels: { ...(Labels || {}), ...reservedLabels },
			},
			Networks,
			RestartPolicy,
			Placement,
			Resources: {
				...resources,
			},
		},
		Mode,
		RollbackConfig: zeroDowntimeRollbackConfig,
		EndpointSpec: EndpointSpec
			? EndpointSpec
			: {
					Ports: ports.map((port) => ({
						PublishMode: port.publishMode,
						Protocol: port.protocol,
						TargetPort: port.targetPort,
						PublishedPort: port.publishedPort,
					})),
				},
		UpdateConfig: zeroDowntimeUpdateConfig,
	};

	const service = docker.getService(appName);
	let inspect: Awaited<ReturnType<typeof service.inspect>>;
	try {
		inspect = await service.inspect();
	} catch (error) {
		if (
			typeof error !== "object" ||
			error === null ||
			!("statusCode" in error) ||
			error.statusCode !== 404
		) {
			throw error;
		}
		await docker.createService(settings);
		return;
	}

	await service.update({
		version: Number.parseInt(inspect.Version.Index),
		...settings,
		TaskTemplate: {
			...settings.TaskTemplate,
			ForceUpdate: inspect.Spec.TaskTemplate.ForceUpdate + 1,
		},
	});
};

const getImageName = async (application: ApplicationNested) => {
	const { appName, sourceType, dockerImage, registry, buildRegistry } =
		application;
	const imageName = `${appName}:latest`;
	if (sourceType === "docker") {
		return dockerImage || "ERROR-NO-IMAGE-PROVIDED";
	}

	if (registry) {
		const r = await findRegistryByIdWithCredentials(registry.registryId);
		return getRegistryTag(r, imageName);
	}
	if (buildRegistry) {
		const r = await findRegistryByIdWithCredentials(buildRegistry.registryId);
		return getRegistryTag(r, imageName);
	}

	return imageName;
};

export const getAuthConfig = async (application: ApplicationNested) => {
	const {
		registry,
		buildRegistry,
		username,
		password,
		sourceType,
		registryUrl,
	} = application;

	if (sourceType === "docker") {
		if (username && password) {
			return { password, username, serveraddress: registryUrl || "" };
		}
	} else if (registry) {
		const r = await findRegistryByIdWithCredentials(registry.registryId);
		return {
			password: r.password,
			username: r.username,
			serveraddress: r.registryUrl,
		};
	} else if (buildRegistry) {
		const r = await findRegistryByIdWithCredentials(buildRegistry.registryId);
		return {
			password: r.password,
			username: r.username,
			serveraddress: r.registryUrl,
		};
	}

	return undefined;
};
