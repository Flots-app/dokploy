#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"

cat <<INFO

SSH key for Dokploy (Settings > SSH Keys): ${STATE_DIR}/id_ed25519

Linux machine: host 127.0.0.1, port ${LINUX_SSH_PORT}, user dokploy, platform Linux
Mac machine:   host 127.0.0.1, port ${MAC_SSH_PORT}, user $(id -un), platform Mac,
               VM name ${MAC_TEST_VM}
INFO
