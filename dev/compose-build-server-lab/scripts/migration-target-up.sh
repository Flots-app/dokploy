#!/usr/bin/env bash
set -euo pipefail

# Starts a second Deploy Server so services can be migrated between two
# runtime machines. It is provisioned like the runtime VM (Docker Swarm,
# dokploy-network and Traefik) but does not host the registry or Git fixture.

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

echo 'Starting migration target VM...'
if instance_exists "${MIGRATION_TARGET_VM}"; then
	limactl start "${MIGRATION_TARGET_VM}" --tty=false
else
	limactl start --name="${MIGRATION_TARGET_VM}" \
		"${LAB_DIR}/migration-target.lima.yaml" --tty=false
fi

limactl shell "${MIGRATION_TARGET_VM}" -- sudo bash -s \
	<"${LAB_DIR}/provision/runtime.sh"

limactl copy --backend=scp "${STATE_DIR}/id_ed25519.pub" \
	"${MIGRATION_TARGET_VM}:/tmp/dokploy-lab.pub"
limactl shell "${MIGRATION_TARGET_VM}" -- bash -euc '
	install -d -m 0700 "$HOME/.ssh"
	touch "$HOME/.ssh/authorized_keys"
	chmod 0600 "$HOME/.ssh/authorized_keys"
	key="$(cat /tmp/dokploy-lab.pub)"
	grep -qxF "$key" "$HOME/.ssh/authorized_keys" || printf "%s\n" "$key" >>"$HOME/.ssh/authorized_keys"
	rm -f /tmp/dokploy-lab.pub
'

cat <<EOF

Migration target : 127.0.0.1:${MIGRATION_TARGET_SSH_PORT} (${SSH_USER}, type deploy)
SSH key          : ${STATE_DIR}/id_ed25519

Add it in Dokploy as a second Deploy Server, then use "Migrate server" on a
service hosted on the runtime VM (127.0.0.1:${RUNTIME_SSH_PORT}).
EOF
