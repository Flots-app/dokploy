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
chmod -R a+rX "${bare_repository}"

docker rm -f dokploy-lab-git >/dev/null 2>&1 || true

if ! command -v fcgiwrap >/dev/null 2>&1; then
	export DEBIAN_FRONTEND=noninteractive
	apt-get update
	apt-get install -y --no-install-recommends fcgiwrap nginx
fi

chown -R www-data:www-data "${git_root}"

cat >/etc/nginx/sites-available/dokploy-lab-git <<'NGINX'
server {
	listen 8080;
	server_name _;

	location ~ ^/(.+\.git)(/.*)$ {
		include fastcgi_params;
		fastcgi_param SCRIPT_FILENAME /usr/lib/git-core/git-http-backend;
		fastcgi_param GIT_PROJECT_ROOT /srv/dokploy-lab/git;
		fastcgi_param GIT_HTTP_EXPORT_ALL "";
		fastcgi_param PATH_INFO /$1$2;
		fastcgi_pass unix:/run/fcgiwrap.socket;
	}
}
NGINX

ln -sfn /etc/nginx/sites-available/dokploy-lab-git \
	/etc/nginx/sites-enabled/dokploy-lab-git
systemctl enable --now fcgiwrap nginx
nginx -t
systemctl restart fcgiwrap nginx

probe_directory="$(mktemp -d)"
trap 'rm -rf "${probe_directory}"' EXIT

for _ in $(seq 1 30); do
	if git clone --quiet --branch main --depth 1 \
		http://127.0.0.1:8080/flots-compose.git "${probe_directory}/repository"; then
		exit 0
	fi
	rm -rf "${probe_directory}/repository"
	sleep 1
done

echo 'Smart HTTP Git fixture failed to accept a shallow clone' >&2
exit 1
