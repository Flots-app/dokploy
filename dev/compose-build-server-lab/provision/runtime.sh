#!/usr/bin/env bash
set -euxo pipefail

printf 'runtime\n' >/etc/dokploy-lab-role
chown dokploy:dokploy /etc/dokploy-lab-role

if ! docker info | grep -q 'Swarm: active'; then
	advertise_address="$(hostname -I | awk '{print $1}')"
	docker swarm init --advertise-addr "${advertise_address}"
fi

if ! docker network inspect dokploy-network >/dev/null 2>&1; then
	docker network create --driver overlay --attachable dokploy-network
fi
