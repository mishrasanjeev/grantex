#!/usr/bin/env bash
# Self-test for scripts/scan-secrets.sh.
#
# Builds a throwaway git repository, commits a clean change and a change that
# carries a synthetic credential, and asserts the scanner passes the first
# range and fails the second. The credential is assembled at runtime so this
# file never contains a value the scanner would flag.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scanner="$here/scan-secrets.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

git -C "$work" init -q
git -C "$work" config user.email "ci@example.com"
git -C "$work" config user.name "ci"
git -C "$work" config commit.gpgsign false

echo "hello" > "$work/README.md"
git -C "$work" add README.md
git -C "$work" commit -qm "initial"
base="$(git -C "$work" rev-parse HEAD)"

echo "nothing sensitive here" >> "$work/README.md"
git -C "$work" commit -qam "clean change"
clean_head="$(git -C "$work" rev-parse HEAD)"

# AWS access key id shape: AKIA followed by 16 characters from [A-Z2-7].
synthetic="AKIA$(printf 'Q%.0s' {1..4})7X2M4N6PZRKT"
printf 'aws_access_key_id = %s\n' "$synthetic" > "$work/config.ini"
git -C "$work" add config.ini
git -C "$work" commit -qm "leaky change"
leaky_head="$(git -C "$work" rev-parse HEAD)"

exit_code() { set +e; (cd "$work" && "$BASH" "$scanner" "$@") >"$work/.out" 2>&1; local rc=$?; set -e; echo "$rc"; }

rc="$(exit_code range "$base" "$clean_head")"
[[ "$rc" == 0 ]] || { cat "$work/.out" >&2; fail "clean range exited $rc, expected 0"; }

# 1 = leak found.
rc="$(exit_code range "$clean_head" "$leaky_head")"
[[ "$rc" == 1 ]] || { cat "$work/.out" >&2; fail "leaky range exited $rc, expected 1"; }
grep -q "aws-access-token" "$work/.out" || fail "leaky range did not report the aws-access-token rule"

# 2 = scanner refused to run.
rc="$(exit_code range "not-a-commit" "$leaky_head")"
[[ "$rc" == 2 ]] || fail "unresolvable base exited $rc, expected 2 (fail closed)"

rc="$(exit_code bogus-mode)"
[[ "$rc" == 2 ]] || fail "unknown mode exited $rc, expected 2 (fail closed)"

rc="$(PATH="/nonexistent" exit_code history)"
[[ "$rc" == 2 ]] || fail "missing gitleaks binary exited $rc, expected 2 (fail closed)"

echo "scan-secrets self-test: ok"
