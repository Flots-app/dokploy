#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
load_lab_env

cat <<EOF

Dokploy Compose Build Server lab
--------------------------------
Build server : 127.0.0.1:${BUILD_SSH_PORT} (${SSH_USER}, type build)
Runtime      : 127.0.0.1:${RUNTIME_SSH_PORT} (${SSH_USER}, type deploy)
SSH key      : ${STATE_DIR}/id_ed25519
Registry URL : ${REGISTRY_HOST}
Registry user: ${DOKPLOY_LAB_REGISTRY_USER}
Registry pass: ${DOKPLOY_LAB_REGISTRY_PASSWORD}
Image prefix : flots
Git URL      : ${GIT_URL}
Git branch   : main
Compose path : compose.yml

Run the infrastructure smoke test with: make smoke
EOF

