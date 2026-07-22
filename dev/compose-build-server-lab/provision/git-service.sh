#!/usr/bin/env bash
set -euxo pipefail

source_directory="${1:-/tmp/flots-compose}"
git_root=/srv/dokploy-lab/git
bare_repository="${git_root}/flots-compose.git"

rm -rf "${bare_repository}"
install -d -m 0755 "${git_root}"

git -C "${source_directory}" init -b main
git -C "${source_directory}" config user.name 'Dokploy Lab'
git -C "${source_directory}" config user.email 'dokploy-lab@localhost'
git -C "${source_directory}" add .
git -C "${source_directory}" commit -m 'Add Compose build-server smoke fixture'
git clone --bare "${source_directory}" "${bare_repository}"
git --git-dir="${bare_repository}" update-server-info
chmod -R a+rX "${bare_repository}"

docker rm -f dokploy-lab-git >/dev/null 2>&1 || true
docker run -d \
	--name dokploy-lab-git \
	--restart unless-stopped \
	-p 8080:80 \
	-v "${git_root}:/usr/share/nginx/html:ro" \
	nginx:1.29-alpine

for _ in $(seq 1 30); do
	if curl -fsS http://127.0.0.1:8080/flots-compose.git/HEAD >/dev/null; then
		exit 0
	fi
	sleep 1
done

echo 'Git fixture service failed to become ready' >&2
exit 1

