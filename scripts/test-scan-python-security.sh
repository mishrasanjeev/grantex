#!/usr/bin/env bash
# Self-test for scripts/scan-python-security.sh against fixture trees.
set -euo pipefail

scanner="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scan-python-security.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

run() { set +e; SCAN_ROOT="$1" bash "$scanner" >"$work/.out" 2>&1; local rc=$?; set -e; echo "$rc"; }

make_pkg() {
  mkdir -p "$1/packages/demo/src/demo" "$1/packages/demo/tests"
  echo '[project]' > "$1/packages/demo/pyproject.toml"
  echo 'def ok() -> int:' > "$1/packages/demo/src/demo/__init__.py"
  echo '    return 1' >> "$1/packages/demo/src/demo/__init__.py"
}

# Clean package passes.
make_pkg "$work/clean"
rc="$(run "$work/clean")"
[[ "$rc" == 0 ]] || { cat "$work/.out" >&2; fail "clean package exited $rc, expected 0"; }

# shell=True subprocess in shipped code fails.
make_pkg "$work/flagged"
printf 'import subprocess\n\ndef run(cmd):\n    return subprocess.call(cmd, shell=True)\n' \
  > "$work/flagged/packages/demo/src/demo/runner.py"
rc="$(run "$work/flagged")"
[[ "$rc" == 1 ]] || { cat "$work/.out" >&2; fail "flagged package exited $rc, expected 1"; }
grep -q "B602" "$work/.out" || fail "flagged package did not report B602"

# The same pattern under tests/ is not shipped code and is ignored.
make_pkg "$work/tests-only"
printf 'import subprocess\n\ndef test_run():\n    subprocess.call("true", shell=True)\n' \
  > "$work/tests-only/packages/demo/tests/test_runner.py"
rc="$(run "$work/tests-only")"
[[ "$rc" == 0 ]] || { cat "$work/.out" >&2; fail "tests-only finding exited $rc, expected 0"; }

# No packages at all is an error, not a pass.
mkdir -p "$work/empty"
rc="$(run "$work/empty")"
[[ "$rc" == 2 ]] || fail "empty tree exited $rc, expected 2 (fail closed)"

echo "scan-python-security self-test: ok"
