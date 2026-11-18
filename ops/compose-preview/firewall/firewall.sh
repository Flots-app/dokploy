#!/usr/bin/env bash
set -euo pipefail
# Own chains only. Never flush Docker, Tailscale or the colleague's rules.
# Policy is provided by Dokploy on the dedicated state volume.
role=${PREVIEW_FIREWALL_ROLE:?manager, worker-host or worker-engine}
policy=${PREVIEW_FIREWALL_POLICY:-/policy/firewall.json}
chain=DOKPLOY-PREVIEW
valid_ip() {
  [[ $1 =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || return 1
  local octet
  local -a octets
  IFS=. read -ra octets <<< "$1"
  for octet in "${octets[@]}"; do (( 10#$octet <= 255 )) || return 1; done
}
apply_policy() {
  local address peer port network
  [[ $role == manager || $role == worker-host || $role == worker-engine ]] || return 1
  jq -e '(.address | type == "string") and (.peers | type == "array") and (.sshAdmins | type == "array") and ((.blockedAddresses // []) | type == "array") and ((.controlPlaneMappings // []) | type == "array")' "$policy" >/dev/null
  address=$(jq -er '.address' "$policy")
  valid_ip "$address" || return 1
  mapfile -t peers < <(jq -er '.peers[]' "$policy")
  mapfile -t admins < <(jq -er '.sshAdmins[]' "$policy")
  # Every Swarm node: gossip and overlay data only, never SSH or the proxy.
  mapfile -t swarm_peers < <(jq -r '.swarmPeers[]?' "$policy")
  for peer in "${peers[@]}" "${admins[@]}" "${swarm_peers[@]}"; do valid_ip "$peer" || return 1; done
  # INPUT protects the native manager and the isolated engine. The outer host
  # is untouched: only Docker-forwarded traffic to our published IP is filtered.
  if [[ $role != worker-host ]]; then
    {
      echo '*filter'
      echo ":${chain}-IN - [0:0]"
      echo "-A ${chain}-IN -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN"
      echo "-A ${chain}-IN -i lo -j RETURN"
      # Peers are every Swarm node (managers and workers), not only preview
      # workers: Dokploy derives them from the manager's node list, so Raft,
      # gossip and overlay traffic from regular nodes keeps flowing.
      for peer in "${peers[@]}"; do
        echo "-A ${chain}-IN -s $peer -p tcp -m multiport --dports 2377,7946 -j RETURN"
        echo "-A ${chain}-IN -s $peer -p udp -m multiport --dports 7946,4789 -j RETURN"
      done
      for peer in "${swarm_peers[@]}"; do
        echo "-A ${chain}-IN -s $peer -p tcp --dport 7946 -j RETURN"
        echo "-A ${chain}-IN -s $peer -p udp -m multiport --dports 7946,4789 -j RETURN"
      done
      for peer in "${admins[@]}" "${peers[@]}"; do echo "-A ${chain}-IN -s $peer -p tcp --dport 2222 -j RETURN"; done
      echo "-A ${chain}-IN -p tcp -m multiport --dports 2377,7946 -j DROP"
      echo "-A ${chain}-IN -p udp -m multiport --dports 7946,4789 -j DROP"
      if [[ $role == worker-engine ]]; then echo "-A ${chain}-IN -p tcp --dport 2222 -j DROP"; fi
      echo "-A ${chain}-IN -j RETURN"
      echo COMMIT
    } | iptables-restore --noflush --wait 5
    iptables -w -C INPUT -j "${chain}-IN" 2>/dev/null || iptables -w -I INPUT 1 -j "${chain}-IN"
  fi
  if [[ $role == worker-host ]]; then
    {
      echo '*filter'
      echo ":${chain}-FWD - [0:0]"
      echo "-A ${chain}-FWD -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN"
      for peer in "${peers[@]}"; do echo "-A ${chain}-FWD -s $peer -j RETURN"; done
      for peer in "${swarm_peers[@]}"; do
        echo "-A ${chain}-FWD -s $peer -p tcp -m conntrack --ctorigdstport 7946 -j RETURN"
        echo "-A ${chain}-FWD -s $peer -p udp -m conntrack --ctorigdstport 7946 -j RETURN"
        echo "-A ${chain}-FWD -s $peer -p udp -m conntrack --ctorigdstport 4789 -j RETURN"
      done
      for peer in "${admins[@]}"; do echo "-A ${chain}-FWD -s $peer -p tcp --dport 2222 -j RETURN"; done
      echo "-A ${chain}-FWD -j DROP"
      echo COMMIT
    } | iptables-restore --noflush --wait 5
    for port in 2222 7946 9080; do
      iptables -w -C DOCKER-USER -p tcp -m conntrack --ctorigdst "$address" --ctorigdstport "$port" -j "${chain}-FWD" 2>/dev/null || iptables -w -I DOCKER-USER 1 -p tcp -m conntrack --ctorigdst "$address" --ctorigdstport "$port" -j "${chain}-FWD"
    done
    for port in 7946 4789; do
      iptables -w -C DOCKER-USER -p udp -m conntrack --ctorigdst "$address" --ctorigdstport "$port" -j "${chain}-FWD" 2>/dev/null || iptables -w -I DOCKER-USER 1 -p udp -m conntrack --ctorigdst "$address" --ctorigdstport "$port" -j "${chain}-FWD"
    done
  fi
  if [[ $role == worker-engine ]]; then
    # Optional address translation for an existing manager that advertises a
    # non-routable address. Only dockerd's TCP control-plane connection is
    # translated, inside the dedicated engine namespace. TLS remains end-to-end.
    local advertised reachable
    while IFS=$'\t' read -r advertised reachable; do
      [[ -z $advertised ]] && continue
      valid_ip "$advertised" && valid_ip "$reachable" || return 1
    done < <(jq -r '.controlPlaneMappings[]? | [.advertised, .reachable] | @tsv' "$policy")
    {
      echo '*nat'
      echo ":${chain}-CONTROL - [0:0]"
      while IFS=$'\t' read -r advertised reachable; do
        [[ -z $advertised ]] && continue
        echo "-A ${chain}-CONTROL -d $advertised -p tcp --dport 2377 -j DNAT --to-destination $reachable:2377"
      done < <(jq -r '.controlPlaneMappings[]? | [.advertised, .reachable] | @tsv' "$policy")
      echo COMMIT
    } | iptables-restore --noflush --wait 5
    iptables -w -t nat -C OUTPUT -j "${chain}-CONTROL" 2>/dev/null || iptables -w -t nat -I OUTPUT 1 -j "${chain}-CONTROL"
    {
      echo '*filter'
      echo ":${chain}-OUT - [0:0]"
      echo "-A ${chain}-OUT -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN"
      # DNS to the engine's own resolvers stays open (often a private address,
      # such as a cloud VPC resolver), on port 53 only.
      mapfile -t resolvers < <(jq -er '.dnsResolvers // [] | .[]' "$policy" || true)
      for resolver in "${resolvers[@]}"; do
        valid_ip "$resolver" || return 1
        echo "-A ${chain}-OUT -d $resolver -p udp --dport 53 -j RETURN"
        echo "-A ${chain}-OUT -d $resolver -p tcp --dport 53 -j RETURN"
      done
      # Blocks workload/build traffic to LAN, tailnet, metadata and other PRs.
      # Dockerd's control-plane traffic originates in OUTPUT and stays available.
      for network in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 224.0.0.0/4; do echo "-A ${chain}-OUT -d $network -j REJECT"; done
      for peer in $(jq -r '.blockedAddresses[]?' "$policy"); do valid_ip "$peer" || return 1; echo "-A ${chain}-OUT -d $peer -j REJECT"; done
      echo "-A ${chain}-OUT -j RETURN"
      echo COMMIT
    } | iptables-restore --noflush --wait 5
    # Only forwarded outbound packets. Overlay-local same-PR traffic is not
    # routed through eth0; ingress replies are accepted by conntrack.
    iptables -w -C DOCKER-USER -o eth0 -j "${chain}-OUT" 2>/dev/null || iptables -w -I DOCKER-USER 1 -o eth0 -j "${chain}-OUT"
    # The preview proxy is a published port (9080 -> Traefik :80): Docker DNATs
    # it in PREROUTING and routes it through FORWARD, so INPUT never sees it.
    # Filter it in DOCKER-USER on the original destination port instead.
    {
      echo '*filter'
      echo ":${chain}-PROXY - [0:0]"
      echo "-A ${chain}-PROXY -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN"
      for peer in "${peers[@]}"; do echo "-A ${chain}-PROXY -s $peer -j RETURN"; done
      echo "-A ${chain}-PROXY -j DROP"
      echo COMMIT
    } | iptables-restore --noflush --wait 5
    iptables -w -C DOCKER-USER -i eth0 -p tcp -m conntrack --ctorigdstport 9080 -j "${chain}-PROXY" 2>/dev/null || iptables -w -I DOCKER-USER 1 -i eth0 -p tcp -m conntrack --ctorigdstport 9080 -j "${chain}-PROXY"
  fi
  if [[ $role != worker-host ]]; then
    ip6tables -w -N "${chain}-IN" 2>/dev/null || true
    ip6tables -w -C "${chain}-IN" -p tcp -m multiport --dports 2377,7946,2222,9080,9443 -j DROP 2>/dev/null || ip6tables -w -A "${chain}-IN" -p tcp -m multiport --dports 2377,7946,2222,9080,9443 -j DROP
    ip6tables -w -C "${chain}-IN" -p udp -m multiport --dports 7946,4789 -j DROP 2>/dev/null || ip6tables -w -A "${chain}-IN" -p udp -m multiport --dports 7946,4789 -j DROP
    ip6tables -w -C INPUT -j "${chain}-IN" 2>/dev/null || ip6tables -w -I INPUT 1 -j "${chain}-IN"
  fi
  if [[ $role == worker-engine ]]; then
    iptables -w -D DOCKER-USER -o eth0 -m comment --comment dokploy-preview-bootstrap -j DROP 2>/dev/null || true
  fi
  printf '{"role":"%s","appliedAt":"%s","policySha256":"%s"}\n' "$role" "$(date -u +%FT%TZ)" "$(sha256sum "$policy" | cut -d' ' -f1)" > "/policy/${role}-status.json"
}
# Remove every rule and chain this agent owns. Stopping or deleting the agent
# container alone leaves the last applied rules in place (fail closed).
uninstall() {
  local table rule
  for table in iptables ip6tables; do
    while read -r rule; do
      # shellcheck disable=SC2086
      $table -w ${rule/-A /-D } 2>/dev/null || true
    done < <({ $table -w -S INPUT; $table -w -S DOCKER-USER; } 2>/dev/null | grep -- "-j ${chain}-" || true)
    for suffix in IN FWD OUT PROXY; do
      $table -w -F "${chain}-${suffix}" 2>/dev/null || true
      $table -w -X "${chain}-${suffix}" 2>/dev/null || true
    done
  done
  while read -r rule; do
    # shellcheck disable=SC2086
    iptables -w -t nat ${rule/-A /-D } 2>/dev/null || true
  done < <(iptables -w -t nat -S OUTPUT 2>/dev/null | grep -- "-j ${chain}-CONTROL" || true)
  iptables -w -t nat -F "${chain}-CONTROL" 2>/dev/null || true
  iptables -w -t nat -X "${chain}-CONTROL" 2>/dev/null || true
  rm -f "/policy/${role}-status.json"
  echo "Removed ${chain} rules for role ${role}"
}
case ${1:-} in
  --once) apply_policy; exit ;;
  --uninstall) uninstall; exit ;;
esac
while true; do
  # Run outside a conditional function invocation: Bash otherwise disables
  # errexit throughout apply_policy and could report failed rules as healthy.
  if ! bash "$0" --once; then echo 'Unable to apply preview firewall policy; retaining existing rules' >&2; fi
  sleep 10
done
