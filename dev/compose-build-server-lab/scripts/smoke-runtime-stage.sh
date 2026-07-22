#!/usr/bin/env bash
set -euo pipefail

deployment_id="${1:?deployment ID is required}"
registry="${2:?registry is required}"
temporary_manifest="${3:?temporary manifest is required}"
active_manifest="${4:?active manifest is required}"
project_name=dokploy-build-server-smoke

# shellcheck disable=SC1091
source /tmp/dokploy-lab-smoke.env
trap 'rm -f /tmp/dokploy-lab-smoke.env "${temporary_manifest}"' EXIT

echo '===== Pull ====='
printf '%s' "${DOKPLOY_LAB_REGISTRY_PASSWORD}" \
	| HOME="${HOME}" docker login "${registry}" \
		-u "${DOKPLOY_LAB_REGISTRY_USER}" --password-stdin
docker compose -p "${project_name}" -f "${temporary_manifest}" pull --policy always \
	backend-staging frontend-staging back-office-staging
docker compose -p "${project_name}" -f "${temporary_manifest}" pull --policy missing

echo '===== Deploy ====='
docker compose -p "${project_name}" -f "${temporary_manifest}" up -d \
	--no-build --pull never --remove-orphans
mv -f "${temporary_manifest}" "${active_manifest}"
chmod 0600 "${active_manifest}"

jq -e --arg tag ":${deployment_id}" '
	([.services[] | has("build")] | any | not)
	and ([.services[] | .image | endswith($tag)] | all)
' "${active_manifest}" >/dev/null

for port in 18080 18081 18082; do
	for _ in $(seq 1 30); do
		if curl -fsS "http://127.0.0.1:${port}" >/dev/null; then
			break
		fi
		sleep 1
	done
	curl -fsS "http://127.0.0.1:${port}"
done

