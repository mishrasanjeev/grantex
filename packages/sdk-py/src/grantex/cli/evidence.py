"""Evidence package commands: ``grantex-evidence verify|export``.

The Python SDK installs this as the ``grantex-evidence`` console script (the
npm ``@grantex/cli`` package owns the ``grantex`` command, where the same
commands are ``grantex evidence verify|export``). ``python -m grantex.cli
evidence ...`` works too.

``verify`` exits 0 only when the package verifies; on any failure it prints
which check failed and where and exits 1. Usage and input errors, including a
missing or malformed ``--root``, exit 2.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from typing import Any, Dict, List, Optional, Sequence, TextIO

import httpx

from ..evidence import IDENTIFIER_CLASSES, VerificationResult, verify_package
from ..evidence._client import EvidenceApiError, export_package

__all__ = ["add_commands", "build_parser", "run", "main", "EXIT_OK", "EXIT_FAILED", "EXIT_USAGE"]

EXIT_OK = 0
EXIT_FAILED = 1
EXIT_USAGE = 2

_SAFE_FILE_STEM = re.compile(r"[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}\Z")
_ROOT = re.compile(r"sha256:[0-9a-f]{64}\Z")
_AUDIT_HASH = re.compile(r"[0-9a-f]{64}\Z")


class _UsageError(Exception):
    pass


class _Parser(argparse.ArgumentParser):
    def error(self, message: str) -> Any:  # argparse would exit; report instead
        raise _UsageError(f"{self.prog}: {message}")


def add_commands(subparsers: Any) -> None:
    verify = subparsers.add_parser("verify", help="verify an evidence package against a trusted root")
    verify.add_argument("package", help="package file, or - for standard input")
    verify.add_argument("--root", help="trusted package root, sha256:<64 hex> (required)")
    verify.add_argument("--anchor", help="trusted anchor audit entry hash (64 hex)")
    verify.add_argument("--require-anchor", action="store_true", help="fail when the package has no anchor")
    verify.add_argument("--jwks", help="JSON Web Key Set file to verify the service signature")
    verify.add_argument("--require-signature", action="store_true", help="fail when the package is not signed")
    verify.add_argument("--skip-signature", action="store_true", help="accept a signed package without checking its signature")
    verify.add_argument("--max-bytes", type=int, default=None, help="size limit in bytes (default 64 MiB)")
    verify.add_argument("--json", action="store_true", help="print the result as JSON")
    verify.set_defaults(handler=_verify)

    export = subparsers.add_parser("export", help="export a case's evidence package from the auth service")
    export.add_argument("case_id")
    export.add_argument("--out", "-o", help="write the package here (default: <case_id>.evidence.json)")
    export.add_argument("--disclose", action="append", choices=list(IDENTIFIER_CLASSES), default=[], help="class to include in the clear (repeatable; needs permission on the service)")
    export.add_argument("--sign", action="store_true", help="ask the service to sign the package root and anchor")
    export.add_argument("--url", help="auth service URL (default: $GRANTEX_URL)")
    export.add_argument("--timeout", type=float, default=30.0, help="request timeout in seconds")
    export.add_argument("--json", action="store_true", help="print the result as JSON")
    export.set_defaults(handler=_export)


def _describe_trust(result: VerificationResult) -> List[str]:
    anchor = {
        "absent": "absent",
        "internal-consistency-only": "internal-consistency-only (verify the service signature, or pin --anchor from the audit log)",
        "pinned": "pinned to the --anchor hash you supplied",
        "signed": "covered by the verified service signature",
    }[result.anchor_status]
    signature = {
        "absent": "absent",
        "unchecked": "present but not checked (--skip-signature)",
        "verified": f"verified (kid {result.signature_kid})",
    }[result.signature_status]
    lines = ["  root:      matches --root", f"  anchor:    {anchor}", f"  signature: {signature}"]
    if result.unsourced_inputs:
        lines.append(f"  unsourced policy inputs: {result.unsourced_inputs}")
    if result.late_entries:
        lines.append(f"  entries recorded late:   {result.late_entries}")
    if result.tenant_asserted_entries:
        lines.append(f"  tenant-asserted entries: {result.tenant_asserted_entries}")
    return lines


def _print_result(result: VerificationResult, as_json: bool, out: TextIO, err: TextIO) -> None:
    if as_json:
        out.write(json.dumps(result.to_dict(), indent=2) + "\n")
        return
    if result.ok:
        out.write(f"verified: {result.entry_count} entries, root {result.root}\n")
        for line in _describe_trust(result):
            out.write(line + "\n")
        return
    err.write(f"FAILED {result.code}: {result.message}\n")
    for label, value in (("entry", result.entry_index), ("field", result.field_path), ("expected", result.expected), ("actual", result.actual)):
        if value is not None:
            err.write(f"  {label + ':':<9} {value}\n")


def _verify(args: argparse.Namespace, out: TextIO, err: TextIO) -> int:
    if args.root is None or not _ROOT.match(args.root):
        raise _UsageError("--root must be the trusted package root, sha256:<64 lower-case hex digits>")
    if args.anchor is not None and not _AUDIT_HASH.match(args.anchor):
        raise _UsageError("--anchor must be 64 lower-case hex digits")
    if args.max_bytes is not None and args.max_bytes < 0:
        raise _UsageError("--max-bytes must not be negative")
    if args.skip_signature and (args.jwks or args.require_signature):
        raise _UsageError("--skip-signature cannot be combined with --jwks or --require-signature")
    try:
        if args.package == "-":
            data = sys.stdin.buffer.read()
        else:
            with open(args.package, "rb") as handle:
                data = handle.read()
    except OSError as exc:
        raise _UsageError(f"cannot read {args.package}: {exc.strerror or exc}") from None
    jwks: Optional[Dict[str, Any]] = None
    if args.jwks:
        try:
            with open(args.jwks, "rb") as handle:
                loaded = json.loads(handle.read())
        except (OSError, ValueError) as exc:
            raise _UsageError(f"cannot read key set {args.jwks}: {exc}") from None
        if not isinstance(loaded, dict):
            raise _UsageError(f"key set {args.jwks} is not a JSON object")
        jwks = loaded
    options: Dict[str, Any] = {}
    if args.max_bytes is not None:
        options["max_bytes"] = args.max_bytes
    result = verify_package(
        data,
        expected_root=args.root,
        expected_anchor_hash=args.anchor,
        require_anchor=args.require_anchor,
        jwks=jwks,
        require_signature=args.require_signature,
        allow_unverified_signature=args.skip_signature,
        **options,
    )
    _print_result(result, args.json, out, err)
    return EXIT_OK if result.ok else EXIT_FAILED


def _export(args: argparse.Namespace, out: TextIO, err: TextIO) -> int:
    base_url = args.url or os.environ.get("GRANTEX_URL")
    api_key = os.environ.get("GRANTEX_KEY")
    if not base_url or not api_key:
        raise _UsageError("set GRANTEX_URL (or --url) and GRANTEX_KEY")
    if args.out is None and not _SAFE_FILE_STEM.match(args.case_id):
        raise _UsageError("the case id is not a safe file name; pass --out")
    path = args.out or f"{args.case_id}.evidence.json"
    try:
        exported = export_package(args.case_id, base_url=base_url, api_key=api_key, disclose=args.disclose, sign=args.sign, timeout=args.timeout)
    except EvidenceApiError as exc:
        err.write(f"FAILED export: {exc}\n")
        return EXIT_FAILED
    except (httpx.HTTPError, ValueError) as exc:
        err.write(f"FAILED export: {type(exc).__name__}: {exc}\n")
        return EXIT_FAILED
    # Refuse to save a package that does not verify against the root and anchor the service reported.
    result = verify_package(exported.data, expected_root=exported.root, expected_anchor_hash=exported.anchor_hash, require_anchor=True, allow_unverified_signature=True)
    if not result.ok:
        _print_result(result, False, out, err)
        return EXIT_FAILED
    try:
        with open(path, "wb") as handle:
            handle.write(exported.data)
    except OSError as exc:
        raise _UsageError(f"cannot write {path}: {exc.strerror or exc}") from None
    summary = {"path": path, "root": exported.root, "anchor_hash": exported.anchor_hash, "entry_count": result.entry_count}
    if args.json:
        out.write(json.dumps(summary, indent=2) + "\n")
    else:
        out.write(f"exported: {path} ({result.entry_count} entries)\n")
        out.write(f"  root:   {exported.root}\n")
        out.write(f"  anchor: {exported.anchor_hash}\n")
        out.write(f"  verify: grantex-evidence verify {path} --root {exported.root} --anchor {exported.anchor_hash}\n")
    return EXIT_OK


def build_parser(prog: str = "grantex-evidence") -> argparse.ArgumentParser:
    parser = _Parser(prog=prog, description="Verify and export Grantex evidence packages")
    subparsers = parser.add_subparsers(dest="evidence_command", metavar="{verify,export}", parser_class=_Parser)
    subparsers.required = True
    add_commands(subparsers)
    return parser


def run(argv: Sequence[str], out: TextIO, err: TextIO, parser: Optional[argparse.ArgumentParser] = None) -> int:
    """Parse ``argv`` (without the program name) and run the command."""
    parser = parser or build_parser()
    try:
        args = parser.parse_args(list(argv))
        code: int = args.handler(args, out, err)
        return code
    except _UsageError as exc:
        err.write(f"error: {exc}\n")
        return EXIT_USAGE
    except SystemExit as exc:  # --help
        return EXIT_OK if exc.code in (0, None) else EXIT_USAGE


def main(argv: Optional[Sequence[str]] = None) -> int:
    """The ``grantex-evidence`` console script."""
    return run(sys.argv[1:] if argv is None else argv, sys.stdout, sys.stderr)


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
