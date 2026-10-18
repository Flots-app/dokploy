#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"

"${LAB_DIR}/scripts/down.sh"
for vm in "${LINUX_VM}" "${MAC_TEST_VM}"; do
	if instance_exists "${vm}"; then limactl delete --force "${vm}"; fi
done
rm -rf "${STATE_DIR}"
