"""Test fixtures — stub the strands module so tests run without strands installed."""

from __future__ import annotations

import base64
import json
import sys
import types
from types import SimpleNamespace
from typing import Any

import pytest
from grantex import GrantexTokenError


# ─── Strands stub ────────────────────────────────────────────────────────────

class _StrandsTool:
    """Minimal Strands tool stub that mimics the strands @tool interface."""

    def __init__(self, func: Any) -> None:
        self._func = func
        self.name = getattr(func, "__name__", "unknown")
        self.description = getattr(func, "__doc__", "") or ""

    def __call__(self, **kwargs: Any) -> str:
        return self._func(**kwargs)

    def run(self, **kwargs: Any) -> str:
        return self._func(**kwargs)


def _tool_decorator(func: Any) -> _StrandsTool:
    return _StrandsTool(func)


_strands_mod = types.ModuleType("strands")
_strands_mod.tool = _tool_decorator  # type: ignore[attr-defined]
_strands_mod.Tool = _StrandsTool  # type: ignore[attr-defined]

sys.modules.setdefault("strands", _strands_mod)


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


def _verified_grant_from_token(token: str) -> SimpleNamespace:
    try:
        payload = json.loads(base64.urlsafe_b64decode(token.split(".")[1] + "=="))
    except Exception as exc:
        raise GrantexTokenError("invalid signature") from exc
    return SimpleNamespace(scopes=tuple(payload.get("scp", [])))


@pytest.fixture(autouse=True)
def _mock_verify_grant_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "grantex_strands._tool.verify_grant_token",
        lambda token, _options: _verified_grant_from_token(token),
    )


# Pre-built tokens for tests
TOKEN_WITH_SCOPES = make_grant_token(["data:read", "data:write"])
TOKEN_WITH_READ = make_grant_token(["data:read"])
