#!/usr/bin/env bash
set -euxo pipefail

PROVISION_VERSION=1
MARKER="/var/lib/dokploy-lab/common-${PROVISION_VERSION}"

if [[ -f "${MARKER}" ]]; then
	exit 0
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
	ca-certificates \
	curl \
	git \
	jq \
	openssh-server

if ! command -v docker >/dev/null 2>&1; then
	curl -fsSL https://get.docker.com | sh
fi

install -d -m 0755 /etc/docker
cat >/etc/docker/daemon.json <<'JSON'
{
  "insecure-registries": ["lima-dokploy-runtime.internal:5000"]
}
JSON

systemctl enable --now docker
systemctl restart docker
usermod -aG docker dokploy

install -d -m 0755 -o dokploy -g dokploy /etc/dokploy
install -d -m 0755 /var/lib/dokploy-lab
touch "${MARKER}"
