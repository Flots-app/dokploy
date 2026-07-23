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
	local test_hooks="${2:-false}"
	local crash_phase="${3:-none}"
	printf 'DOKPLOY_LAB_REGISTRY_USER=%q\nDOKPLOY_LAB_REGISTRY_PASSWORD=%q\nDOKPLOY_LAB_TEST_HOOKS=%q\nDOKPLOY_LAB_CRASH_PHASE=%q\n' \
		"${DOKPLOY_LAB_REGISTRY_USER}" "${DOKPLOY_LAB_REGISTRY_PASSWORD}" \
		"${test_hooks}" "${crash_phase}" \
		| ssh_to "${port}" \
			'umask 077; cat >/tmp/dokploy-lab-smoke.env'
}

run_build() {
	local deployment_id="$1"
	local delay="$2"
	local unhealthy="${3:-false}"
	push_credentials "${BUILD_SSH_PORT}"
	ssh_to "${BUILD_SSH_PORT}" bash -s -- \
		"${deployment_id}" "${delay}" "${unhealthy}" "${GIT_URL}" "${REGISTRY_HOST}" \
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
	local test_hooks="${2:-false}"
	local crash_phase="${3:-none}"
	local temporary_manifest
	temporary_manifest="$(transfer_manifest "${deployment_id}")"
	push_credentials "${RUNTIME_SSH_PORT}" "${test_hooks}" "${crash_phase}"
	ssh_to "${RUNTIME_SSH_PORT}" bash -s -- \
		"${deployment_id}" "${REGISTRY_HOST}" "${temporary_manifest}" "${active_manifest}" \
		<"${LAB_DIR}/scripts/smoke-runtime-stage.sh"
}

first_id="lab-$(date +%s)-a"
second_id="lab-$(date +%s)-b"
missing_id="lab-$(date +%s)-missing"
unhealthy_id="lab-$(date +%s)-unhealthy"
crash_id="lab-$(date +%s)-crash"
recovery_id="lab-$(date +%s)-recovery"
final_id="lab-$(date +%s)-final"

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
		"curl -fsS -H 'Host: backend.flots.test' http://127.0.0.1/" >/dev/null; then
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

echo "Activating ${second_id} while continuously probing Traefik..."
deploy_log="${STATE_DIR}/zero-downtime-deploy.log"
ssh_to "${RUNTIME_SSH_PORT}" \
	'rm -f /tmp/dokploy-lab-cutover-ready /tmp/dokploy-lab-long-request-started'
run_deploy "${second_id}" true >"${deploy_log}" 2>&1 &
deploy_pid=$!
availability_ok=true
unexpected_release=false
long_pid=""
long_response="${STATE_DIR}/long-request.response"
while kill -0 "${deploy_pid}" >/dev/null 2>&1; do
	if [[ -z "${long_pid}" ]] && ssh_to "${RUNTIME_SSH_PORT}" \
		'test -f /tmp/dokploy-lab-cutover-ready'; then
		ssh_to "${RUNTIME_SSH_PORT}" \
			"curl -fsS -H 'Host: backend.flots.test' http://127.0.0.1/slow/3" \
			>"${long_response}" &
		long_pid=$!
		sleep 0.2
		ssh_to "${RUNTIME_SSH_PORT}" \
			'touch /tmp/dokploy-lab-long-request-started'
	fi
	response="$(ssh_to "${RUNTIME_SSH_PORT}" \
		"curl -fsS -H 'Host: backend.flots.test' http://127.0.0.1/" || true)"
	if [[ -z "${response}" ]]; then
		availability_ok=false
	elif [[ "${response}" != "backend:${first_id}" && "${response}" != "backend:${second_id}" ]]; then
		unexpected_release=true
	fi
	sleep 0.1
done
if ! wait "${deploy_pid}"; then
	cat "${deploy_log}"
	exit 1
fi
cat "${deploy_log}"
if [[ "${availability_ok}" != true || "${unexpected_release}" == true ]]; then
	echo 'Traefik returned an error or an unexpected release during activation.' >&2
	exit 1
fi
if [[ -z "${long_pid}" ]] || ! wait "${long_pid}" ||
	[[ "$(tr -d '\r\n' <"${long_response}")" != "backend:${first_id}" ]]; then
	echo 'The in-flight request did not complete on the draining release.' >&2
	exit 1
fi
ssh_to "${RUNTIME_SSH_PORT}" \
	"test \"\$(curl -fsS -H 'Host: backend.flots.test' http://127.0.0.1/)\" = 'backend:${second_id}'"

echo 'Checking that a failed pull does not mutate active containers...'
active_state=/etc/dokploy/compose/dokploy-build-server-smoke/active-release.json
active_project="$(ssh_to "${RUNTIME_SSH_PORT}" "jq -r .projectName ${active_state}")"
active_release_manifest="$(ssh_to "${RUNTIME_SSH_PORT}" "jq -r .manifestPath ${active_state}")"
before_ids="$(ssh_to "${RUNTIME_SSH_PORT}" \
	"docker compose -p ${active_project} -f ${active_release_manifest} ps -q | sort")"
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
	"docker compose -p ${active_project} -f ${active_release_manifest} ps -q | sort")"
if [[ "${before_ids}" != "${after_ids}" ]]; then
	echo 'Container IDs changed after a failed pull.' >&2
	exit 1
fi

echo 'Checking that an unhealthy candidate is removed without a traffic switch...'
run_build "${unhealthy_id}" 0 true
if run_deploy "${unhealthy_id}"; then
	echo 'The deliberately unhealthy candidate unexpectedly deployed.' >&2
	exit 1
fi
ssh_to "${RUNTIME_SSH_PORT}" \
	"test \"\$(jq -r .deploymentId ${active_state})\" = '${second_id}'"
ssh_to "${RUNTIME_SSH_PORT}" \
	"test \"\$(curl -fsS -H 'Host: backend.flots.test' http://127.0.0.1/)\" = 'backend:${second_id}'"
after_unhealthy_ids="$(ssh_to "${RUNTIME_SSH_PORT}" \
	"docker compose -p ${active_project} -f ${active_release_manifest} ps -q | sort")"
if [[ "${before_ids}" != "${after_unhealthy_ids}" ]]; then
	echo 'Container IDs changed after an unhealthy candidate.' >&2
	exit 1
fi

echo 'Simulating an orchestrator crash immediately after the failover cutover...'
run_build "${crash_id}" 0
if run_deploy "${crash_id}" false routed; then
	echo 'The crash injection unexpectedly returned success.' >&2
	exit 1
fi
ssh_to "${RUNTIME_SSH_PORT}" \
	"test \"\$(jq -r .phase /etc/dokploy/compose/dokploy-build-server-smoke/activation.json)\" = routed"
crash_response="$(ssh_to "${RUNTIME_SSH_PORT}" \
	"curl -fsS -H 'Host: backend.flots.test' http://127.0.0.1/")"
if [[ "${crash_response}" != "backend:${second_id}" &&
	"${crash_response}" != "backend:${crash_id}" ]]; then
	echo 'Traffic failed after the simulated orchestrator crash.' >&2
	exit 1
fi

echo 'Recovering the interrupted activation with the next deployment...'
run_build "${recovery_id}" 0
run_deploy "${recovery_id}"
ssh_to "${RUNTIME_SSH_PORT}" \
	"test ! -e /etc/dokploy/compose/dokploy-build-server-smoke/activation.json"
ssh_to "${RUNTIME_SSH_PORT}" \
	"test -z \"\$(docker ps -aq --filter label=com.dokploy.deployment-id=${crash_id})\""

echo 'Cancelling a candidate before traffic cutover...'
if run_deploy "${crash_id}" false cancel-prepared; then
	echo 'The pre-cutover cancellation unexpectedly returned success.' >&2
	exit 1
fi
ssh_to "${RUNTIME_SSH_PORT}" \
	"test \"\$(curl -fsS -H 'Host: backend.flots.test' http://127.0.0.1/)\" = 'backend:${recovery_id}'"
ssh_to "${RUNTIME_SSH_PORT}" \
	"test -z \"\$(docker ps -aq --filter label=com.dokploy.deployment-id=${crash_id})\""

echo 'Cancelling a candidate after traffic cutover...'
if run_deploy "${crash_id}" false cancel-routed; then
	echo 'The post-cutover cancellation unexpectedly returned success.' >&2
	exit 1
fi
ssh_to "${RUNTIME_SSH_PORT}" \
	"test \"\$(curl -fsS -H 'Host: backend.flots.test' http://127.0.0.1/)\" = 'backend:${recovery_id}'"
ssh_to "${RUNTIME_SSH_PORT}" \
	"test ! -e /etc/dokploy/compose/dokploy-build-server-smoke/activation.json"

echo 'Running a second consecutive redeployment...'
run_build "${final_id}" 0
run_deploy "${final_id}"
active_project="$(ssh_to "${RUNTIME_SSH_PORT}" "jq -r .projectName ${active_state}")"
active_release_manifest="$(ssh_to "${RUNTIME_SSH_PORT}" "jq -r .manifestPath ${active_state}")"
ssh_to "${RUNTIME_SSH_PORT}" \
	"test \"\$(curl -fsS -H 'Host: backend.flots.test' http://127.0.0.1/)\" = 'backend:${final_id}'"

echo 'Checking VM role isolation, immutable image tags and scheduler leadership...'
ssh_to "${BUILD_SSH_PORT}" \
	"test -z \"\$(docker ps -aq --filter label=com.dokploy.compose-id=dokploy-build-server-smoke)\""
ssh_to "${RUNTIME_SSH_PORT}" \
	"test \"\$(docker ps -q --filter label=com.dokploy.compose-id=dokploy-build-server-smoke | wc -l | tr -d ' ')\" = 4"
ssh_to "${RUNTIME_SSH_PORT}" \
	"test \"\$(docker ps -q --filter label=com.docker.compose.project=${active_project} --filter label=com.docker.compose.service=scheduler-staging | wc -l | tr -d ' ')\" = 1"
ssh_to "${RUNTIME_SSH_PORT}" \
	"for _ in \$(seq 1 20); do test \"\$(docker run --rm -v dokploy-lab-scheduler-state:/state alpine:3.22 cat /state/active 2>/dev/null)\" = '${final_id}' && exit 0; sleep 1; done; exit 1"
ssh_to "${RUNTIME_SSH_PORT}" \
	"jq -e --arg tag ':${final_id}' '([.services[] | select(.build != null)] | length) == 0 and ([.services[] | .image | select(startswith(\"${REGISTRY_HOST}/flots/\")) | endswith(\$tag)] | all)' ${active_release_manifest} >/dev/null"

echo 'Checking stop/start from the active runtime manifest...'
ssh_to "${RUNTIME_SSH_PORT}" \
	"docker compose -p ${active_project} -f ${active_release_manifest} stop && docker compose -p ${active_project} -f ${active_release_manifest} up -d --no-build --pull never --wait"
ssh_to "${RUNTIME_SSH_PORT}" \
	"curl --retry 20 --retry-delay 1 --retry-connrefused -fsS -H 'Host: backend.flots.test' http://127.0.0.1/"
echo "Smoke test passed. Active deployment: ${final_id}"
