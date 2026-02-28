"""FastAPI middleware for Grantex grant token verification and scope-based authorization."""

from __future__ import annotations

from ._errors import GrantexFastAPIError
from ._middleware import GrantexAuth, grantex_exception_handler, require_scopes

__all__ = [
    "GrantexAuth",
    "GrantexFastAPIError",
    "grantex_exception_handler",
    "require_scopes",
]

__version__ = "0.1.0"
