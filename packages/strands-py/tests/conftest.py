"""Shared fixtures for grantex-strands tests.

A small stand-in for the ``strands`` package is registered before the package
under test imports it, so the suite does not depend on the Strands runtime.
Grant tokens here are unsigned synthetic JWTs; signature verification is
replaced by a fake that reads the claims and can be told to fail.
"""

from __future__ import annotations

import base64
import json
import sys
import types
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from typing import Any

import pytest
from grantex import GrantexTokenError


class FakeStrandsTool:
    """What the fake ``strands.tool`` decorator returns."""

    def __init__(self, fn: Callable[..., str]) -> None:
        self.fn = fn
        self.name = fn.__name__
        self.description = fn.__doc__ or ""

    def __call__(self, **kwargs: Any) -> str:
        return self.fn(**kwargs)


def _fake_tool_decorator(fn: Callable[..., str]) -> FakeStrandsTool:
    return FakeStrandsTool(fn)


_fake_strands = types.ModuleType("strands")
_fake_strands.tool = _fake_tool_decorator
sys.modules["strands"] = _fake_strands


def _segment(value: dict[str, Any]) -> str:
    raw = json.dumps(value, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def synthetic_token(scopes: Any, **claims: Any) -> str:
    """Build an unsigned JWT whose ``scp`` claim is ``scopes``."""
    body: dict[str, Any] = {
        "iss": "https://issuer.example",
        "sub": "principal-01",
        "agt": "did:grantex:shopper-01",
        "scp": scopes,
        "iat": 1_800_000_000,
        "exp": 4_100_000_000,
        "jti": "tok-test-01",
    }
    body.update(claims)
    return ".".join([_segment({"alg": "RS256", "typ": "JWT"}), _segment(body), "sig"])


READ_ONLY = synthetic_token(["data:read"])
READ_WRITE = synthetic_token(["data:read", "data:write"])


@dataclass
class FakeVerifier:
    """Replacement for ``verify_grant_token`` that records its calls."""

    calls: list[tuple[str, Any]] = field(default_factory=list)
    failure: str | None = None

    def __call__(self, token: str, options: Any) -> Any:
        self.calls.append((token, options))
        if self.failure is not None:
            raise GrantexTokenError(self.failure)
        try:
            part = token.split(".")[1]
            claims = json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))
        except Exception as exc:  # malformed tokens fail like a bad signature
            raise GrantexTokenError("signature could not be verified") from exc
        return types.SimpleNamespace(scopes=tuple(claims.get("scp", [])))


@pytest.fixture(autouse=True)
def verifier(monkeypatch: pytest.MonkeyPatch) -> Iterator[FakeVerifier]:
    fake = FakeVerifier()
    monkeypatch.setattr("grantex_strands._tool.verify_grant_token", fake)
    yield fake
