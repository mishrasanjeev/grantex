"""Command line tools shipped with the Python SDK.

- ``grantex-evidence verify PACKAGE --root ROOT`` and ``grantex-evidence export
  CASE_ID`` (console script). The npm ``@grantex/cli`` package owns the
  ``grantex`` command name, where the same commands are ``grantex evidence ...``.
- ``python -m grantex.cli evidence verify ...`` for environments without the
  console script.
"""

from __future__ import annotations

import sys
from typing import Optional, Sequence

__all__ = ["main"]


def main(argv: Optional[Sequence[str]] = None) -> int:
    """``python -m grantex.cli evidence <command>``."""
    from .evidence import EXIT_USAGE, build_parser, run

    args = list(sys.argv[1:] if argv is None else argv)
    if not args or args[0] != "evidence":
        sys.stderr.write("usage: python -m grantex.cli evidence {verify,export} ...\n")
        return EXIT_USAGE
    return run(args[1:], sys.stdout, sys.stderr, build_parser("python -m grantex.cli evidence"))


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
