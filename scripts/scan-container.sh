#!/usr/bin/env bash
# Container and filesystem vulnerability scanning, and SBOM generation, with Trivy.
#
#   scripts/scan-container.sh image <image-ref> [sbom-out.cdx.json]
#   scripts/scan-container.sh fs <directory> [sbom-out.cdx.json]
#
# Fails the scan on HIGH or CRITICAL vulnerabilities that have a fixed version.
# Accepted exceptions live in .trivyignore.yaml, each with a statement and an
# expiry date; an expired exception stops applying and the scan fails again.
# When an SBOM path is given, a CycloneDX SBOM of the same target is written.
#
# Fails closed: a missing or different Trivy version, an unknown mode or a
# missing target is an error (exit 2), never a pass. Findings exit 1.
set -euo pipefail

required_version="0.74.0"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ignore_file="${TRIVY_IGNORE_FILE:-$root/.trivyignore.yaml}"

die() { echo "scan-container: $*" >&2; exit 2; }

command -v trivy >/dev/null 2>&1 || die "trivy is not installed (need ${required_version})"
installed="$(trivy --version 2>/dev/null | awk '/^Version:/ {print $2; exit}')"
if [[ "$installed" != "$required_version" && "${TRIVY_ALLOW_ANY_VERSION:-}" != "1" ]]; then
  die "trivy ${required_version} required, found '${installed}' (set TRIVY_ALLOW_ANY_VERSION=1 to override locally)"
fi
[[ -f "$ignore_file" ]] || die "exception file '${ignore_file}' not found"

mode="${1:-}"
target="${2:-}"
sbom="${3:-}"

case "$mode" in
  image)
    [[ -n "$target" ]] || die "usage: $0 image <image-ref> [sbom-out]"
    docker image inspect "$target" >/dev/null 2>&1 || die "image '${target}' not found locally"
    ;;
  fs)
    [[ -n "$target" && -d "$target" ]] || die "usage: $0 fs <directory> [sbom-out]"
    ;;
  *)
    die "unknown mode '${mode}' (expected image or fs)"
    ;;
esac

set +e
trivy "$mode" \
  --quiet \
  --scanners vuln \
  --severity HIGH,CRITICAL \
  --ignore-unfixed \
  --ignorefile "$ignore_file" \
  --exit-code 1 \
  --format table \
  "$target"
rc=$?
set -e

if [[ -n "$sbom" ]]; then
  trivy "$mode" --quiet --format cyclonedx --output "$sbom" "$target" \
    || die "SBOM generation failed for '${target}'"
  echo "scan-container: wrote CycloneDX SBOM to ${sbom}"
fi

case "$rc" in
  0) echo "scan-container: no unaccepted fixable HIGH/CRITICAL vulnerabilities in ${target}" ;;
  1) echo "scan-container: fixable HIGH/CRITICAL vulnerabilities found in ${target}" >&2 ;;
  *) die "trivy exited ${rc} scanning '${target}'" ;;
esac
exit "$rc"
