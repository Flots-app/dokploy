#!/usr/bin/env bash
# Install Bearer CLI from a pinned GitHub release, without going through
# bearer/bearer-action or the curl | sh installer in the Bearer repository. The
# scanner that guards the pipeline is fetched the way ci.yml fetches Nixpacks:
# the tarball must match a SHA-256 committed in this file.
#
# Bearer releases are neither immutable nor attested, so the pin is the whole
# protection: it stops a re-pointed tag or a replaced asset from reaching CI
# unnoticed. The values below were taken from checksums.txt of the release and
# checked against the digests GitHub reports for the assets and against the
# formula of Bearer/homebrew-tap, which is published from another repository.
#
# To upgrade, change BEARER_VERSION and both checksums together:
#   gh release download "v<version>" --repo Bearer/bearer --pattern checksums.txt
#   grep -E 'linux_(amd64|arm64)\.tar\.gz$' checksums.txt
#   gh api repos/Bearer/homebrew-tap/contents/Formula/bearer.rb \
#     --jq .content | base64 -d | grep sha256
# then run `bash .github/scripts/install-bearer.sh` once and re-run the scan
# locally: a new Bearer version ships new rules and can add findings.
set -euo pipefail

BEARER_VERSION="2.1.2"
BEARER_REPOSITORY="Bearer/bearer"
BEARER_SHA256_LINUX_AMD64="a1db6ef048c348ac637e15e5866c99203b688b1313df8a06464dbf01a334f121"
BEARER_SHA256_LINUX_ARM64="5a872028f69c1b0272941402770e65f7473f98dd696a79b0cbea9881a7c91651"

case "$(uname -m)" in
  x86_64)
    asset="bearer_${BEARER_VERSION}_linux_amd64.tar.gz"
    expected_sha256="$BEARER_SHA256_LINUX_AMD64"
    ;;
  aarch64 | arm64)
    asset="bearer_${BEARER_VERSION}_linux_arm64.tar.gz"
    expected_sha256="$BEARER_SHA256_LINUX_ARM64"
    ;;
  *)
    echo "Unsupported architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

work_dir="${RUNNER_TEMP:?RUNNER_TEMP must point to a scratch directory}"
archive="${work_dir}/${asset}"
install_dir="${work_dir}/bearer-bin"

curl --fail --silent --show-error --location \
  --output "$archive" \
  "https://github.com/${BEARER_REPOSITORY}/releases/download/v${BEARER_VERSION}/${asset}"

printf '%s  %s\n' "$expected_sha256" "$archive" | sha256sum --check -

mkdir -p "$install_dir"
tar --extract --gzip --file "$archive" --directory "$install_dir" bearer
"${install_dir}/bearer" version --disable-version-check

echo "$install_dir" >> "${GITHUB_PATH:?GITHUB_PATH must be set}"
