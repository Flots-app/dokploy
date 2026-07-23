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
docker volume inspect dokploy-lab-scheduler-state >/dev/null 2>&1 ||
	docker volume create dokploy-lab-scheduler-state

install -d -m 0755 /etc/dokploy/traefik/dynamic
cat >/etc/dokploy/traefik/traefik.yml <<'YAML'
providers:
  docker:
    exposedByDefault: false
    watch: true
    network: dokploy-network
  file:
    directory: /etc/dokploy/traefik/dynamic
    watch: true
entryPoints:
  web:
    address: ":80"
  websecure:
    address: ":443"
api:
  insecure: true
YAML
chown -R dokploy:dokploy /etc/dokploy/traefik

if docker inspect dokploy-traefik >/dev/null 2>&1; then
	docker rm -f dokploy-traefik
fi
docker run -d \
	--name dokploy-traefik \
	--restart unless-stopped \
	--network dokploy-network \
	-p 80:80 \
	-p 443:443 \
	-v /var/run/docker.sock:/var/run/docker.sock:ro \
	-v /etc/dokploy/traefik/traefik.yml:/etc/traefik/traefik.yml:ro \
	-v /etc/dokploy/traefik/dynamic:/etc/dokploy/traefik/dynamic \
	traefik:v3.6.7
