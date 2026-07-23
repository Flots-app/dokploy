#!/usr/bin/env bash
set -euxo pipefail

printf 'build\n' >/etc/dokploy-lab-role
chown dokploy:dokploy /etc/dokploy-lab-role
