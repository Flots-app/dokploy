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
if [[ -f "${active_manifest}" ]]; then
	docker compose -p dokploy-build-server-smoke -f "${active_manifest}" down --remove-orphans
fi
rm -rf /etc/dokploy/compose/dokploy-build-server-smoke
SCRIPT

ssh_to "${BUILD_SSH_PORT}" \
	'rm -rf /etc/dokploy/compose/dokploy-build-server-smoke'

