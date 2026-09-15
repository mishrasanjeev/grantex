"""``grantex evidence``: verify and export evidence packages.

``grantex evidence verify package.json --root <root>`` exits 0 only when the
package verifies; on any failure it prints which check failed and where, and
exits 1. Usage and input errors exit 2.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from typing import Any, Dict, Optional, Sequence, TextIO

import httpx

from ..evidence import IDENTIFIER_CLASSES, VerificationResult, verify_package
from ..evidence._client import EvidenceApiError, export_package

__all__ = ["add_parser", "run", "EXIT_OK", "EXIT_FAILED", "EXIT_USAGE"]

EXIT_OK = 0
EXIT_FAILED = 1
EXIT_USAGE = 2

_SAFE_FILE_STEM = re.compile(r"[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}\Z")


def add_parser(subparsers: Any) -> None:
    evidence = subparsers.add_parser("evidence", help="verify and export evidence packages")
    commands = evidence.add_subparsers(dest="evidence_command", metavar="{verify,export}")
    commands.required = True

    verify = commands.add_parser("verify", help="verify an evidence package against a trusted root")
    verify.add_argument("package", help="package file, or - for standard input")
    verify.add_argument("--root", required=True, help="trusted package root, sha256:<64 hex>")
    verify.add_argument("--anchor", help="trusted anchor audit entry hash (64 hex)")
    verify.add_argument("--require-anchor", action="store_true", help="fail when the package has no anchor")
    verify.add_argument("--jwks", help="JSON Web Key Set file to verify a signature")
    verify.add_argument("--require-signature", action="store_true", help="fail when the package is not signed")
    verify.add_argument("--skip-signature", action="store_true", help="accept a signed package without checking its signature")
    verify.add_argument("--max-bytes", type=int, default=None, help="size limit (default 64 MiB)")
    verify.add_argument("--json", action="store_true", help="print the result as JSON")
    verify.set_defaults(handler=_verify)

    export = commands.add_parser("export", help="export a case's evidence package from the auth service")
    export.add_argument("case_id")
    export.add_argument("--out", "-o", help="write the package here (default: <case_id>.evidence.json)")
    export.add_argument("--disclose", action="append", choices=list(IDENTIFIER_CLASSES), default=[], help="identifier class to include in the clear (repeatable)")
    export.add_argument("--sign", action="store_true", help="ask the service to sign the package root")
    export.add_argument("--state", choices=["open", "decided", "closed"])
    export.add_argument("--url", help="auth service URL (default: $GRANTEX_URL)")
    export.add_argument("--json", action="store_true", help="print the result as JSON")
    export.set_defaults(handler=_export)


def _print_result(result: VerificationResult, as_json: bool, out: TextIO, err: TextIO) -> None:
    if as_json:
        out.write(json.dumps(result.to_dict(), indent=2) + "\n")
        return
    if result.ok:
        checks = ["hash chain", "trusted root"]
        if result.anchor_checked:
            checks.append("anchor")
        if result.signature_checked:
            checks.append("signature")
        out.write(f"verified: {result.entry_count} entries, root {result.root}\n")
        out.write(f"  checked: {', '.join(checks)}\n")
        return
    err.write(f"FAILED {result.code}: {result.message}\n")
    for label, value in (
        ("entry", result.entry_index),
        ("field", result.field_path),
        ("expected", result.expected),
        ("actual", result.actual),
    ):
        if value is not None:
            err.write(f"  {label + ':':<9} {value}\n")


def _verify(args: argparse.Namespace, out: TextIO, err: TextIO) -> int:
    if args.skip_signature and (args.jwks or args.require_signature):
        err.write("error: --skip-signature cannot be combined with --jwks or --require-signature\n")
        return EXIT_USAGE
    try:
        if args.package == "-":
            data = sys.stdin.buffer.read()
        else:
            with open(args.package, "rb") as handle:
                data = handle.read()
    except OSError as exc:
        err.write(f"error: cannot read {args.package}: {exc.strerror or exc}\n")
        return EXIT_USAGE
    jwks: Optional[Dict[str, Any]] = None
    if args.jwks:
        try:
            with open(args.jwks, "rb") as handle:
                loaded = json.loads(handle.read())
        except (OSError, ValueError) as exc:
            err.write(f"error: cannot read key set {args.jwks}: {exc}\n")
            return EXIT_USAGE
        if not isinstance(loaded, dict):
            err.write(f"error: key set {args.jwks} is not a JSON object\n")
            return EXIT_USAGE
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
        err.write("error: set GRANTEX_URL (or --url) and GRANTEX_KEY\n")
        return EXIT_USAGE
    try:
        exported = export_package(
            args.case_id,
            base_url=base_url,
            api_key=api_key,
            disclose=args.disclose,
            sign=args.sign,
            state=args.state,
        )
    except EvidenceApiError as exc:
        err.write(f"FAILED export: {exc}\n")
        return EXIT_FAILED
    except (httpx.HTTPError, ValueError) as exc:
        err.write(f"FAILED export: {type(exc).__name__}: {exc}\n")
        return EXIT_FAILED
    # Refuse to save a package that does not verify against the root the
    # service says it anchored.
    result = verify_package(
        exported.data,
        expected_root=exported.root,
        expected_anchor_hash=exported.anchor_hash,
        require_anchor=True,
        allow_unverified_signature=True,
    )
    if not result.ok:
        _print_result(result, False, out, err)
        return EXIT_FAILED
    path = args.out
    if path is None:
        if not _SAFE_FILE_STEM.match(args.case_id):
            err.write("error: the case id is not a safe file name; pass --out\n")
            return EXIT_USAGE
        path = f"{args.case_id}.evidence.json"
    try:
        with open(path, "wb") as handle:
            handle.write(exported.data)
    except OSError as exc:
        err.write(f"error: cannot write {path}: {exc.strerror or exc}\n")
        return EXIT_USAGE
    summary = {"path": path, "root": exported.root, "anchor_hash": exported.anchor_hash, "entry_count": result.entry_count}
    if args.json:
        out.write(json.dumps(summary, indent=2) + "\n")
    else:
        out.write(f"exported: {path} ({result.entry_count} entries)\n")
        out.write(f"  root:   {exported.root}\n")
        out.write(f"  anchor: {exported.anchor_hash}\n")
        out.write(f"  verify: grantex evidence verify {path} --root {exported.root}\n")
    return EXIT_OK


def run(argv: Sequence[str], out: TextIO, err: TextIO) -> int:
    """Parse ``argv`` (without the program name) and run the command."""
    from . import build_parser

    parser = build_parser()
    try:
        args = parser.parse_args(list(argv))
    except SystemExit as exc:
        return EXIT_USAGE if exc.code not in (0, None) else EXIT_OK
    handler = getattr(args, "handler", None)
    if handler is None:
        parser.print_help(err)
        return EXIT_USAGE
    code: int = handler(args, out, err)
    return code
