#!/usr/bin/env bash
set -euo pipefail

credentials_file="${1:?credentials file is required}"
# shellcheck disable=SC1090
source "${credentials_file}"
rm -f "${credentials_file}"

: "${DOKPLOY_LAB_REGISTRY_USER:?registry user is required}"
: "${DOKPLOY_LAB_REGISTRY_PASSWORD:?registry password is required}"

registry_root=/srv/dokploy-lab/registry
install -d -m 0700 "${registry_root}/auth" "${registry_root}/data"

docker run --rm --entrypoint htpasswd httpd:2.4-alpine \
	-Bbn "${DOKPLOY_LAB_REGISTRY_USER}" "${DOKPLOY_LAB_REGISTRY_PASSWORD}" \
	>"${registry_root}/auth/htpasswd"
chmod 0600 "${registry_root}/auth/htpasswd"

docker rm -f dokploy-lab-registry >/dev/null 2>&1 || true
docker run -d \
	--name dokploy-lab-registry \
	--restart unless-stopped \
	-p 5000:5000 \
	-e REGISTRY_AUTH=htpasswd \
	-e REGISTRY_AUTH_HTPASSWD_REALM='Dokploy local lab' \
	-e REGISTRY_AUTH_HTPASSWD_PATH=/auth/htpasswd \
	-v "${registry_root}/auth:/auth:ro" \
	-v "${registry_root}/data:/var/lib/registry" \
	registry:2

for _ in $(seq 1 30); do
	if curl -fsS -u "${DOKPLOY_LAB_REGISTRY_USER}:${DOKPLOY_LAB_REGISTRY_PASSWORD}" \
		http://127.0.0.1:5000/v2/ >/dev/null; then
		exit 0
	fi
	sleep 1
done

echo 'Registry failed to become ready' >&2
exit 1
