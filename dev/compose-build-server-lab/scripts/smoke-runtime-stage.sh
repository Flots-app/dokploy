#!/usr/bin/env bash
set -euo pipefail

deployment_id="${1:?deployment ID is required}"
registry="${2:?registry is required}"
temporary_manifest="${3:?temporary manifest is required}"
active_manifest="${4:?active manifest is required}"
app_name=dokploy-build-server-smoke
slug="$(printf '%s' "${deployment_id}" | tr '[:upper:]_' '[:lower:]-' | tr -cd 'a-z0-9-')"
project_name="${app_name}-zdt-${slug}"
root="/etc/dokploy/compose/${app_name}"
release_dir="${root}/releases/${deployment_id}"
manifest="${release_dir}/runtime.compose.json"
active_state="${root}/active-release.json"
activation_journal="${root}/activation.json"
lock_dir="${root}/.activation.lock"
dynamic_dir=/etc/dokploy/traefik/dynamic
router_live="${dynamic_dir}/${app_name}.zdt.router.yml"
service_live="${dynamic_dir}/${app_name}.zdt.${slug}.yml"
service_release="${release_dir}/service.yml"
router_release="${release_dir}/router.yml"
route_switched=false

backend_service="${app_name}-backend-${slug}"
frontend_service="${app_name}-frontend-${slug}"
admin_service="${app_name}-admin-${slug}"

# shellcheck disable=SC1091
source /tmp/dokploy-lab-smoke.env

finish() {
	if [[ "$(cat "${lock_dir}/deployment-id" 2>/dev/null || true)" == "${deployment_id}" ]]; then
		rm -rf "${lock_dir}"
	fi
	rm -f /tmp/dokploy-lab-smoke.env
}
trap finish EXIT

cleanup_candidate() {
	docker compose -p "${project_name}" -f "${manifest}" down \
		--remove-orphans --volumes --timeout 5 >/dev/null 2>&1 || true
	rm -f "${service_live}"
	rm -rf "${release_dir}"
}

cleanup_state() {
	local state="$1"
	local state_project state_manifest state_service
	state_project="$(jq -r .projectName <<<"${state}")"
	state_manifest="$(jq -r .manifestPath <<<"${state}")"
	state_service="$(jq -r .serviceConfigPath <<<"${state}")"
	if [[ -f "${state_manifest}" ]]; then
		docker compose -p "${state_project}" -f "${state_manifest}" down \
			--remove-orphans --volumes --timeout 5 >/dev/null 2>&1 || true
	fi
	rm -f "${state_service}"
	rm -rf "$(dirname "${state_manifest}")"
}

wait_router() {
	local name="$1"
	local expected_service="$2"
	local traefik_id body
	traefik_id="$(
		docker ps -q --filter name=dokploy-traefik --filter status=running |
			head -n1
	)"
	[[ -n "${traefik_id}" ]]
	for _ in $(seq 1 30); do
		body="$(
			docker exec "${traefik_id}" wget -qO- \
				"http://127.0.0.1:8080/api/http/routers/${name}@file" 2>/dev/null ||
				true
		)"
		if grep -Fq '"status":"enabled"' <<<"${body}" &&
			grep -Fq "\"service\":\"${expected_service}\"" <<<"${body}"; then
			return
		fi
		sleep 1
	done
	return 1
}

recover_interrupted_activation() {
	[[ -f "${activation_journal}" ]] || return 0
	local journal candidate previous_journal active_deployment
	journal="$(cat "${activation_journal}")"
	candidate="$(jq -c .candidate <<<"${journal}")"
	previous_journal="$(jq -c .previous <<<"${journal}")"
	active_deployment="$(jq -r '.deploymentId // empty' "${active_state}" 2>/dev/null || true)"
	if [[ "${active_deployment}" == "$(jq -r .deploymentId <<<"${candidate}")" ]]; then
		if [[ "${previous_journal}" != null ]]; then
			cleanup_state "${previous_journal}"
		fi
		rm -f "${activation_journal}"
		return 0
	fi
	if [[ "${previous_journal}" != null ]]; then
		previous_router="$(jq -r .routerConfigPath <<<"${previous_journal}")"
		cp -f "${previous_router}" "${router_live}.tmp"
		mv -f "${router_live}.tmp" "${router_live}"
		wait_router "${app_name}-backend-web" \
			"$(jq -r .domainServices.backend <<<"${previous_journal}")"
		wait_router "${app_name}-frontend-web" \
			"$(jq -r .domainServices.frontend <<<"${previous_journal}")"
		wait_router "${app_name}-admin-web" \
			"$(jq -r .domainServices.admin <<<"${previous_journal}")"
	else
		rm -f "${router_live}"
	fi
	cleanup_state "${candidate}"
	rm -f "${activation_journal}"
}

mkdir -p "${root}" "${dynamic_dir}"
if ! mkdir "${lock_dir}" 2>/dev/null; then
	lock_deployment="$(cat "${lock_dir}/deployment-id" 2>/dev/null || true)"
	journal_deployment="$(
		jq -r '.candidate.deploymentId // empty' "${activation_journal}" 2>/dev/null ||
			true
	)"
	if [[ -n "${lock_deployment}" && "${lock_deployment}" == "${journal_deployment}" ]]; then
		rm -rf "${lock_dir}"
		mkdir "${lock_dir}"
	else
		echo "Another activation owns ${lock_dir}" >&2
		exit 1
	fi
fi
printf '%s\n' "${deployment_id}" >"${lock_dir}/deployment-id"
recover_interrupted_activation

mkdir -p "${release_dir}"
mv -f "${temporary_manifest}" "${manifest}"
chmod 0600 "${manifest}"
previous="$(cat "${active_state}" 2>/dev/null || true)"

rollback() {
	if [[ "${route_switched}" == true ]]; then
		if [[ -n "${previous}" ]]; then
			previous_router="$(jq -r '.routerConfigPath' <<<"${previous}")"
			cp -f "${previous_router}" "${router_live}.tmp"
			mv -f "${router_live}.tmp" "${router_live}"
			wait_router "${app_name}-backend-web" \
				"$(jq -r .domainServices.backend <<<"${previous}")"
			wait_router "${app_name}-frontend-web" \
				"$(jq -r .domainServices.frontend <<<"${previous}")"
			wait_router "${app_name}-admin-web" \
				"$(jq -r .domainServices.admin <<<"${previous}")"
		else
			rm -f "${router_live}"
		fi
	fi
	cleanup_candidate
	rm -f "${activation_journal}"
}
trap rollback ERR

echo '===== Pull ====='
printf '%s' "${DOKPLOY_LAB_REGISTRY_PASSWORD}" \
	| HOME="${HOME}" docker login "${registry}" \
		-u "${DOKPLOY_LAB_REGISTRY_USER}" --password-stdin
docker compose -p "${project_name}" -f "${manifest}" pull --policy always \
	backend-staging frontend-staging back-office-staging
docker compose -p "${project_name}" -f "${manifest}" pull --policy missing

candidate_state="$(
	jq -n \
		--arg deploymentId "${deployment_id}" \
		--arg projectName "${project_name}" \
		--arg manifestPath "${manifest}" \
		--arg serviceConfigPath "${service_live}" \
		--arg routerConfigPath "${router_release}" \
		--arg backend "${backend_service}" \
		--arg frontend "${frontend_service}" \
		--arg admin "${admin_service}" \
		'{
			version: 1,
			composeId: "dokploy-build-server-smoke",
			deploymentId: $deploymentId,
			projectName: $projectName,
			manifestPath: $manifestPath,
			serviceConfigPath: $serviceConfigPath,
			routerConfigPath: $routerConfigPath,
			domainServices: {
				backend: $backend,
				frontend: $frontend,
				admin: $admin
			},
			activatedAt: now | todate
		}'
)"
jq -n \
	--argjson candidate "${candidate_state}" \
	--argjson previous "${previous:-null}" \
	'{version: 1, phase: "prepared", candidate: $candidate, previous: $previous}' \
	>"${activation_journal}.tmp"
chmod 0600 "${activation_journal}.tmp"
mv -f "${activation_journal}.tmp" "${activation_journal}"

echo '===== Deploy: candidate ====='
docker compose -p "${project_name}" -f "${manifest}" up -d \
	--no-build --pull never --wait --wait-timeout 120

cat >"${service_release}" <<YAML
http:
  routers:
    ${backend_service}-probe:
      rule: Host(\`${slug}-backend.dokploy.invalid\`)
      entryPoints: [web]
      priority: 1
      service: ${backend_service}
    ${frontend_service}-probe:
      rule: Host(\`${slug}-frontend.dokploy.invalid\`)
      entryPoints: [web]
      priority: 1
      service: ${frontend_service}
    ${admin_service}-probe:
      rule: Host(\`${slug}-admin.dokploy.invalid\`)
      entryPoints: [web]
      priority: 1
      service: ${admin_service}
  services:
    ${backend_service}:
      loadBalancer:
        servers:
          - url: http://dokploy-zdt-${slug}-backend-staging:80
        healthCheck:
          path: /health
          interval: 1s
          timeout: 1s
    ${frontend_service}:
      loadBalancer:
        servers:
          - url: http://dokploy-zdt-${slug}-frontend-staging:80
        healthCheck:
          path: /
          interval: 1s
          timeout: 1s
    ${admin_service}:
      loadBalancer:
        servers:
          - url: http://dokploy-zdt-${slug}-back-office-staging:80
        healthCheck:
          path: /
          interval: 1s
          timeout: 1s
YAML
cp -f "${service_release}" "${service_live}.tmp"
mv -f "${service_live}.tmp" "${service_live}"

traefik_id="$(docker ps -q --filter name=dokploy-traefik --filter status=running | head -n1)"
[[ -n "${traefik_id}" ]]
wait_service() {
	local name="$1"
	for _ in $(seq 1 120); do
		if docker exec "${traefik_id}" wget -qO- \
			"http://127.0.0.1:8080/api/http/services/${name}@file" 2>/dev/null \
			| grep -q '"UP"'; then
			return
		fi
		sleep 1
	done
	return 1
}
wait_service "${backend_service}"
wait_service "${frontend_service}"
wait_service "${admin_service}"

if [[ "${DOKPLOY_LAB_TEST_HOOKS:-false}" == true ]]; then
	rm -f /tmp/dokploy-lab-long-request-started
	touch /tmp/dokploy-lab-cutover-ready
	for _ in $(seq 1 100); do
		[[ -f /tmp/dokploy-lab-long-request-started ]] && break
		sleep 0.1
	done
	rm -f /tmp/dokploy-lab-cutover-ready /tmp/dokploy-lab-long-request-started
fi
if [[ "${DOKPLOY_LAB_CRASH_PHASE:-none}" == prepared ]]; then
	kill -KILL "$$"
fi
if [[ "${DOKPLOY_LAB_CRASH_PHASE:-none}" == cancel-prepared ]]; then
	echo 'Cancellation requested before traffic cutover' >&2
	false
fi

write_router() {
	local include_fallback="$1"
	local backend_target="${backend_service}"
	local frontend_target="${frontend_service}"
	local admin_target="${admin_service}"
	local failovers=""
	if [[ "${include_fallback}" == true && -n "${previous}" ]]; then
		backend_target="${app_name}-backend-cutover"
		frontend_target="${app_name}-frontend-cutover"
		admin_target="${app_name}-admin-cutover"
		failovers="$(cat <<YAML
    ${backend_target}:
      failover:
        service: ${backend_service}
        fallback: $(jq -r '.domainServices.backend' <<<"${previous}")
    ${frontend_target}:
      failover:
        service: ${frontend_service}
        fallback: $(jq -r '.domainServices.frontend' <<<"${previous}")
    ${admin_target}:
      failover:
        service: ${admin_service}
        fallback: $(jq -r '.domainServices.admin' <<<"${previous}")
YAML
)"
	fi
	cat >"${router_release}.tmp" <<YAML
http:
  routers:
    ${app_name}-backend-web:
      rule: Host(\`backend.flots.test\`)
      entryPoints: [web]
      priority: 1000000
      service: ${backend_target}
    ${app_name}-frontend-web:
      rule: Host(\`frontend.flots.test\`)
      entryPoints: [web]
      priority: 1000000
      service: ${frontend_target}
    ${app_name}-admin-web:
      rule: Host(\`admin.flots.test\`)
      entryPoints: [web]
      priority: 1000000
      service: ${admin_target}
  services:
${failovers}
YAML
	mv -f "${router_release}.tmp" "${router_release}"
}

echo '===== Deploy: atomic cutover ====='
write_router true
cp -f "${router_release}" "${router_live}.tmp"
mv -f "${router_live}.tmp" "${router_live}"
route_switched=true
jq -n \
	--argjson candidate "${candidate_state}" \
	--argjson previous "${previous:-null}" \
	'{version: 1, phase: "routed", candidate: $candidate, previous: $previous}' \
	>"${activation_journal}.tmp"
chmod 0600 "${activation_journal}.tmp"
mv -f "${activation_journal}.tmp" "${activation_journal}"
if [[ "${DOKPLOY_LAB_CRASH_PHASE:-none}" == routed ]]; then
	kill -KILL "$$"
fi
if [[ "${DOKPLOY_LAB_CRASH_PHASE:-none}" == cancel-routed ]]; then
	echo 'Cancellation requested after traffic cutover' >&2
	false
fi
if [[ -n "${previous}" ]]; then
	wait_router "${app_name}-backend-web" "${app_name}-backend-cutover"
	wait_router "${app_name}-frontend-web" "${app_name}-frontend-cutover"
	wait_router "${app_name}-admin-web" "${app_name}-admin-cutover"
else
	wait_router "${app_name}-backend-web" "${backend_service}"
	wait_router "${app_name}-frontend-web" "${frontend_service}"
	wait_router "${app_name}-admin-web" "${admin_service}"
fi

for host in backend.flots.test frontend.flots.test admin.flots.test; do
	for _ in $(seq 1 30); do
		if curl -fsS -H "Host: ${host}" http://127.0.0.1/ >/dev/null; then
			break
		fi
		sleep 1
	done
	curl -fsS -H "Host: ${host}" http://127.0.0.1/
done

for _ in $(seq 1 5); do
	wait_service "${backend_service}"
	wait_service "${frontend_service}"
	wait_service "${admin_service}"
	sleep 1
done

echo '===== Deploy: promote ====='
write_router false
cp -f "${router_release}" "${router_live}.tmp"
mv -f "${router_live}.tmp" "${router_live}"
wait_router "${app_name}-backend-web" "${backend_service}"
wait_router "${app_name}-frontend-web" "${frontend_service}"
wait_router "${app_name}-admin-web" "${admin_service}"

candidate_state="$(jq '.activatedAt = (now | todate)' <<<"${candidate_state}")"
jq -n \
	--argjson candidate "${candidate_state}" \
	--argjson previous "${previous:-null}" \
	'{version: 1, phase: "promoted", candidate: $candidate, previous: $previous}' \
	>"${activation_journal}.tmp"
chmod 0600 "${activation_journal}.tmp"
mv -f "${activation_journal}.tmp" "${activation_journal}"
printf '%s\n' "${candidate_state}" >"${active_state}.tmp"
mv -f "${active_state}.tmp" "${active_state}"
cp -f "${manifest}" "${active_manifest}"
chmod 0600 "${active_manifest}" "${active_state}"
route_switched=false

if [[ -n "${previous}" ]]; then
	previous_project="$(jq -r '.projectName' <<<"${previous}")"
	previous_manifest="$(jq -r '.manifestPath' <<<"${previous}")"
	previous_service="$(jq -r '.serviceConfigPath' <<<"${previous}")"
	if docker compose -p "${previous_project}" -f "${previous_manifest}" down \
		--remove-orphans --volumes --timeout 5; then
		rm -f "${previous_service}"
		rm -rf "$(dirname "${previous_manifest}")"
	else
		echo 'Warning: the active release was promoted but old release cleanup failed.' >&2
	fi
fi
rm -f "${activation_journal}"

trap - ERR
jq -e --arg tag ":${deployment_id}" '
	([.services[] | has("build")] | any | not)
	and ([.services[] | .image | endswith($tag)] | all)
' "${active_manifest}" >/dev/null
