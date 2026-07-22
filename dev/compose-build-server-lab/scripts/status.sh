#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
require_command limactl
load_lab_env

limactl list "${BUILD_VM}" "${RUNTIME_VM}"

if [[ -f "${STATE_DIR}/id_ed25519" ]]; then
	ssh_to "${RUNTIME_SSH_PORT}" \
		"docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'"
fi
