#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"

require_command limactl
require_command ssh-keygen
load_lab_env
mkdir -p "${STATE_DIR}"

if [[ ! -f "${STATE_DIR}/id_ed25519" ]]; then
	ssh-keygen -q -t ed25519 -N '' -C dokploy-local-lab \
		-f "${STATE_DIR}/id_ed25519"
fi

start_instance() {
	local name="$1"
	local template="$2"
	if instance_exists "${name}"; then
		limactl start "${name}" --tty=false
	else
		limactl start --name="${name}" "${template}" --tty=false
	fi
}

echo 'Starting build VM...'
start_instance "${BUILD_VM}" "${LAB_DIR}/build.lima.yaml"
echo 'Starting runtime VM...'
start_instance "${RUNTIME_VM}" "${LAB_DIR}/runtime.lima.yaml"

install_key() {
	local name="$1"
	limactl copy --backend=scp "${STATE_DIR}/id_ed25519.pub" \
		"${name}:/tmp/dokploy-lab.pub"
	limactl shell "${name}" -- bash -euc '
		install -d -m 0700 "$HOME/.ssh"
		touch "$HOME/.ssh/authorized_keys"
		chmod 0600 "$HOME/.ssh/authorized_keys"
		key="$(cat /tmp/dokploy-lab.pub)"
		grep -qxF "$key" "$HOME/.ssh/authorized_keys" || printf "%s\n" "$key" >>"$HOME/.ssh/authorized_keys"
		rm -f /tmp/dokploy-lab.pub
	'
}

install_key "${BUILD_VM}"
install_key "${RUNTIME_VM}"

limactl copy --backend=scp "${LAB_DIR}/.env" "${RUNTIME_VM}:/tmp/dokploy-lab.env"
limactl shell "${RUNTIME_VM}" -- sudo bash -s -- /tmp/dokploy-lab.env \
	<"${LAB_DIR}/provision/registry.sh"

limactl shell "${RUNTIME_VM}" -- sudo rm -rf /tmp/flots-compose
limactl copy --backend=scp -r "${LAB_DIR}/fixture/flots-compose" \
	"${RUNTIME_VM}:/tmp/"
limactl shell "${RUNTIME_VM}" -- sudo bash -s -- /tmp/flots-compose \
	<"${LAB_DIR}/provision/git-service.sh"

cat >"${STATE_DIR}/connection.env" <<EOF
DOKPLOY_LAB_BUILD_HOST=127.0.0.1
DOKPLOY_LAB_BUILD_PORT=${BUILD_SSH_PORT}
DOKPLOY_LAB_RUNTIME_HOST=127.0.0.1
DOKPLOY_LAB_RUNTIME_PORT=${RUNTIME_SSH_PORT}
DOKPLOY_LAB_SSH_USER=${SSH_USER}
DOKPLOY_LAB_SSH_KEY=${STATE_DIR}/id_ed25519
DOKPLOY_LAB_REGISTRY=${REGISTRY_HOST}
DOKPLOY_LAB_GIT_URL=${GIT_URL}
EOF
chmod 0600 "${STATE_DIR}/connection.env"

"${LAB_DIR}/scripts/info.sh"
