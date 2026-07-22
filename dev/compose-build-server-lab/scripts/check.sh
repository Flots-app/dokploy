#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"

find "${LAB_DIR}/scripts" "${LAB_DIR}/provision" -type f -name '*.sh' -print0 \
	| xargs -0 -n1 bash -n

if command -v limactl >/dev/null 2>&1; then
	limactl template validate "${LAB_DIR}/build.lima.yaml"
	limactl template validate "${LAB_DIR}/runtime.lima.yaml"
else
	echo 'Lima is not installed; skipped Lima template validation.' >&2
fi
