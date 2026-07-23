#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
require_command limactl

for instance in "${BUILD_VM}" "${RUNTIME_VM}"; do
	if instance_exists "${instance}"; then
		limactl delete -f "${instance}"
	fi
done

rm -rf "${STATE_DIR}"
