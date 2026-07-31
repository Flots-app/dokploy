export interface BuildServerSelection {
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

export type BuildServerRuntimeSelection = Omit<
	BuildServerSelection,
	"accessibleServerIds"
>;

export interface BuildServerPair {
	buildServerId: string | null;
	buildRegistryId: string | null;
}

/**
 * Build Server picked for a single deployment. `undefined` keeps the one stored
 * on the service, `null` builds on the deploy server itself. The registry is
 * never part of the override: it belongs to the service, not to one deployment.
 */
export type BuildServerOverride = {
	buildServerId?: string | null;
};

export const assertBuildServerAvailable = (
	{ organizationId, server }: Omit<BuildServerRuntimeSelection, "registry">,
	/**
	 * Only a Build Server may be *picked*. A server already stored on a service
	 * is checked for reachability alone, so a configuration predating the
	 * `serverType` filter keeps deploying instead of breaking on the next build.
	 */
	{ requireBuildServerType = true } = {},
) => {
	if (
		!server ||
		server.organizationId !== organizationId ||
		server.serverStatus !== "active" ||
		(requireBuildServerType && server.serverType !== "build") ||
		!server.sshKeyId
	) {
		throw new Error(
			"The selected server must be an active Build Server in this organization",
		);
	}
};

export const assertBuildServerRuntimeSelection = ({
	organizationId,
	server,
	registry,
}: BuildServerRuntimeSelection) => {
	assertBuildServerAvailable({ organizationId, server });
	if (!registry || registry.organizationId !== organizationId) {
		throw new Error(
			"The selected registry must belong to the same organization",
		);
	}
};

export const assertBuildServerAccessible = ({
	accessibleServerIds,
	server,
}: Pick<BuildServerSelection, "accessibleServerIds" | "server">) => {
	if (!server || !accessibleServerIds.has(server.serverId)) {
		throw new Error("You are not authorized to access this build server");
	}
};

export const assertBuildServerSelection = ({
	organizationId,
	accessibleServerIds,
	server,
	registry,
}: BuildServerSelection) => {
	assertBuildServerAccessible({ accessibleServerIds, server });
	assertBuildServerRuntimeSelection({
		organizationId,
		server,
		registry,
	});
};

export const isBuildServerOverridden = (override?: BuildServerOverride) =>
	override?.buildServerId !== undefined;

export interface BuildServerDeploymentRecord {
	createdAt: string;
	status?: string | null;
	buildServerId?: string | null;
}

const latestFirst = (deployments: BuildServerDeploymentRecord[]) =>
	[...deployments].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

/**
 * Machine holding the source code downloaded by the last build. A rebuild does
 * not clone again, so this is the only machine that can rebuild the current
 * checkout. `undefined` means the service never deployed, `null` means the last
 * build ran on the deploy server.
 */
export const getSourceBuildServerId = (
	deployments: BuildServerDeploymentRecord[],
): string | null | undefined => {
	const [latest] = latestFirst(deployments);
	if (!latest) return undefined;
	return latest.buildServerId || null;
};

/**
 * Machine a running build must be killed on: the one the deployment in flight
 * was sent to, falling back to the last one and finally to the deploy server.
 */
export const getRunningBuildServerId = (
	deployments: BuildServerDeploymentRecord[],
	deployServerId: string | null,
): string | null => {
	const ordered = latestFirst(deployments);
	const target =
		ordered.find((deployment) => deployment.status === "running") || ordered[0];
	return target?.buildServerId || deployServerId;
};

/**
 * Resolves the Build Server used by a single deployment. An absent override
 * keeps the value stored on the service, while an explicit `null` builds on the
 * deploy server. The registry always stays the one configured on the service.
 */
export const resolveBuildServerOverride = (
	stored: BuildServerPair,
	override?: BuildServerOverride,
): BuildServerPair => {
	const buildRegistryId = stored.buildRegistryId || null;
	if (!isBuildServerOverridden(override)) {
		return {
			buildServerId: stored.buildServerId || null,
			buildRegistryId,
		};
	}
	return {
		buildServerId: override?.buildServerId || null,
		buildRegistryId,
	};
};
