#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"

pidfile="${STATE_DIR}/sshd.pid"
running() { [[ -f "${pidfile}" ]] && kill -0 "$(cat "${pidfile}")" 2>/dev/null; }

case "${1:-}" in
start)
	running && exit 0
	[[ -f "${STATE_DIR}/ssh_host_ed25519_key" ]] ||
		ssh-keygen -q -t ed25519 -N '' -f "${STATE_DIR}/ssh_host_ed25519_key"
	cp "${STATE_DIR}/id_ed25519.pub" "${STATE_DIR}/authorized_keys"
	chmod 0600 "${STATE_DIR}/authorized_keys"
	cat >"${STATE_DIR}/sshd_config" <<CONFIG
Port ${MAC_SSH_PORT}
ListenAddress 127.0.0.1
HostKey ${STATE_DIR}/ssh_host_ed25519_key
AuthorizedKeysFile ${STATE_DIR}/authorized_keys
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
StrictModes no
PidFile ${pidfile}
CONFIG
	/usr/sbin/sshd -f "${STATE_DIR}/sshd_config" -E "${STATE_DIR}/sshd.log"
	sleep 1
	running || { echo "sshd did not start, see ${STATE_DIR}/sshd.log" >&2; exit 1; }
	echo "Mac node reachable at 127.0.0.1:${MAC_SSH_PORT} as $(id -un)"
	;;
stop)
	if running; then kill "$(cat "${pidfile}")"; fi
	rm -f "${pidfile}"
	;;
*)
	echo "usage: $0 start|stop" >&2
	exit 1
	;;
esac
