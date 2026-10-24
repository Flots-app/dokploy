#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"

require_command limactl
require_command ssh-keygen
mkdir -p "${STATE_DIR}"
chmod 0700 "${STATE_DIR}"

if [[ ! -f "${STATE_DIR}/id_ed25519" ]]; then
	ssh-keygen -q -t ed25519 -N '' -C dokploy-runners-lab -f "${STATE_DIR}/id_ed25519"
fi

echo "Starting the Linux runner VM..."
if instance_exists "${LINUX_VM}"; then
	limactl start "${LINUX_VM}" --tty=false
else
	limactl start --name="${LINUX_VM}" "${LAB_DIR}/linux-runner.lima.yaml" --tty=false
fi
limactl copy --backend=scp "${STATE_DIR}/id_ed25519.pub" "${LINUX_VM}:/tmp/dokploy-lab.pub"
limactl shell "${LINUX_VM}" -- bash -euc '
	install -d -m 0700 "$HOME/.ssh"
	touch "$HOME/.ssh/authorized_keys"
	chmod 0600 "$HOME/.ssh/authorized_keys"
	key="$(cat /tmp/dokploy-lab.pub)"
	grep -qxF "$key" "$HOME/.ssh/authorized_keys" || printf "%s\n" "$key" >>"$HOME/.ssh/authorized_keys"
	rm -f /tmp/dokploy-lab.pub
'

# The Mac node is this Mac, reached through an sshd run by the current user on
# 127.0.0.1 only, with the lab key only: Remote Login stays as it is.
if [[ "$(uname -s)" == Darwin ]]; then
	"${LAB_DIR}/scripts/mac-sshd.sh" start
fi

"${LAB_DIR}/scripts/info.sh"
