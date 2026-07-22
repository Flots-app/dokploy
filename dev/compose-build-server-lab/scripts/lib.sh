#!/usr/bin/env bash

LAB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${LAB_DIR}/.state"
BUILD_VM=dokploy-build
RUNTIME_VM=dokploy-runtime
BUILD_SSH_PORT=22221
RUNTIME_SSH_PORT=22222
SSH_USER=dokploy
REGISTRY_HOST=lima-dokploy-runtime.internal:5000
GIT_URL=http://lima-dokploy-runtime.internal:8080/flots-compose.git

require_command() {
	if ! command -v "$1" >/dev/null 2>&1; then
		echo "Missing required command: $1" >&2
		exit 1
	fi
}

load_lab_env() {
	if [[ ! -f "${LAB_DIR}/.env" ]]; then
		cp "${LAB_DIR}/.env.example" "${LAB_DIR}/.env"
	fi
	set -a
	# shellcheck disable=SC1091
	source "${LAB_DIR}/.env"
	set +a
}

instance_exists() {
	limactl list --format '{{.Name}}' | grep -Fxq "$1"
}

ssh_to() {
	local port="$1"
	shift
	ssh \
		-i "${STATE_DIR}/id_ed25519" \
		-p "${port}" \
		-o IdentitiesOnly=yes \
		-o StrictHostKeyChecking=accept-new \
		-o "UserKnownHostsFile=${STATE_DIR}/known_hosts" \
		"${SSH_USER}@127.0.0.1" "$@"
}

scp_from() {
	local port="$1"
	local remote_path="$2"
	local local_path="$3"
	scp \
		-i "${STATE_DIR}/id_ed25519" \
		-P "${port}" \
		-o IdentitiesOnly=yes \
		-o StrictHostKeyChecking=accept-new \
		-o "UserKnownHostsFile=${STATE_DIR}/known_hosts" \
		"${SSH_USER}@127.0.0.1:${remote_path}" "${local_path}"
}
