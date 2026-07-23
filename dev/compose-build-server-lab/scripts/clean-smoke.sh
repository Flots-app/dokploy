#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
require_command ssh

if [[ ! -f "${STATE_DIR}/id_ed25519" ]]; then
	exit 0
fi

active_manifest=/etc/dokploy/compose/dokploy-build-server-smoke/runtime.compose.json
ssh_to "${RUNTIME_SSH_PORT}" bash -s -- "${active_manifest}" <<'SCRIPT'
set -euo pipefail
active_manifest="$1"
root=/etc/dokploy/compose/dokploy-build-server-smoke
active_state="${root}/active-release.json"
if [[ -f "${active_state}" ]]; then
	project="$(jq -r .projectName "${active_state}")"
	manifest="$(jq -r .manifestPath "${active_state}")"
	docker compose -p "${project}" -f "${manifest}" down --remove-orphans --volumes
elif [[ -f "${active_manifest}" ]]; then
	docker compose -p dokploy-build-server-smoke -f "${active_manifest}" down --remove-orphans
fi
docker ps -aq --filter label=com.dokploy.compose-id=dokploy-build-server-smoke \
	| xargs -r docker rm -f
rm -f /etc/dokploy/traefik/dynamic/dokploy-build-server-smoke.zdt.*.yml
rm -rf "${root}"
SCRIPT

ssh_to "${BUILD_SSH_PORT}" \
	'rm -rf /etc/dokploy/compose/dokploy-build-server-smoke'
