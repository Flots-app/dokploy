#!/usr/bin/env bash
# Install Trivy from a pinned GitHub release, without going through
# aquasecurity/trivy-action or setup-trivy. In March 2026 both were hijacked and
# their tags re-pointed at a credential stealer (GHSA-69fq-xp46-6x23), so the
# scanner that guards the pipeline is fetched the way ci.yml fetches Nixpacks:
#
#   1. the tarball must match a SHA-256 committed in this file,
#   2. that SHA-256 was taken from the checksums file of the immutable release,
#      after checking the file against the release attestation.
#
# The attestation is checked when the pin is written, not on every run:
# `gh release verify-asset` calls the GitHub API, and the aquasecurity
# organization's IP allow list rejects calls made from GitHub-hosted runners.
#
# To upgrade, change TRIVY_VERSION and both checksums together:
#   gh release download "v<version>" --repo aquasecurity/trivy \
#     --pattern 'trivy_<version>_checksums.txt'
#   gh release verify-asset "v<version>" trivy_<version>_checksums.txt \
#     --repo aquasecurity/trivy
#   grep -E 'Linux-(64bit|ARM64)\.tar\.gz$' trivy_<version>_checksums.txt
set -euo pipefail

TRIVY_VERSION="0.76.1"
TRIVY_REPOSITORY="aquasecurity/trivy"
TRIVY_SHA256_LINUX_64BIT="c7cbe3137fb8a48a17574bede3dd6beb16742d1e9772929940fc90082c39d9c0"
TRIVY_SHA256_LINUX_ARM64="e174dff2a6dba5e3ae41f8d0537a6324405bd08132497340304c6b20e0f16a1f"

case "$(uname -m)" in
  x86_64)
    asset="trivy_${TRIVY_VERSION}_Linux-64bit.tar.gz"
    expected_sha256="$TRIVY_SHA256_LINUX_64BIT"
    ;;
  aarch64 | arm64)
    asset="trivy_${TRIVY_VERSION}_Linux-ARM64.tar.gz"
    expected_sha256="$TRIVY_SHA256_LINUX_ARM64"
    ;;
  *)
    echo "Unsupported architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

work_dir="${RUNNER_TEMP:?RUNNER_TEMP must point to a scratch directory}"
archive="${work_dir}/${asset}"
install_dir="${work_dir}/trivy-bin"

curl --fail --silent --show-error --location \
  --output "$archive" \
  "https://github.com/${TRIVY_REPOSITORY}/releases/download/v${TRIVY_VERSION}/${asset}"

printf '%s  %s\n' "$expected_sha256" "$archive" | sha256sum --check -

mkdir -p "$install_dir"
tar --extract --gzip --file "$archive" --directory "$install_dir" trivy
"${install_dir}/trivy" --version

echo "$install_dir" >> "${GITHUB_PATH:?GITHUB_PATH must be set}"
