"""The ``grantex`` command line (installed with the Python SDK).

Commands:

- ``grantex evidence verify PACKAGE --root ROOT`` - verify an evidence package.
- ``grantex evidence export CASE_ID`` - export a case's evidence package.
"""

from __future__ import annotations

import argparse
import sys
from typing import Optional, Sequence

__all__ = ["build_parser", "main"]


def build_parser() -> argparse.ArgumentParser:
    from . import evidence

    parser = argparse.ArgumentParser(prog="grantex", description="Grantex command line")
    subparsers = parser.add_subparsers(dest="command", metavar="{evidence}")
    subparsers.required = True
    evidence.add_parser(subparsers)
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    """Console entry point. Returns the process exit code."""
    from .evidence import run

    return run(sys.argv[1:] if argv is None else argv, sys.stdout, sys.stderr)


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
