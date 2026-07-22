import { join } from "node:path";
import { paths } from "@dokploy/server/constants";
import type { Registry } from "@dokploy/server/services/registry";
import type { ComposeSpecification } from "@dokploy/server/utils/docker/types";
import { encodeBase64 } from "@dokploy/server/utils/docker/utils";
import { quote } from "shell-quote";

export interface ComposeBuildServerSettings {
	appName: string;
	composePath: string;
	composeType: "docker-compose" | "stack";
	sourceType: string;
	command?: string | null;
	isolatedDeployment?: boolean;
}

export interface DokployComposeMount {
	type: "bind" | "volume" | "file";
	filePath?: string | null;
	hostPath?: string | null;
	mountPath?: string | null;
}

export interface ValidatedComposeBuild {
	builtServices: string[];
	builtImages: string[];
}

export interface ComposeBuildServerSelection {
	organizationId: string;
	accessibleServerIds: ReadonlySet<string>;
	server:
		| {
				serverId: string;
				organizationId: string;
				serverStatus: "active" | "inactive";
				serverType: "deploy" | "build";
				sshKeyId?: string | null;
		  }
		| null
		| undefined;
	registry: { organizationId: string } | null | undefined;
}

export const assertComposeBuildServerSelection = ({
	organizationId,
	accessibleServerIds,
	server,
	registry,
}: ComposeBuildServerSelection) => {
	if (!server || !accessibleServerIds.has(server.serverId)) {
		throw new Error("You are not authorized to access this build server");
	}
	if (
		server.organizationId !== organizationId ||
		server.serverStatus !== "active" ||
		server.serverType !== "build" ||
		!server.sshKeyId
	) {
		throw new Error(
			"The selected server must be an active Build Server in this organization",
		);
	}
	if (!registry || registry.organizationId !== organizationId) {
		throw new Error(
			"The selected registry must belong to the same organization",
		);
	}
};

const composeFile = (compose: ComposeBuildServerSettings) =>
	compose.sourceType === "raw" ? "docker-compose.yml" : compose.composePath;

const composeProjectPath = (compose: ComposeBuildServerSettings) =>
	join(paths(true).COMPOSE_PATH, compose.appName, "code");

const composeInvocation = (
	compose: ComposeBuildServerSettings,
	deploymentId: string,
	filePath: string,
) =>
	`env -i PATH="$PATH" HOME="$HOME" DOKPLOY_DEPLOYMENT_ID=${quote([deploymentId])} docker compose -p ${quote([compose.appName])} -f ${quote([filePath])}`;

export const assertComposeBuildServerSupported = (
	compose: ComposeBuildServerSettings,
) => {
	if (compose.composeType === "stack") {
		throw new Error(
			"Compose Build Servers V1 do not support Docker Stack; use composeType docker-compose",
		);
	}
	if (compose.sourceType === "raw") {
		throw new Error(
			"Compose Build Servers V1 require a Git source; raw Compose sources are not supported",
		);
	}
	if (compose.command?.trim()) {
		throw new Error(
			"Compose Build Servers V1 require the default Dokploy command; custom Compose commands are not supported",
		);
	}
};

export const getComposeConfigCommand = (
	compose: ComposeBuildServerSettings,
	deploymentId: string,
) => {
	const projectPath = composeProjectPath(compose);
	return `cd ${quote([projectPath])} && ${composeInvocation(
		compose,
		deploymentId,
		composeFile(compose),
	)} config --format json`;
};

export const getComposeBuildPushCommand = (
	compose: ComposeBuildServerSettings,
	deploymentId: string,
) => {
	const projectPath = composeProjectPath(compose);
	return `cd ${quote([projectPath])} && ${composeInvocation(
		compose,
		deploymentId,
		composeFile(compose),
	)} build --push`;
};

export const getComposeRegistryLoginCommand = (
	registry: Pick<Registry, "registryUrl" | "username">,
) =>
	`env HOME="$HOME" docker login ${registry.registryUrl ? `${quote([registry.registryUrl])} ` : ""}--username ${quote(
		[registry.username],
	)} --password-stdin`;

const registryNamespace = (
	registry: Pick<Registry, "registryUrl" | "imagePrefix" | "username">,
) => {
	const prefix = (registry.imagePrefix || registry.username).toLowerCase();
	return registry.registryUrl
		? `${registry.registryUrl.replace(/\/+$/, "")}/${prefix}/`
		: `${prefix}/`;
};

const imageTag = (image: string) => {
	if (image.includes("@")) return null;
	const lastSlash = image.lastIndexOf("/");
	const lastColon = image.lastIndexOf(":");
	return lastColon > lastSlash ? image.slice(lastColon + 1) : null;
};

const belongsToRegistry = (
	image: string,
	registry: Pick<Registry, "registryUrl" | "imagePrefix" | "username">,
) => {
	const namespace = registryNamespace(registry);
	if (image.startsWith(namespace)) return true;
	return !registry.registryUrl && image.startsWith(`docker.io/${namespace}`);
};

const shortVolumeUsesHostPath = (volume: string) => {
	const separator = volume.indexOf(":");
	if (separator === -1) return false;
	const source = volume.slice(0, separator);
	return (
		source.startsWith("/") ||
		source.startsWith(".") ||
		source.startsWith("~") ||
		source.includes("/")
	);
};

const validateRuntimeFiles = (
	specification: ComposeSpecification,
	mounts: DokployComposeMount[],
) => {
	for (const [serviceName, service] of Object.entries(
		specification.services || {},
	)) {
		for (const volume of service.volumes || []) {
			if (
				(typeof volume === "string" && shortVolumeUsesHostPath(volume)) ||
				(typeof volume === "object" && volume.type === "bind")
			) {
				throw new Error(
					`Service "${serviceName}" uses a bind mount; local runtime files are not supported with Compose Build Servers V1`,
				);
			}
		}
	}

	for (const [name, config] of Object.entries(specification.configs || {})) {
		if (config?.file) {
			throw new Error(
				`Config "${name}" uses configs.file; local runtime files are not supported with Compose Build Servers V1`,
			);
		}
	}

	for (const [name, secret] of Object.entries(specification.secrets || {})) {
		if (secret?.file) {
			throw new Error(
				`Secret "${name}" uses secrets.file; local runtime files are not supported with Compose Build Servers V1`,
			);
		}
	}

	const localMount = mounts.find(
		(mount) => mount.type === "bind" || mount.type === "file",
	);
	if (localMount) {
		throw new Error(
			`Dokploy ${localMount.type} mount "${localMount.mountPath || localMount.filePath || localMount.hostPath || "unknown"}" requires a local runtime file and is not supported with Compose Build Servers V1`,
		);
	}
};

export const validateComposeBuildServerSpecification = (
	specification: ComposeSpecification,
	registry: Pick<Registry, "registryUrl" | "imagePrefix" | "username">,
	deploymentId: string,
	mounts: DokployComposeMount[] = [],
): ValidatedComposeBuild => {
	const services = specification.services || {};
	const buildEntries = Object.entries(services).filter(
		([, service]) => service.build != null,
	);
	if (buildEntries.length === 0) {
		throw new Error(
			"Compose Build Servers V1 require at least one service with build:",
		);
	}

	const builtServices: string[] = [];
	const builtImages: string[] = [];
	const imageOwners = new Map<string, string>();

	for (const [serviceName, service] of buildEntries) {
		const image = service.image?.trim();
		if (!image) {
			throw new Error(
				`Buildable service "${serviceName}" must define image: so Docker Compose can push it`,
			);
		}
		const tag = imageTag(image);
		if (tag !== deploymentId) {
			throw new Error(
				`Buildable service "${serviceName}" must use the immutable tag "${deploymentId}" (resolved image: "${image}")`,
			);
		}
		if (!belongsToRegistry(image, registry)) {
			throw new Error(
				`Buildable service "${serviceName}" image "${image}" is outside the selected registry namespace "${registryNamespace(registry)}"`,
			);
		}
		const owner = imageOwners.get(image);
		if (owner) {
			throw new Error(
				`Buildable services "${owner}" and "${serviceName}" target the same image "${image}"`,
			);
		}
		imageOwners.set(image, serviceName);
		builtServices.push(serviceName);
		builtImages.push(image);
	}

	validateRuntimeFiles(specification, mounts);
	return { builtServices, builtImages };
};

export const createRuntimeComposeManifest = (
	specification: ComposeSpecification,
): ComposeSpecification => {
	const runtime = JSON.parse(
		JSON.stringify(specification),
	) as ComposeSpecification;
	for (const service of Object.values(runtime.services || {})) {
		delete service.build;
	}
	return runtime;
};

export const getRuntimeComposePaths = (
	compose: Pick<ComposeBuildServerSettings, "appName"> & {
		serverId?: string | null;
	},
	deploymentId: string,
) => {
	const directory = join(
		paths(Boolean(compose.serverId)).COMPOSE_PATH,
		compose.appName,
	);
	return {
		directory,
		active: join(directory, "runtime.compose.json"),
		temporary: join(directory, `.runtime.compose.${deploymentId}.json.tmp`),
	};
};

export const getTransferRuntimeManifestCommand = (
	manifest: ComposeSpecification,
	paths: { directory: string; temporary: string },
) => {
	const encoded = encodeBase64(JSON.stringify(manifest));
	return `mkdir -p ${quote([paths.directory])} && umask 077 && echo ${quote([
		encoded,
	])} | base64 -d > ${quote([paths.temporary])} && chmod 0600 ${quote([
		paths.temporary,
	])}`;
};

const runtimeComposeInvocation = (
	compose: Pick<ComposeBuildServerSettings, "appName">,
	temporaryManifest: string,
) =>
	`env -i PATH="$PATH" HOME="$HOME" docker compose -p ${quote([
		compose.appName,
	])} -f ${quote([temporaryManifest])}`;

export const getRuntimePullCommands = (
	compose: Pick<ComposeBuildServerSettings, "appName">,
	temporaryManifest: string,
	builtServices: string[],
) => {
	const invocation = runtimeComposeInvocation(compose, temporaryManifest);
	const services = builtServices.map((service) => quote([service])).join(" ");
	return [
		`${invocation} pull --policy always ${services}`.trim(),
		`${invocation} pull --policy missing`,
	];
};

export const getRuntimeDeployCommand = (
	compose: Pick<ComposeBuildServerSettings, "appName" | "isolatedDeployment">,
	temporaryManifest: string,
) => {
	const invocation = runtimeComposeInvocation(compose, temporaryManifest);
	const network = compose.isolatedDeployment
		? `docker network inspect ${quote([compose.appName])} >/dev/null 2>&1 || docker network create --attachable ${quote([compose.appName])}; `
		: "";
	return `${network}${invocation} up -d --no-build --pull never --remove-orphans`;
};

export const getActivateRuntimeManifestCommand = (paths: {
	temporary: string;
	active: string;
}) => `mv -f ${quote([paths.temporary])} ${quote([paths.active])}`;

export const getRemoveTemporaryManifestCommand = (temporary: string) =>
	`rm -f ${quote([temporary])}`;
