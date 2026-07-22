#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
require_command ssh
require_command scp
load_lab_env

if [[ ! -f "${STATE_DIR}/id_ed25519" ]]; then
	echo 'Lab is not running. Run make start first.' >&2
	exit 1
fi

active_manifest=/etc/dokploy/compose/dokploy-build-server-smoke/runtime.compose.json
mkdir -p "${STATE_DIR}"

push_credentials() {
	local port="$1"
	printf 'DOKPLOY_LAB_REGISTRY_USER=%q\nDOKPLOY_LAB_REGISTRY_PASSWORD=%q\n' \
		"${DOKPLOY_LAB_REGISTRY_USER}" "${DOKPLOY_LAB_REGISTRY_PASSWORD}" \
		| ssh_to "${port}" \
			'umask 077; cat >/tmp/dokploy-lab-smoke.env'
}

run_build() {
	local deployment_id="$1"
	local delay="$2"
	push_credentials "${BUILD_SSH_PORT}"
	ssh_to "${BUILD_SSH_PORT}" bash -s -- \
		"${deployment_id}" "${delay}" "${GIT_URL}" "${REGISTRY_HOST}" \
		<"${LAB_DIR}/scripts/smoke-build-stage.sh"
	scp_from "${BUILD_SSH_PORT}" \
		/etc/dokploy/compose/dokploy-build-server-smoke/runtime.compose.json \
		"${STATE_DIR}/runtime-${deployment_id}.compose.json"
}

transfer_manifest() {
	local deployment_id="$1"
	local destination="/etc/dokploy/compose/dokploy-build-server-smoke/.runtime-${deployment_id}.tmp"
	base64 <"${STATE_DIR}/runtime-${deployment_id}.compose.json" \
		| ssh_to "${RUNTIME_SSH_PORT}" \
			"umask 077; mkdir -p /etc/dokploy/compose/dokploy-build-server-smoke; base64 -d >${destination}; chmod 0600 ${destination}"
	printf '%s\n' "${destination}"
}

run_deploy() {
	local deployment_id="$1"
	local temporary_manifest
	temporary_manifest="$(transfer_manifest "${deployment_id}")"
	push_credentials "${RUNTIME_SSH_PORT}"
	ssh_to "${RUNTIME_SSH_PORT}" bash -s -- \
		"${deployment_id}" "${REGISTRY_HOST}" "${temporary_manifest}" "${active_manifest}" \
		<"${LAB_DIR}/scripts/smoke-runtime-stage.sh"
}

first_id="lab-$(date +%s)-a"
second_id="lab-$(date +%s)-b"
missing_id="lab-$(date +%s)-missing"

echo "Creating initial release ${first_id}..."
run_build "${first_id}" 0
run_deploy "${first_id}"

echo "Building slow release ${second_id} while checking the current release..."
slow_log="${STATE_DIR}/slow-build.log"
run_build "${second_id}" 8 >"${slow_log}" 2>&1 &
slow_pid=$!
availability_ok=true
while kill -0 "${slow_pid}" >/dev/null 2>&1; do
	if ! ssh_to "${RUNTIME_SSH_PORT}" \
		curl -fsS http://127.0.0.1:18080 >/dev/null; then
		availability_ok=false
	fi
	sleep 1
done
if ! wait "${slow_pid}"; then
	cat "${slow_log}"
	exit 1
fi
cat "${slow_log}"
if [[ "${availability_ok}" != true ]]; then
	echo 'The active release became unavailable during the build.' >&2
	exit 1
fi
run_deploy "${second_id}"

echo 'Checking that a failed pull does not mutate active containers...'
before_ids="$(ssh_to "${RUNTIME_SSH_PORT}" \
	"docker compose -p dokploy-build-server-smoke -f ${active_manifest} ps -q | sort")"
sed "s/${second_id}/${missing_id}/g" \
	"${STATE_DIR}/runtime-${second_id}.compose.json" \
	>"${STATE_DIR}/runtime-${missing_id}.compose.json"
bad_manifest="$(transfer_manifest "${missing_id}")"
if ssh_to "${RUNTIME_SSH_PORT}" \
	"docker compose -p dokploy-build-server-smoke -f ${bad_manifest} pull --policy always"; then
	echo 'The deliberately invalid pull unexpectedly succeeded.' >&2
	exit 1
fi
ssh_to "${RUNTIME_SSH_PORT}" rm -f "${bad_manifest}"
after_ids="$(ssh_to "${RUNTIME_SSH_PORT}" \
	"docker compose -p dokploy-build-server-smoke -f ${active_manifest} ps -q | sort")"
if [[ "${before_ids}" != "${after_ids}" ]]; then
	echo 'Container IDs changed after a failed pull.' >&2
	exit 1
fi

echo 'Checking stop/start from the active runtime manifest...'
ssh_to "${RUNTIME_SSH_PORT}" \
	"docker compose -p dokploy-build-server-smoke -f ${active_manifest} stop && docker compose -p dokploy-build-server-smoke -f ${active_manifest} up -d --no-build --pull never"
ssh_to "${RUNTIME_SSH_PORT}" \
	"curl --retry 20 --retry-delay 1 --retry-connrefused -fsS http://127.0.0.1:18080"

echo "Smoke test passed. Active deployment: ${second_id}"
