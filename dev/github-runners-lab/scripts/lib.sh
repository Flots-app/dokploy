#!/usr/bin/env bash

LAB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${LAB_DIR}/.state"
LINUX_VM=dokploy-runner-linux
LINUX_SSH_PORT=22231
MAC_SSH_PORT=22230
# Created by Dokploy itself when the Mac node is provisioned.
MAC_TEST_VM=dokploy-runners-e2e

require_command() {
	if ! command -v "$1" >/dev/null 2>&1; then
		echo "Missing required command: $1" >&2
		exit 1
	fi
}

instance_exists() {
	limactl list --format '{{.Name}}' |
		awk -v expected="$1" '$0 == expected { found = 1 } END { exit !found }'
}
