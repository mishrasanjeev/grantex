#!/usr/bin/env bash
# Secret scanning with gitleaks.
#
#   scripts/scan-secrets.sh range <base> <head>   scan the commits in base..head
#   scripts/scan-secrets.sh history               scan every commit reachable from HEAD
#   scripts/scan-secrets.sh staged                scan staged changes (pre-commit)
#
# Fails closed: a missing or wrong gitleaks binary, an unknown mode or a commit
# that does not resolve is an error, never a pass. Findings already triaged as
# placeholders are listed by fingerprint in .gitleaksignore; see
# CONTRIBUTING.md ("Secret scanning") before adding to it.
set -euo pipefail

required_version="8.30.1"

die() { echo "scan-secrets: $*" >&2; exit 2; }

command -v gitleaks >/dev/null 2>&1 || die "gitleaks is not installed (need ${required_version})"

installed_version="$(gitleaks version 2>/dev/null | tr -d 'v[:space:]')"
if [[ "$installed_version" != "$required_version" && "${GITLEAKS_ALLOW_ANY_VERSION:-}" != "1" ]]; then
  die "gitleaks ${required_version} required, found '${installed_version}' (set GITLEAKS_ALLOW_ANY_VERSION=1 to override locally)"
fi

resolve() {
  git rev-parse --verify --quiet "$1^{commit}" || die "cannot resolve commit '$1'"
}

common=(--no-banner --redact --verbose --exit-code 1)

mode="${1:-}"
case "$mode" in
  range)
    [[ $# -eq 3 ]] || die "usage: $0 range <base> <head>"
    base="$(resolve "$2")"
    head="$(resolve "$3")"
    exec gitleaks git "${common[@]}" --log-opts="${base}..${head}" .
    ;;
  history)
    exec gitleaks git "${common[@]}" .
    ;;
  staged)
    exec gitleaks git "${common[@]}" --pre-commit --staged .
    ;;
  *)
    die "unknown mode '${mode}' (expected range, history or staged)"
    ;;
esac
