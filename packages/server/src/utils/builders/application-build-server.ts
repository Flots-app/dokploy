import { dirname, join } from "node:path";
import { paths } from "@dokploy/server/constants";
import type { Registry } from "@dokploy/server/services/registry";
import { getRegistryTag } from "@dokploy/server/utils/cluster/upload";
import { quote } from "shell-quote";

export const APPLICATION_READINESS_TIMEOUT_SECONDS = 120;
export const APPLICATION_STABILIZATION_SECONDS = 30;
export const APPLICATION_DRAIN_SECONDS = 30;
export const APPLICATION_DRAIN_NANOSECONDS =
	APPLICATION_DRAIN_SECONDS * 1_000_000_000;

const GIT_SOURCES = new Set(["github", "gitlab", "bitbucket", "gitea", "git"]);

interface BuildServerRecord {
	serverId: string;
	organizationId: string;
	serverType: "deploy" | "build";
	serverStatus: "active" | "inactive";
	sshKeyId: string | null;
}

interface RuntimeServerRecord {
	serverId: string;
	organizationId: string;
	serverType: "deploy" | "build";
	serverStatus: "active" | "inactive";
}

export const assertApplicationBuildServerSelection = ({
	organizationId,
	accessibleServerIds,
	server,
	registry,
}: {
	organizationId: string;
	accessibleServerIds?: Set<string>;
	server: BuildServerRecord | null | undefined;
	registry?: Pick<Registry, "organizationId"> | null;
}) => {
	if (!server) throw new Error("Build Server not found");
	if (server.organizationId !== organizationId) {
		throw new Error("Build Server must belong to the Application organization");
	}
	if (accessibleServerIds && !accessibleServerIds.has(server.serverId)) {
		throw new Error("You are not authorized to access this Build Server");
	}
	if (server.serverType !== "build") {
		throw new Error(
			"Application builds require a dedicated server whose serverType is build; a Deploy Server cannot be used",
		);
	}
	if (server.serverStatus !== "active") {
		throw new Error("Build Server must be active");
	}
	if (!server.sshKeyId) {
		throw new Error("Build Server must have an SSH key");
	}
	if (registry && registry.organizationId !== organizationId) {
		throw new Error(
			"Build Registry must belong to the Application organization",
		);
	}
	return server;
};

export interface ApplicationBuildServerDeploymentSettings {
	appName: string;
	buildType: string;
	sourceType: string;
	serverId?: string | null;
	buildServerId?: string | null;
	buildRegistryId?: string | null;
	healthCheckSwarm?: { Test?: string[] } | null;
	stopGracePeriodSwarm?: number | null;
	ports?: unknown[];
	endpointSpecSwarm?: { Mode?: string; Ports?: unknown[] } | null;
	mounts?: Array<{ type: string }>;
	labelsSwarm?: Record<string, string> | null;
	networkSwarm?: Array<{ Target?: string }> | null;
	replicas?: number | null;
	modeSwarm?: {
		Replicated?: { Replicas?: number };
		Global?: unknown;
		ReplicatedJob?: unknown;
		GlobalJob?: unknown;
	} | null;
	domains?: unknown[];
}

export const assertApplicationBuildServerDeploymentReady = (
	application: ApplicationBuildServerDeploymentSettings,
) => {
	if (!application.buildServerId) {
		throw new Error(
			"A dedicated Build Server is required before this Application can build",
		);
	}
	if (!application.buildRegistryId) {
		throw new Error(
			"A Build Registry is required for immutable Build Server images",
		);
	}
	if (application.buildType !== "dockerfile") {
		throw new Error(
			"Zero-downtime Application Build Servers currently support Build Type Dockerfile only",
		);
	}
	if (!GIT_SOURCES.has(application.sourceType)) {
		throw new Error(
			"Zero-downtime Dockerfile Build Servers require a Git-backed Application source",
		);
	}
	if (!application.domains?.length) {
		throw new Error(
			"Zero-downtime Dockerfile Build Servers require at least one Dokploy Domain",
		);
	}
	const healthcheck = application.healthCheckSwarm?.Test;
	if (
		!healthcheck ||
		healthcheck.length < 2 ||
		!new Set(["CMD", "CMD-SHELL"]).has(healthcheck[0] || "") ||
		healthcheck.slice(1).every((part) => !part.trim())
	) {
		throw new Error(
			"Zero-downtime Dockerfile Build Servers require a Docker Swarm health check with CMD or CMD-SHELL",
		);
	}
	if ((application.stopGracePeriodSwarm ?? 0) < APPLICATION_DRAIN_NANOSECONDS) {
		throw new Error(
			`Zero-downtime Dockerfile Build Servers require stopGracePeriodSwarm of at least ${APPLICATION_DRAIN_NANOSECONDS} nanoseconds (${APPLICATION_DRAIN_SECONDS}s)`,
		);
	}
	if (
		(application.ports?.length ?? 0) > 0 ||
		(application.endpointSpecSwarm?.Ports?.length ?? 0) > 0
	) {
		throw new Error(
			"Zero-downtime Dockerfile Build Servers do not support published host ports; use Dokploy Domains and Traefik",
		);
	}
	const mount = application.mounts?.[0];
	if (mount) {
		throw new Error(
			`Zero-downtime Dockerfile Build Servers do not support ${mount.type} mounts because concurrent releases must be stateless`,
		);
	}
	if (
		Object.keys(application.labelsSwarm ?? {}).some((label) =>
			label.toLowerCase().startsWith("traefik."),
		)
	) {
		throw new Error(
			"Zero-downtime Dockerfile Build Servers do not support custom Traefik labels",
		);
	}
	if (
		application.networkSwarm?.length &&
		!application.networkSwarm.some(
			(network) => network.Target === "dokploy-network",
		)
	) {
		throw new Error(
			"Zero-downtime Dockerfile Build Servers require the dokploy-network when custom networks are configured",
		);
	}
	if (
		application.endpointSpecSwarm?.Mode &&
		application.endpointSpecSwarm.Mode !== "vip"
	) {
		throw new Error(
			"Zero-downtime Dockerfile Build Servers require VIP endpoint routing",
		);
	}
	if (
		application.modeSwarm?.Global ||
		application.modeSwarm?.GlobalJob ||
		application.modeSwarm?.ReplicatedJob
	) {
		throw new Error(
			"Zero-downtime Dockerfile Build Servers require replicated service mode",
		);
	}
	if (
		(application.modeSwarm?.Replicated?.Replicas ?? application.replicas ?? 1) <
		1
	) {
		throw new Error(
			"Zero-downtime Dockerfile Build Servers require at least one replica",
		);
	}
	if (application.serverId === application.buildServerId) {
		throw new Error(
			"Build Server and Deploy Server must be different machines",
		);
	}
};

export const assertApplicationRuntimeServerSelection = ({
	organizationId,
	buildServerId,
	runtimeServer,
}: {
	organizationId: string;
	buildServerId: string;
	runtimeServer?: RuntimeServerRecord | null;
}) => {
	if (!runtimeServer) return;
	if (runtimeServer.organizationId !== organizationId) {
		throw new Error(
			"Deploy Server must belong to the Application organization",
		);
	}
	if (
		runtimeServer.serverType !== "deploy" ||
		runtimeServer.serverStatus !== "active"
	) {
		throw new Error("Application runtime requires an active Deploy Server");
	}
	if (runtimeServer.serverId === buildServerId) {
		throw new Error(
			"Build Server and Deploy Server must be different machines",
		);
	}
};

export const getApplicationDeploymentImage = (
	registry: Registry,
	appName: string,
	deploymentId: string,
) => getRegistryTag(registry, `${appName}:${deploymentId}`);

export const getApplicationBuildPushCommand = (
	localImage: string,
	runtimeImage: string,
) =>
	[
		`docker tag ${quote([localImage])} ${quote([runtimeImage])}`,
		`docker push ${quote([runtimeImage])}`,
	].join(" && ");

export const getApplicationRuntimePullCommand = (runtimeImage: string) =>
	`env HOME="$HOME" docker pull ${quote([runtimeImage])}`;

export const getApplicationCancellationPath = (
	appName: string,
	remote: boolean,
) => join(paths(remote).APPLICATIONS_PATH, appName, ".cancel-requested");

export const getCancellableApplicationCommand = (
	command: string,
	cancellationRequest: string,
) => {
	const script = `set -e
cancellation_request=${quote([cancellationRequest])}
if [ -f "$cancellation_request" ]; then
  echo "Application deployment cancellation requested" >&2
  exit 130
fi
umask 077
command_file="$(mktemp)"
cleanup() { rm -f "$command_file"; }
terminate_tree() {
  parent="$1"
  for child in $(pgrep -P "$parent" 2>/dev/null || true); do terminate_tree "$child"; done
  kill -TERM "$parent" 2>/dev/null || true
}
trap cleanup EXIT
printf %s ${quote([Buffer.from(command, "utf8").toString("base64")])} | base64 -d > "$command_file"
bash "$command_file" &
command_pid=$!
while kill -0 "$command_pid" 2>/dev/null; do
  if [ -f "$cancellation_request" ]; then
    echo "Application deployment cancellation requested" >&2
    terminate_tree "$command_pid"
    wait "$command_pid" 2>/dev/null || true
    exit 130
  fi
  sleep 1
done
wait "$command_pid"`;
	return `bash -c ${quote([script])}`;
};

export const getWaitApplicationServiceCommand = (
	appName: string,
	runtimeImage: string,
	readinessTimeoutSeconds = APPLICATION_READINESS_TIMEOUT_SECONDS,
	stabilizationSeconds = APPLICATION_STABILIZATION_SECONDS,
) => {
	const service = quote([appName]);
	const image = quote([runtimeImage]);
	return `set -e
service_name=${service}
expected_image=${image}
deadline=$(( $(date +%s) + ${readinessTimeoutSeconds} ))
check_release() {
  update_state="$(docker service inspect --format '{{if .UpdateStatus}}{{.UpdateStatus.State}}{{end}}' "$service_name" 2>/dev/null || true)"
  case "$update_state" in paused|rollback_started|rollback_paused|rollback_completed) echo "Swarm activation failed with state $update_state" >&2; return 2;; esac
  replicas="$(docker service ls --filter "name=^${appName}$" --format '{{.Replicas}}' | head -n 1)"
  running="\${replicas%/*}"
  desired="\${replicas#*/}"
  actual_image="$(docker service inspect --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' "$service_name" 2>/dev/null || true)"
  case "$actual_image" in "$expected_image"|"$expected_image"@*) ;; *) return 1;; esac
  [ -n "$running" ] && [ "$running" = "$desired" ] && [ "$desired" -gt 0 ]
}
while true; do
  if check_release; then break; else status=$?; fi
  [ "$status" -eq 2 ] && exit 1
  if [ "$(date +%s)" -ge "$deadline" ]; then
    docker service ps "$service_name" --no-trunc >&2 || true
    echo "Swarm did not converge on the candidate image within ${readinessTimeoutSeconds}s" >&2
    exit 1
  fi
  sleep 1
done
remaining=${stabilizationSeconds}
while [ "$remaining" -gt 0 ]; do
  check_release || { docker service ps "$service_name" --no-trunc >&2 || true; echo "Candidate release became unhealthy during stabilization" >&2; exit 1; }
  sleep 1
  remaining=$((remaining - 1))
done`;
};

export const getApplicationCancellationRequestCommand = (path: string) =>
	`mkdir -p ${quote([dirname(path)])} && touch ${quote([path])}`;

export const getApplicationCancellationCheckCommand = (path: string) =>
	`if [ -f ${quote([path])} ]; then echo "Application deployment cancellation requested" >&2; exit 130; fi`;

export const getRollbackApplicationServiceCommand = (
	appName: string,
	candidateImage: string,
	previousImage: string | null,
	readinessTimeoutSeconds = APPLICATION_READINESS_TIMEOUT_SECONDS,
) => {
	const service = quote([appName]);
	const candidate = quote([candidateImage]);
	const previous = quote([previousImage || ""]);
	return `set -e
service_name=${service}
candidate_image=${candidate}
previous_image=${previous}
matches_image() {
  actual="$1"
  expected="$2"
  [ "$actual" = "$expected" ] || [ "\${actual%%@*}" = "\${expected%%@*}" ]
}
current_image="$(docker service inspect --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' "$service_name" 2>/dev/null || true)"
[ -n "$current_image" ] || exit 0
if ! matches_image "$current_image" "$candidate_image"; then
  exit 0
fi
if [ -z "$previous_image" ]; then
  docker service rm "$service_name"
  exit 0
fi
update_state="$(docker service inspect --format '{{if .UpdateStatus}}{{.UpdateStatus.State}}{{end}}' "$service_name" 2>/dev/null || true)"
case "$update_state" in rollback_started) ;; *) docker service update --rollback --detach=true "$service_name" >/dev/null;; esac
deadline=$(( $(date +%s) + ${readinessTimeoutSeconds} ))
while true; do
  current_image="$(docker service inspect --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' "$service_name" 2>/dev/null || true)"
  replicas="$(docker service ls --filter "name=^${appName}$" --format '{{.Replicas}}' | head -n 1)"
  running="\${replicas%/*}"
  desired="\${replicas#*/}"
  if matches_image "$current_image" "$previous_image" && [ -n "$running" ] && [ "$running" = "$desired" ] && [ "$desired" -gt 0 ]; then
    exit 0
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    docker service ps "$service_name" --no-trunc >&2 || true
    echo "Swarm rollback did not converge within ${readinessTimeoutSeconds}s" >&2
    exit 1
  fi
  sleep 1
done`;
};
