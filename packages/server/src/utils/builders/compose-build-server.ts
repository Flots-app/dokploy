import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { paths } from "@dokploy/server/constants";
import type { Registry } from "@dokploy/server/services/registry";
import type { ComposeSpecification } from "@dokploy/server/utils/docker/types";
import { encodeBase64 } from "@dokploy/server/utils/docker/utils";
import type {
	FileConfig,
	HttpMiddleware,
	HttpRouter,
} from "@dokploy/server/utils/traefik/file-types";
import { quote } from "shell-quote";
import { stringify } from "yaml";

export interface ComposeBuildServerSettings {
	appName: string;
	composePath: string;
	composeType: "docker-compose" | "stack";
	sourceType: string;
	command?: string | null;
	isolatedDeployment?: boolean;
	randomize?: boolean;
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
	zeroDowntime: ComposeZeroDowntimeSettings;
	routedServices: string[];
}

export interface ComposeBuildServerDomain {
	host: string;
	https: boolean;
	port: number | null;
	customEntrypoint: string | null;
	path: string | null;
	serviceName: string | null;
	uniqueConfigKey: number;
	certificateType: "none" | "letsencrypt" | "custom";
	customCertResolver: string | null;
	internalPath: string | null;
	stripPath: boolean;
	middlewares: string[] | null;
}

export interface ComposeZeroDowntimeHealthcheck {
	path: string;
}

export interface ComposeZeroDowntimeSettings {
	overlapSafe: true;
	healthchecks: Record<string, ComposeZeroDowntimeHealthcheck>;
	sharedVolumes: string[];
	readinessTimeoutSeconds: number;
	stabilizationSeconds: number;
	drainSeconds: number;
}

export interface ComposeRuntimeReleaseState {
	version: 1;
	composeId: string;
	deploymentId: string;
	projectName: string;
	manifestPath: string;
	serviceConfigPath: string;
	routerConfigPath: string;
	domainServices: Record<string, string>;
	activatedAt: string;
}

export interface ComposeActivationJournal {
	version: 1;
	phase: "prepared" | "routed" | "promoted";
	candidate: ComposeRuntimeReleaseState;
	previous: ComposeRuntimeReleaseState | null;
	legacyFallback?: boolean;
}

const ZERO_DOWNTIME_EXTENSION = "x-dokploy";
const DEFAULT_READINESS_TIMEOUT_SECONDS = 120;
const DEFAULT_STABILIZATION_SECONDS = 30;
const DEFAULT_DRAIN_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 900;
const TRAEFIK_ROUTER_PRIORITY = 1_000_000;

const hash = (value: string, length = 12) =>
	createHash("sha256").update(value).digest("hex").slice(0, length);

const safeName = (value: string) =>
	value
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^[-_]+|[-_]+$/g, "") || "release";

export const getComposeReleaseProjectName = (
	appName: string,
	deploymentId: string,
) => {
	const suffix = `-zdt-${hash(deploymentId)}`;
	return `${safeName(appName).slice(0, 63 - suffix.length)}${suffix}`;
};

export const getComposeReleaseServiceAlias = (
	appName: string,
	deploymentId: string,
	serviceName: string,
) => `dokploy-zdt-${hash(`${appName}:${deploymentId}:${serviceName}`, 32)}`;

const getDomainKey = (
	domain: Pick<ComposeBuildServerDomain, "uniqueConfigKey">,
) => String(domain.uniqueConfigKey);

const getReleaseTraefikServiceName = (
	appName: string,
	deploymentId: string,
	domain: ComposeBuildServerDomain,
) =>
	`${safeName(appName).slice(0, 28)}-${domain.uniqueConfigKey}-zdt-${hash(deploymentId)}`;

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
	if (compose.isolatedDeployment) {
		throw new Error(
			"Zero-downtime Compose Build Servers do not support isolated deployments",
		);
	}
	if (compose.randomize) {
		throw new Error(
			"Zero-downtime Compose Build Servers do not support randomized Compose resources",
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

const labelsContainTraefikConfiguration = (labels: unknown) => {
	if (Array.isArray(labels)) {
		return labels.some(
			(label) =>
				typeof label === "string" &&
				label
					.slice(0, label.indexOf("=") === -1 ? undefined : label.indexOf("="))
					.trim()
					.toLowerCase()
					.startsWith("traefik."),
		);
	}
	if (labels && typeof labels === "object") {
		return Object.keys(labels).some((label) =>
			label.toLowerCase().startsWith("traefik."),
		);
	}
	return false;
};

const durationToSeconds = (duration: string | undefined) => {
	if (!duration) return null;
	const matches = [...duration.matchAll(/(\d+(?:\.\d+)?)(ms|us|ns|h|m|s)/g)];
	if (
		matches.length === 0 ||
		matches.map((match) => match[0]).join("") !== duration
	) {
		return null;
	}
	return matches.reduce((seconds, match) => {
		const value = Number(match[1]);
		switch (match[2]) {
			case "h":
				return seconds + value * 3600;
			case "m":
				return seconds + value * 60;
			case "s":
				return seconds + value;
			case "ms":
				return seconds + value / 1000;
			case "us":
				return seconds + value / 1_000_000;
			case "ns":
				return seconds + value / 1_000_000_000;
			default:
				return seconds;
		}
	}, 0);
};

const boundedSeconds = (value: unknown, name: string, defaultValue: number) => {
	const parsed = value === undefined ? defaultValue : Number(value);
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_TIMEOUT_SECONDS) {
		throw new Error(
			`x-dokploy.zero-downtime.${name} must be an integer between 1 and ${MAX_TIMEOUT_SECONDS}`,
		);
	}
	return parsed;
};

const readZeroDowntimeSettings = (
	specification: ComposeSpecification,
): ComposeZeroDowntimeSettings => {
	const extension = specification[ZERO_DOWNTIME_EXTENSION];
	if (!extension || typeof extension !== "object" || Array.isArray(extension)) {
		throw new Error(
			"Zero-downtime Compose Build Servers require x-dokploy.zero-downtime",
		);
	}
	const raw = (extension as Record<string, unknown>)["zero-downtime"];
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error(
			"Zero-downtime Compose Build Servers require x-dokploy.zero-downtime",
		);
	}
	const config = raw as Record<string, unknown>;
	if (config["overlap-safe"] !== true) {
		throw new Error(
			"x-dokploy.zero-downtime.overlap-safe must be true so releases can coexist",
		);
	}

	const rawHealthchecks = config.healthchecks;
	if (
		!rawHealthchecks ||
		typeof rawHealthchecks !== "object" ||
		Array.isArray(rawHealthchecks)
	) {
		throw new Error(
			"x-dokploy.zero-downtime.healthchecks must configure every routed service",
		);
	}
	const healthchecks: Record<string, ComposeZeroDowntimeHealthcheck> = {};
	for (const [serviceName, healthcheck] of Object.entries(
		rawHealthchecks as Record<string, unknown>,
	)) {
		if (
			!healthcheck ||
			typeof healthcheck !== "object" ||
			Array.isArray(healthcheck)
		) {
			throw new Error(
				`Zero-downtime healthcheck for service "${serviceName}" must define path`,
			);
		}
		const path = (healthcheck as Record<string, unknown>).path;
		if (typeof path !== "string" || !path.startsWith("/")) {
			throw new Error(
				`Zero-downtime healthcheck for service "${serviceName}" must use an absolute path`,
			);
		}
		healthchecks[serviceName] = { path };
	}

	const rawSharedVolumes = config["shared-volumes"] ?? [];
	if (
		!Array.isArray(rawSharedVolumes) ||
		rawSharedVolumes.some((volume) => typeof volume !== "string")
	) {
		throw new Error(
			"x-dokploy.zero-downtime.shared-volumes must be an array of volume names",
		);
	}

	return {
		overlapSafe: true,
		healthchecks,
		sharedVolumes: [...new Set(rawSharedVolumes as string[])],
		readinessTimeoutSeconds: boundedSeconds(
			config["readiness-timeout-seconds"],
			"readiness-timeout-seconds",
			DEFAULT_READINESS_TIMEOUT_SECONDS,
		),
		stabilizationSeconds: boundedSeconds(
			config["stabilization-seconds"],
			"stabilization-seconds",
			DEFAULT_STABILIZATION_SECONDS,
		),
		drainSeconds: boundedSeconds(
			config["drain-seconds"],
			"drain-seconds",
			DEFAULT_DRAIN_SECONDS,
		),
	};
};

const validateRuntimeFiles = (
	specification: ComposeSpecification,
	mounts: DokployComposeMount[],
	settings: ComposeZeroDowntimeSettings,
) => {
	for (const [serviceName, service] of Object.entries(
		specification.services || {},
	)) {
		if (service.ports?.length) {
			throw new Error(
				`Service "${serviceName}" publishes host ports; zero-downtime traffic must use Dokploy Domains and Traefik`,
			);
		}
		if (service.container_name) {
			throw new Error(
				`Service "${serviceName}" uses container_name, which prevents two releases from coexisting`,
			);
		}
		if (service.network_mode) {
			throw new Error(
				`Service "${serviceName}" uses network_mode, which is not supported by zero-downtime releases`,
			);
		}
		if (labelsContainTraefikConfiguration(service.labels)) {
			throw new Error(
				`Service "${serviceName}" defines Traefik labels; zero-downtime routing must be managed by Dokploy Domains`,
			);
		}

		for (const volume of service.volumes || []) {
			if (
				(typeof volume === "string" && shortVolumeUsesHostPath(volume)) ||
				(typeof volume === "object" && volume.type === "bind")
			) {
				throw new Error(
					`Service "${serviceName}" uses a bind mount; local runtime files are not supported with Compose Build Servers V1`,
				);
			}

			const source =
				typeof volume === "string"
					? volume.includes(":")
						? volume.slice(0, volume.indexOf(":"))
						: null
					: volume.type === "volume"
						? volume.source
						: null;
			if (source) {
				const definition = specification.volumes?.[source];
				const external = Boolean(definition?.external);
				if (!external || !settings.sharedVolumes.includes(source)) {
					throw new Error(
						`Service "${serviceName}" volume "${source}" must be external and listed in x-dokploy.zero-downtime.shared-volumes`,
					);
				}
			}
		}
	}

	for (const [networkName, network] of Object.entries(
		specification.networks || {},
	)) {
		if (
			networkName !== "dokploy-network" &&
			network &&
			Boolean(network.external)
		) {
			throw new Error(
				`External network "${networkName}" is not supported by zero-downtime Compose; only dokploy-network may be external`,
			);
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

	const localMount = mounts[0];
	if (localMount) {
		throw new Error(
			`Dokploy ${localMount.type} mount "${localMount.mountPath || localMount.filePath || localMount.hostPath || "unknown"}" is not supported by zero-downtime Compose; declare safe external volumes in the Git Compose file`,
		);
	}
};

export const validateComposeBuildServerSpecification = (
	specification: ComposeSpecification,
	registry: Pick<Registry, "registryUrl" | "imagePrefix" | "username">,
	deploymentId: string,
	mounts: DokployComposeMount[] = [],
	domains: ComposeBuildServerDomain[] = [],
): ValidatedComposeBuild => {
	const services = specification.services || {};
	const zeroDowntime = readZeroDowntimeSettings(specification);
	if (domains.length === 0) {
		throw new Error(
			"Zero-downtime Compose Build Servers require at least one Dokploy Domain",
		);
	}
	const routedServices = [
		...new Set(
			domains.map((domain) => {
				if (!domain.serviceName || !services[domain.serviceName]) {
					throw new Error(
						`Domain "${domain.host}" must reference an existing Compose service`,
					);
				}
				return domain.serviceName;
			}),
		),
	];
	for (const serviceName of routedServices) {
		const service = services[serviceName];
		if (!service?.healthcheck || service.healthcheck.disable) {
			throw new Error(
				`Routed service "${serviceName}" must define an enabled Compose healthcheck`,
			);
		}
		if (!zeroDowntime.healthchecks[serviceName]) {
			throw new Error(
				`Routed service "${serviceName}" must define x-dokploy.zero-downtime.healthchecks.${serviceName}.path`,
			);
		}
		const stopGracePeriod = durationToSeconds(service.stop_grace_period);
		if (
			stopGracePeriod === null ||
			stopGracePeriod < zeroDowntime.drainSeconds
		) {
			throw new Error(
				`Routed service "${serviceName}" must set stop_grace_period to at least ${zeroDowntime.drainSeconds}s`,
			);
		}
	}
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

	validateRuntimeFiles(specification, mounts, zeroDowntime);
	return { builtServices, builtImages, zeroDowntime, routedServices };
};

export const createRuntimeComposeManifest = (
	specification: ComposeSpecification,
	options?: {
		appName: string;
		composeId: string;
		deploymentId: string;
	},
): ComposeSpecification => {
	const runtime = JSON.parse(
		JSON.stringify(specification),
	) as ComposeSpecification;
	delete runtime.name;
	delete runtime[ZERO_DOWNTIME_EXTENSION];
	for (const network of Object.values(runtime.networks || {})) {
		if (network && typeof network === "object" && !network.external) {
			delete network.name;
		}
	}
	for (const [serviceName, service] of Object.entries(runtime.services || {})) {
		delete service.build;
		if (!options) continue;

		const labels: Record<string, string | number | boolean | null> = {};
		if (Array.isArray(service.labels)) {
			for (const label of service.labels) {
				const separator = label.indexOf("=");
				const key = separator === -1 ? label : label.slice(0, separator);
				if (
					key.toLowerCase().startsWith("traefik.") ||
					key.toLowerCase().startsWith("com.dokploy.")
				) {
					continue;
				}
				labels[key] = separator === -1 ? "" : label.slice(separator + 1);
			}
		} else if (service.labels) {
			for (const [key, value] of Object.entries(service.labels)) {
				if (
					key.toLowerCase().startsWith("traefik.") ||
					key.toLowerCase().startsWith("com.dokploy.")
				) {
					continue;
				}
				labels[key] = value;
			}
		}
		labels["com.dokploy.managed"] = "compose-release";
		labels["com.dokploy.compose-id"] = options.composeId;
		labels["com.dokploy.deployment-id"] = options.deploymentId;
		labels["com.dokploy.runtime-project"] = getComposeReleaseProjectName(
			options.appName,
			options.deploymentId,
		);
		service.labels = labels;

		const alias = getComposeReleaseServiceAlias(
			options.appName,
			options.deploymentId,
			serviceName,
		);
		if (Array.isArray(service.networks)) {
			service.networks = Object.fromEntries(
				service.networks.map((network) => [network, null]),
			);
		}
		if (!service.networks) service.networks = {};
		if (!Array.isArray(service.networks)) {
			const existing = service.networks["dokploy-network"];
			service.networks["dokploy-network"] = {
				...(existing && typeof existing === "object" ? existing : {}),
				aliases: [
					...new Set([
						...(existing &&
						typeof existing === "object" &&
						Array.isArray(existing.aliases)
							? existing.aliases
							: []),
						alias,
					]),
				],
			};
		}
	}
	if (options) {
		runtime.networks = runtime.networks || {};
		runtime.networks["dokploy-network"] = {
			name: "dokploy-network",
			external: true,
		};
	}
	return runtime;
};

const toPunycode = (host: string) => {
	try {
		return new URL(`http://${host}`).hostname;
	} catch {
		return host;
	}
};

const createRouter = (
	appName: string,
	domain: ComposeBuildServerDomain,
	entrypoint: string,
	serviceName: string,
	middlewares: Record<string, HttpMiddleware>,
): HttpRouter => {
	const routerMiddlewares: string[] = [];
	const isRedirect =
		entrypoint === "web" && domain.https && !domain.customEntrypoint;
	if (isRedirect) {
		routerMiddlewares.push("redirect-to-https@file");
	} else {
		if (domain.stripPath && domain.path && domain.path !== "/") {
			const name = `stripprefix-${appName}-${domain.uniqueConfigKey}`;
			middlewares[name] = { stripPrefix: { prefixes: [domain.path] } };
			routerMiddlewares.push(name);
		}
		if (
			domain.internalPath &&
			domain.internalPath !== "/" &&
			domain.internalPath !== domain.path
		) {
			const name = `addprefix-${appName}-${domain.uniqueConfigKey}`;
			middlewares[name] = { addPrefix: { prefix: domain.internalPath } };
			routerMiddlewares.push(name);
		}
		routerMiddlewares.push(...(domain.middlewares || []));
	}

	const router: HttpRouter = {
		rule: `Host(\`${toPunycode(domain.host)}\`)${
			domain.path && domain.path !== "/"
				? ` && PathPrefix(\`${domain.path}\`)`
				: ""
		}`,
		service: serviceName,
		entryPoints: [entrypoint],
		priority: TRAEFIK_ROUTER_PRIORITY,
		...(routerMiddlewares.length > 0 ? { middlewares: routerMiddlewares } : {}),
	};
	if (entrypoint === "websecure" || (domain.customEntrypoint && domain.https)) {
		if (domain.certificateType === "letsencrypt") {
			router.tls = { certResolver: "letsencrypt" };
		} else if (
			domain.certificateType === "custom" &&
			domain.customCertResolver
		) {
			router.tls = { certResolver: domain.customCertResolver };
		} else {
			router.tls = {};
		}
	}
	return router;
};

export const createComposeReleaseTraefikServiceConfig = ({
	appName,
	deploymentId,
	domains,
	settings,
}: {
	appName: string;
	deploymentId: string;
	domains: ComposeBuildServerDomain[];
	settings: ComposeZeroDowntimeSettings;
}): { config: FileConfig; domainServices: Record<string, string> } => {
	const routers: NonNullable<NonNullable<FileConfig["http"]>["routers"]> = {};
	const services: NonNullable<NonNullable<FileConfig["http"]>["services"]> = {};
	const domainServices: Record<string, string> = {};
	for (const domain of domains) {
		const serviceName = domain.serviceName;
		if (!serviceName) continue;
		const traefikServiceName = getReleaseTraefikServiceName(
			appName,
			deploymentId,
			domain,
		);
		domainServices[getDomainKey(domain)] = traefikServiceName;
		routers[`${traefikServiceName}-probe`] = {
			rule: `Host(\`${hash(`${appName}:${deploymentId}:${domain.uniqueConfigKey}`, 32)}.dokploy.invalid\`)`,
			entryPoints: ["web"],
			service: traefikServiceName,
			priority: 1,
		};
		services[traefikServiceName] = {
			loadBalancer: {
				servers: [
					{
						url: `http://${getComposeReleaseServiceAlias(
							appName,
							deploymentId,
							serviceName,
						)}:${domain.port || 80}`,
					},
				],
				passHostHeader: true,
				healthCheck: {
					path: settings.healthchecks[serviceName]?.path || "/",
					interval: "1s",
					timeout: "1s",
					hostname: domain.host,
				},
			},
		};
	}
	return { config: { http: { routers, services } }, domainServices };
};

export const createComposeReleaseTraefikRouterConfig = ({
	appName,
	domains,
	candidate,
	previous,
	legacyFallback,
}: {
	appName: string;
	domains: ComposeBuildServerDomain[];
	candidate: ComposeRuntimeReleaseState;
	previous?: ComposeRuntimeReleaseState | null;
	legacyFallback?: boolean;
}): FileConfig => {
	const routers: NonNullable<NonNullable<FileConfig["http"]>["routers"]> = {};
	const services: NonNullable<NonNullable<FileConfig["http"]>["services"]> = {};
	const middlewares: Record<string, HttpMiddleware> = {};

	for (const domain of domains) {
		const key = getDomainKey(domain);
		const candidateService = candidate.domainServices[key];
		if (!candidateService) continue;
		const entrypoints = [
			domain.customEntrypoint || "web",
			...(!domain.customEntrypoint && domain.https ? ["websecure"] : []),
		];
		for (const entrypoint of entrypoints) {
			const routerName = `${appName}-${domain.uniqueConfigKey}-${entrypoint}`;
			let targetService = candidateService;
			const fallbackService =
				previous?.domainServices[key] ||
				(legacyFallback ? `${routerName}@docker` : null);
			if (fallbackService) {
				targetService = `${routerName}-zdt-cutover`;
				services[targetService] = {
					failover: {
						service: candidateService,
						fallback: fallbackService,
					},
				};
			}
			routers[routerName] = createRouter(
				appName,
				domain,
				entrypoint,
				targetService,
				middlewares,
			);
		}
	}

	return { http: { routers, services, middlewares } };
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
	const releaseDirectory = join(directory, "releases", deploymentId);
	const traefikDirectory = paths(
		Boolean(compose.serverId),
	).DYNAMIC_TRAEFIK_PATH;
	return {
		directory,
		releasesDirectory: join(directory, "releases"),
		releaseDirectory,
		manifest: join(releaseDirectory, "runtime.compose.json"),
		metadata: join(releaseDirectory, "release.json"),
		routerConfig: join(releaseDirectory, "router.yml"),
		serviceConfig: join(releaseDirectory, "service.yml"),
		active: join(directory, "runtime.compose.json"),
		activeState: join(directory, "active-release.json"),
		activationJournal: join(directory, "activation.json"),
		cleanupPending: join(directory, "cleanup-pending.json"),
		cancellationRequest: join(directory, ".cancel-requested"),
		lockDirectory: join(directory, ".activation.lock"),
		temporary: join(releaseDirectory, "runtime.compose.json.tmp"),
		traefikRouter: join(traefikDirectory, `${compose.appName}.zdt.router.yml`),
		traefikService: join(
			traefikDirectory,
			`${compose.appName}.zdt.${hash(deploymentId)}.yml`,
		),
	};
};

export const getTransferRuntimeManifestCommand = (
	manifest: ComposeSpecification,
	paths: {
		directory: string;
		releaseDirectory?: string;
		temporary: string;
		manifest?: string;
	},
) => {
	const encoded = encodeBase64(JSON.stringify(manifest));
	return `mkdir -p ${quote([
		paths.releaseDirectory || paths.directory,
	])} && umask 077 && echo ${quote([
		encoded,
	])} | base64 -d > ${quote([paths.temporary])} && chmod 0600 ${quote([
		paths.temporary,
	])}${
		paths.manifest
			? ` && mv -f ${quote([paths.temporary])} ${quote([paths.manifest])}`
			: ""
	}`;
};

const runtimeComposeInvocation = (projectName: string, manifest: string) =>
	`env -i PATH="$PATH" HOME="$HOME" docker compose -p ${quote([
		projectName,
	])} -f ${quote([manifest])}`;

export const getRuntimePullCommands = (
	projectName: string,
	manifest: string,
	builtServices: string[],
) => {
	const invocation = runtimeComposeInvocation(projectName, manifest);
	const services = builtServices.map((service) => quote([service])).join(" ");
	return [
		`${invocation} pull --policy always ${services}`.trim(),
		`${invocation} pull --policy missing`,
	];
};

export const getRuntimeDeployCommand = (
	projectName: string,
	manifest: string,
	readinessTimeoutSeconds = DEFAULT_READINESS_TIMEOUT_SECONDS,
) => {
	const invocation = runtimeComposeInvocation(projectName, manifest);
	return `${invocation} up -d --no-build --pull never --wait --wait-timeout ${readinessTimeoutSeconds}`;
};

const atomicWriteCommand = (
	path: string,
	content: string,
	mode: "0600" | "0644",
) => {
	const temporary = `${path}.tmp`;
	return `mkdir -p ${quote([dirname(path)])} && umask 077 && echo ${quote([
		encodeBase64(content),
	])} | base64 -d > ${quote([temporary])} && chmod ${mode} ${quote([
		temporary,
	])} && mv -f ${quote([temporary])} ${quote([path])}`;
};

export const getInstallTraefikConfigCommand = (
	config: FileConfig,
	path: string,
) => atomicWriteCommand(path, stringify(config, { lineWidth: 1000 }), "0644");

export const getRemoveTraefikConfigCommand = (path: string) =>
	`rm -f ${quote([path])} ${quote([`${path}.tmp`])}`;

const traefikContainerCommand =
	'traefik_id="$(docker ps -q --filter name=dokploy-traefik --filter status=running | head -n 1)"; [ -n "$traefik_id" ] || { echo "Dokploy Traefik is not running on the runtime server" >&2; exit 1; }';

const traefikApiCommand = (
	resource: "services" | "routers",
	name: string,
	provider = "file",
) =>
	`docker exec "$traefik_id" wget -qO- ${quote([
		`http://127.0.0.1:8080/api/http/${resource}/${name}@${provider}`,
	])} 2>/dev/null`;

export const getWaitTraefikServicesCommand = (
	serviceNames: string[],
	timeoutSeconds: number,
) => {
	const checks = serviceNames
		.map(
			(serviceName) =>
				`body="$(${traefikApiCommand("services", serviceName)})" && echo "$body" | grep -q '"UP"'`,
		)
		.join(" && ");
	return `set -e; ${traefikContainerCommand} deadline=$(( $(date +%s) + ${timeoutSeconds} )); while true; do if ${checks || "true"}; then break; fi; if [ "$(date +%s)" -ge "$deadline" ]; then echo "Traefik did not mark the candidate services UP within ${timeoutSeconds}s" >&2; exit 1; fi; sleep 1; done`;
};

export const getWaitTraefikRoutersCommand = (
	routerTargets: Record<string, string>,
	timeoutSeconds = 15,
	provider = "file",
) => {
	const checks = Object.entries(routerTargets)
		.map(([routerName, serviceName]) =>
			[
				`body="$(${traefikApiCommand("routers", routerName, provider)})"`,
				`echo "$body" | grep -Fq '"status":"enabled"'`,
				`echo "$body" | grep -Fq ${quote([`"service":"${serviceName}"`])}`,
			].join(" && "),
		)
		.join(" && ");
	return `set -e; ${traefikContainerCommand} deadline=$(( $(date +%s) + ${timeoutSeconds} )); while true; do if ${checks || "true"}; then break; fi; if [ "$(date +%s)" -ge "$deadline" ]; then echo "Traefik did not activate the zero-downtime routers within ${timeoutSeconds}s" >&2; exit 1; fi; sleep 1; done`;
};

export const getObserveTraefikServicesCommand = (
	serviceNames: string[],
	seconds: number,
) => {
	if (seconds <= 0) return "true";
	const checks = serviceNames
		.map(
			(serviceName) =>
				`body="$(${traefikApiCommand("services", serviceName)})" && echo "$body" | grep -q '"UP"'`,
		)
		.join(" && ");
	return `set -e; ${traefikContainerCommand} remaining=${seconds}; while [ "$remaining" -gt 0 ]; do ${checks || "true"} || { echo "Candidate service became unhealthy during stabilization" >&2; exit 1; }; sleep 1; remaining=$((remaining - 1)); done`;
};

export const getWriteReleaseMetadataCommand = (
	paths: { metadata: string; serviceConfig: string; routerConfig: string },
	state: ComposeRuntimeReleaseState,
	serviceConfig: FileConfig,
	routerConfig: FileConfig,
) =>
	[
		atomicWriteCommand(paths.metadata, JSON.stringify(state), "0600"),
		atomicWriteCommand(
			paths.serviceConfig,
			stringify(serviceConfig, { lineWidth: 1000 }),
			"0644",
		),
		atomicWriteCommand(
			paths.routerConfig,
			stringify(routerConfig, { lineWidth: 1000 }),
			"0644",
		),
	].join(" && ");

export const getWriteActivationJournalCommand = (
	path: string,
	journal: ComposeActivationJournal,
) => atomicWriteCommand(path, JSON.stringify(journal), "0600");

export const getWriteRuntimeReleaseStateCommand = (
	path: string,
	state: ComposeRuntimeReleaseState,
) => atomicWriteCommand(path, JSON.stringify(state), "0600");

export const getActivateRuntimeManifestCommand = (
	paths: {
		active: string;
		activeState: string;
		manifest: string;
	},
	state: ComposeRuntimeReleaseState,
) =>
	`cp -f ${quote([paths.manifest])} ${quote([
		paths.active,
	])} && chmod 0600 ${quote([paths.active])} && ${atomicWriteCommand(
		paths.activeState,
		JSON.stringify(state),
		"0600",
	)}`;

export const getAcquireComposeActivationLockCommand = (
	lockDirectory: string,
	deploymentId: string,
	activationJournal?: string,
) =>
	`set -e; if [ -d ${quote([lockDirectory])} ]; then lock_deployment="$(cat ${quote(
		[join(lockDirectory, "deployment-id")],
	)} 2>/dev/null || true)"; ${
		activationJournal
			? `journal_deployment="$(grep -o '"deploymentId":"[^"]*"' ${quote([
					activationJournal,
				])} 2>/dev/null | head -n 1 | cut -d '"' -f 4 || true)"; `
			: 'journal_deployment=""; '
	}if { [ -n "$lock_deployment" ] && [ "$lock_deployment" = "$journal_deployment" ]; } || find ${quote(
		[lockDirectory],
	)} -maxdepth 0 -mmin +60 | grep -q .; then rm -rf ${quote([
		lockDirectory,
	])}; fi; fi; mkdir ${quote([lockDirectory])}; echo ${quote([
		deploymentId,
	])} > ${quote([join(lockDirectory, "deployment-id")])}`;

export const getReleaseComposeActivationLockCommand = (lockDirectory: string) =>
	`rm -rf ${quote([lockDirectory])}`;

export const getRuntimeReleaseDownCommand = (
	state: Pick<ComposeRuntimeReleaseState, "projectName" | "manifestPath">,
	drainSeconds: number,
	removeVolumes = true,
) =>
	`${runtimeComposeInvocation(state.projectName, state.manifestPath)} down --remove-orphans ${removeVolumes ? "--volumes " : ""}--timeout ${drainSeconds}`;

export const getRemoveRuntimeReleaseCommand = (
	state: Pick<ComposeRuntimeReleaseState, "serviceConfigPath" | "manifestPath">,
) =>
	`rm -f ${quote([state.serviceConfigPath])} && rm -rf ${quote([
		dirname(state.manifestPath),
	])}`;

export const getRemoveTemporaryManifestCommand = (temporary: string) =>
	`rm -f ${quote([temporary])}`;
