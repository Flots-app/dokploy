#!/usr/bin/env bash
set -euo pipefail
mkdir -p /etc/dokploy/{compose,logs,ssh,traefik/dynamic,applications,certificates,monitoring,schedules,volume-backups} /root/.ssh
chmod 700 /etc/dokploy/ssh /root/.ssh
cp /run/dokploy-public-key /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
if [[ ! -f /etc/dokploy/ssh/ssh_host_ed25519_key ]]; then
  ssh-keygen -q -t ed25519 -N '' -f /etc/dokploy/ssh/ssh_host_ed25519_key
fi
cat >/etc/ssh/sshd_config <<'EOF'
Port 2222
HostKey /etc/dokploy/ssh/ssh_host_ed25519_key
PermitRootLogin prohibit-password
AllowUsers root
PasswordAuthentication no
KbdInteractiveAuthentication no
AuthenticationMethods publickey
AllowTcpForwarding no
AllowAgentForwarding no
X11Forwarding no
Subsystem sftp internal-sftp
EOF
# Fail closed for forwarded workload egress until the firewall agent applies
# the persisted policy. Dockerd/SSH control-plane traffic uses OUTPUT/INPUT.
iptables -w -N DOCKER-USER 2>/dev/null || true
iptables -w -C DOCKER-USER -o eth0 -m comment --comment dokploy-preview-bootstrap -j DROP 2>/dev/null || iptables -w -I DOCKER-USER 1 -o eth0 -m comment --comment dokploy-preview-bootstrap -j DROP
# Unix socket only: the Docker API is never exposed over unauthenticated TCP.
mkdir -p /etc/docker
cat >/etc/docker/daemon.json <<'EOF'
{"builder":{"gc":{"enabled":true,"defaultKeepStorage":"6GB"}},"log-driver":"json-file","log-opts":{"max-size":"10m","max-file":"3"}}
EOF
dockerd --host=unix:///var/run/docker.sock --storage-driver=overlay2 --no-new-privileges &
docker_pid=$!
/usr/sbin/sshd -D -e &
ssh_pid=$!
trap 'kill -TERM "$docker_pid" "$ssh_pid" 2>/dev/null || true; wait || true' TERM INT EXIT
wait -n "$docker_pid" "$ssh_pid"
