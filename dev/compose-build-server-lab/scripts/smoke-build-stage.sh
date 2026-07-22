#!/usr/bin/env bash
set -euo pipefail

deployment_id="${1:?deployment ID is required}"
slow_build_seconds="${2:-0}"
git_url="${3:?Git URL is required}"
registry="${4:?registry is required}"
workdir=/etc/dokploy/compose/dokploy-build-server-smoke

# shellcheck disable=SC1091
source /tmp/dokploy-lab-smoke.env
trap 'rm -f /tmp/dokploy-lab-smoke.env' EXIT

rm -rf "${workdir}"
git clone --branch main "${git_url}" "${workdir}"
cd "${workdir}"
printf 'DOKPLOY_DEPLOYMENT_ID=%s\nSLOW_BUILD_SECONDS=%s\n' \
	"${deployment_id}" "${slow_build_seconds}" >.env

echo '===== Build ====='
HOME="${HOME}" docker compose --env-file .env -f compose.yml config --format json \
	>resolved.compose.json

jq -e --arg tag ":${deployment_id}" '
	[.services | to_entries[] | select(.value.build != null)] as $builds
	| ($builds | length) == 3
	and ($builds | all(.value.image | endswith($tag)))
	and (($builds | map(.value.image) | unique | length) == 3)
' resolved.compose.json >/dev/null

echo '===== Push ====='
printf '%s' "${DOKPLOY_LAB_REGISTRY_PASSWORD}" \
	| HOME="${HOME}" docker login "${registry}" \
		-u "${DOKPLOY_LAB_REGISTRY_USER}" --password-stdin
HOME="${HOME}" docker compose --env-file .env -f compose.yml build --push

jq '(.services[] |= del(.build))' resolved.compose.json >runtime.compose.json
jq -e '[.services[] | has("build")] | any | not' runtime.compose.json >/dev/null

