#!/usr/bin/env bash
# Static security analysis (bandit) over every Python package's shipped code.
#
# Scans the source of each packages/*/pyproject.toml package at medium
# severity and above; tests are excluded. Fails closed when bandit is missing
# or no package is found, so a moved directory cannot turn this into a no-op.
set -euo pipefail

# SCAN_ROOT lets the self-test point the scanner at a fixture tree.
cd "${SCAN_ROOT:-$(dirname "${BASH_SOURCE[0]}")/..}"

die() { echo "scan-python-security: $*" >&2; exit 2; }

python -m bandit --version >/dev/null 2>&1 || die "bandit is not installed (pip install bandit==1.9.4)"

targets=()
for manifest in packages/*/pyproject.toml; do
  [[ -f "$manifest" ]] || continue
  pkg="$(dirname "$manifest")"
  if [[ -d "$pkg/src" ]]; then
    targets+=("$pkg/src")
  else
    targets+=("$pkg")
  fi
done

[[ ${#targets[@]} -gt 0 ]] || die "no Python packages found under packages/"

echo "bandit targets: ${targets[*]}"
python -m bandit -r "${targets[@]}" -ll -x '*/tests/*,*/test/*' -q
