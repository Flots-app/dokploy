#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"

"${LAB_DIR}/scripts/mac-sshd.sh" stop || true
if instance_exists "${LINUX_VM}"; then
	limactl stop "${LINUX_VM}" || true
fi
if instance_exists "${MAC_TEST_VM}"; then
	limactl stop "${MAC_TEST_VM}" || true
fi
