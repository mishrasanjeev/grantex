#!/usr/bin/env bash
# Self-test for scripts/scan-container.sh.
#
# Uses filesystem mode against a fixture lockfile pinning lodash 4.17.20, which
# has a HIGH advisory (CVE-2021-23337) fixed in 4.17.21, so it needs no image
# build. Checks the gate, the exception file (valid and expired), SBOM output
# and the fail-closed cases.
set -euo pipefail

scanner="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scan-container.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
run() { set +e; bash "$scanner" "$@" >"$work/.out" 2>&1; local rc=$?; set -e; echo "$rc"; }

fixture="$work/app"
mkdir -p "$fixture"
cat > "$fixture/package.json" <<'EOF'
{ "name": "scan-fixture", "version": "1.0.0", "dependencies": { "lodash": "4.17.20" } }
EOF
cat > "$fixture/package-lock.json" <<'EOF'
{
  "name": "scan-fixture",
  "version": "1.0.0",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": { "name": "scan-fixture", "version": "1.0.0", "dependencies": { "lodash": "4.17.20" } },
    "node_modules/lodash": {
      "version": "4.17.20",
      "resolved": "https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz",
      "license": "MIT"
    }
  }
}
EOF

printf 'vulnerabilities: []\n' > "$work/empty.yaml"

# 1 = unaccepted fixable HIGH finding.
rc="$(TRIVY_IGNORE_FILE="$work/empty.yaml" run fs "$fixture")"
[[ "$rc" == 1 ]] || { cat "$work/.out" >&2; fail "vulnerable fixture exited $rc, expected 1"; }
grep -q "CVE-2021-23337" "$work/.out" || fail "vulnerable fixture did not report CVE-2021-23337"

# Advisories for the fixture can grow over time, so the exception files accept
# every ID the scan just reported rather than a hard-coded list.
write_exceptions() {
  local expiry="$1"
  echo "vulnerabilities:"
  grep -oE '(CVE|GHSA)-[A-Za-z0-9-]+' "$work/.out" | sort -u | while read -r id; do
    printf '  - id: %s\n    purls:\n      - pkg:npm/lodash@4.17.20\n    statement: self-test exception\n    expired_at: %s\n' "$id" "$expiry"
  done
}
future="$(date -u -d '+30 days' +%Y-%m-%d 2>/dev/null || date -u -v+30d +%Y-%m-%d)"
write_exceptions "$future" > "$work/accepted.yaml"
write_exceptions "2020-01-01" > "$work/expired.yaml"

# A current exception is honoured, and the SBOM is written.
rc="$(TRIVY_IGNORE_FILE="$work/accepted.yaml" run fs "$fixture" "$work/sbom.cdx.json")"
[[ "$rc" == 0 ]] || { cat "$work/.out" >&2; fail "accepted exception exited $rc, expected 0"; }
grep -q '"bomFormat": *"CycloneDX"' "$work/sbom.cdx.json" || fail "SBOM is not CycloneDX"
grep -q 'pkg:npm/lodash@4.17.20' "$work/sbom.cdx.json" || fail "SBOM does not list the fixture dependency"

# An expired exception no longer applies.
rc="$(TRIVY_IGNORE_FILE="$work/expired.yaml" run fs "$fixture")"
[[ "$rc" == 1 ]] || { cat "$work/.out" >&2; fail "expired exception exited $rc, expected 1"; }

# 2 = refused to run.
rc="$(TRIVY_IGNORE_FILE="$work/empty.yaml" run bogus "$fixture")"
[[ "$rc" == 2 ]] || fail "unknown mode exited $rc, expected 2 (fail closed)"
rc="$(TRIVY_IGNORE_FILE="$work/empty.yaml" run fs "$work/does-not-exist")"
[[ "$rc" == 2 ]] || fail "missing directory exited $rc, expected 2 (fail closed)"
rc="$(TRIVY_IGNORE_FILE="$work/missing.yaml" run fs "$fixture")"
[[ "$rc" == 2 ]] || fail "missing exception file exited $rc, expected 2 (fail closed)"

echo "scan-container self-test: ok"
