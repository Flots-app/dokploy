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

export const assertBuildServerAvailable = ({
	organizationId,
	server,
}: Omit<BuildServerRuntimeSelection, "registry">) => {
	if (
		!server ||
		server.organizationId !== organizationId ||
		server.serverStatus !== "active" ||
		server.serverType !== "build" ||
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
