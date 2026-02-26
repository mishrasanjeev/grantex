from __future__ import annotations

import base64
import json
import sys
import types
from typing import Any
from unittest.mock import MagicMock

import pytest


# ─── Minimal crewai stub ─────────────────────────────────────────────────────
# Injected before any test module imports grantex_crewai so that
# `from crewai.tools import BaseTool` resolves to our stub class.

class _BaseTool:
    """Minimal BaseTool stub that mimics the CrewAI interface."""

    name: str = ""
    description: str = ""
    args_schema: Any = None

    def _run(self, **kwargs: Any) -> str:  # pragma: no cover
        raise NotImplementedError

    def run(self, **kwargs: Any) -> str:
        return self._run(**kwargs)


_crewai_tools_mod = types.ModuleType("crewai.tools")
_crewai_tools_mod.BaseTool = _BaseTool  # type: ignore[attr-defined]

_crewai_mod = types.ModuleType("crewai")
_crewai_mod.tools = _crewai_tools_mod  # type: ignore[attr-defined]

sys.modules.setdefault("crewai", _crewai_mod)
sys.modules.setdefault("crewai.tools", _crewai_tools_mod)


# ─── Pydantic stub (only needed if pydantic not installed) ───────────────────
# Most environments will have pydantic, but guard just in case.
if "pydantic" not in sys.modules:  # pragma: no cover
    _pydantic_mod = types.ModuleType("pydantic")

    class _BaseModel:
        pass

    _pydantic_mod.BaseModel = _BaseModel  # type: ignore[attr-defined]
    sys.modules["pydantic"] = _pydantic_mod


# ─── JWT helpers ─────────────────────────────────────────────────────────────

def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def make_grant_token(scopes: list[str], extra: dict[str, Any] | None = None) -> str:
    """Build a fake (unsigned) JWT with the given scp claim."""
    header = _b64url(json.dumps({"alg": "RS256", "typ": "JWT"}).encode())
    payload_data: dict[str, Any] = {
        "iss": "https://api.grantex.dev",
        "sub": "user_01",
        "agt": "did:grantex:ag_01",
        "dev": "dev_01",
        "scp": scopes,
        "iat": 1700000000,
        "exp": 9999999999,
        "jti": "tok_01",
        "grnt": "grnt_01",
    }
    if extra:
        payload_data.update(extra)
    payload = _b64url(json.dumps(payload_data).encode())
    return f"{header}.{payload}.fakesignature"


# ─── Mock Grantex client ──────────────────────────────────────────────────────

@pytest.fixture()
def mock_grantex() -> MagicMock:
    client = MagicMock()
    client.audit.log = MagicMock(return_value=None)
    return client
