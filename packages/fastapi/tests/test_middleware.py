from __future__ import annotations

from typing import Any, Optional
from unittest.mock import MagicMock, patch

import pytest
from fastapi import Depends, FastAPI, Request
from fastapi.testclient import TestClient
from grantex import VerifiedGrant

from grantex_fastapi import GrantexAuth, GrantexFastAPIError, grantex_exception_handler, require_scopes


JWKS_URI = "https://example.com/.well-known/jwks.json"

MOCK_GRANT = VerifiedGrant(
    token_id="tok_01",
    grant_id="grnt_01",
    principal_id="user_123",
    agent_did="did:grantex:ag_01",
    developer_id="dev_01",
    scopes=("calendar:read", "email:read"),
    issued_at=1709100000,
    expires_at=1709200000,
)


def _make_app(
    grantex: GrantexAuth,
    scopes: Optional[tuple[str, ...]] = None,
) -> FastAPI:
    """Create a minimal FastAPI app for testing."""
    app = FastAPI()
    app.add_exception_handler(GrantexFastAPIError, grantex_exception_handler)  # type: ignore[arg-type]

    if scopes:
        dep = grantex.scopes(*scopes)
    else:
        dep = grantex  # type: ignore[assignment]

    @app.get("/api/test")
    async def test_route(grant: VerifiedGrant = Depends(dep)) -> dict[str, Any]:
        return {
            "principalId": grant.principal_id,
            "scopes": list(grant.scopes),
        }

    return app


# ─── Token verification ─────────────────────────────────────────────────────


class TestGrantexAuth:
    @patch("grantex_fastapi._middleware.verify_grant_token")
    def test_valid_token(self, mock_verify: MagicMock) -> None:
        mock_verify.return_value = MOCK_GRANT
        grantex = GrantexAuth(jwks_uri=JWKS_URI)
        app = _make_app(grantex)
        client = TestClient(app)

        resp = client.get("/api/test", headers={"Authorization": "Bearer valid.jwt.token"})

        assert resp.status_code == 200
        data = resp.json()
        assert data["principalId"] == "user_123"
        assert data["scopes"] == ["calendar:read", "email:read"]

    def test_missing_token(self) -> None:
        grantex = GrantexAuth(jwks_uri=JWKS_URI)
        app = _make_app(grantex)
        client = TestClient(app)

        resp = client.get("/api/test")

        assert resp.status_code == 401
        data = resp.json()
        assert data["error"] == "TOKEN_MISSING"

    def test_non_bearer_auth(self) -> None:
        grantex = GrantexAuth(jwks_uri=JWKS_URI)
        app = _make_app(grantex)
        client = TestClient(app)

        resp = client.get("/api/test", headers={"Authorization": "Basic dXNlcjpwYXNz"})

        assert resp.status_code == 401
        assert resp.json()["error"] == "TOKEN_MISSING"

    @patch("grantex_fastapi._middleware.verify_grant_token")
    def test_invalid_token(self, mock_verify: MagicMock) -> None:
        from grantex import GrantexTokenError

        mock_verify.side_effect = GrantexTokenError("Grant token verification failed: invalid signature")
        grantex = GrantexAuth(jwks_uri=JWKS_URI)
        app = _make_app(grantex)
        client = TestClient(app)

        resp = client.get("/api/test", headers={"Authorization": "Bearer bad.token.here"})

        assert resp.status_code == 401
        assert resp.json()["error"] == "TOKEN_INVALID"

    @patch("grantex_fastapi._middleware.verify_grant_token")
    def test_expired_token(self, mock_verify: MagicMock) -> None:
        from grantex import GrantexTokenError

        mock_verify.side_effect = GrantexTokenError(
            'Grant token verification failed: Signature has expired'
        )
        grantex = GrantexAuth(jwks_uri=JWKS_URI)
        app = _make_app(grantex)
        client = TestClient(app)

        resp = client.get("/api/test", headers={"Authorization": "Bearer expired.token"})

        assert resp.status_code == 401
        assert resp.json()["error"] == "TOKEN_EXPIRED"

    @patch("grantex_fastapi._middleware.verify_grant_token")
    def test_clock_tolerance_and_audience_passed(self, mock_verify: MagicMock) -> None:
        mock_verify.return_value = MOCK_GRANT
        grantex = GrantexAuth(jwks_uri=JWKS_URI, clock_tolerance=10, audience="my-app")
        app = _make_app(grantex)
        client = TestClient(app)

        resp = client.get("/api/test", headers={"Authorization": "Bearer some.token"})

        assert resp.status_code == 200
        opts = mock_verify.call_args[0][1]
        assert opts.jwks_uri == JWKS_URI
        assert opts.clock_tolerance == 10
        assert opts.audience == "my-app"

    @patch("grantex_fastapi._middleware.verify_grant_token")
    def test_custom_token_extractor(self, mock_verify: MagicMock) -> None:
        mock_verify.return_value = MOCK_GRANT

        def extract_from_header(request: Request) -> Optional[str]:
            return request.headers.get("X-Grant-Token")

        grantex = GrantexAuth(jwks_uri=JWKS_URI, token_extractor=extract_from_header)
        app = _make_app(grantex)
        client = TestClient(app)

        resp = client.get("/api/test", headers={"X-Grant-Token": "custom.header.token"})

        assert resp.status_code == 200
        mock_verify.assert_called_once()
        assert mock_verify.call_args[0][0] == "custom.header.token"

    def test_custom_extractor_returns_none(self) -> None:
        grantex = GrantexAuth(jwks_uri=JWKS_URI, token_extractor=lambda r: None)
        app = _make_app(grantex)
        client = TestClient(app)

        resp = client.get("/api/test", headers={"Authorization": "Bearer ignored"})

        assert resp.status_code == 401
        assert resp.json()["error"] == "TOKEN_MISSING"


# ─── Scope checking via .scopes() dependency ────────────────────────────────


class TestScopesDependency:
    @patch("grantex_fastapi._middleware.verify_grant_token")
    def test_scopes_pass(self, mock_verify: MagicMock) -> None:
        mock_verify.return_value = MOCK_GRANT
        grantex = GrantexAuth(jwks_uri=JWKS_URI)
        app = _make_app(grantex, scopes=("calendar:read",))
        client = TestClient(app)

        resp = client.get("/api/test", headers={"Authorization": "Bearer valid.token"})

        assert resp.status_code == 200

    @patch("grantex_fastapi._middleware.verify_grant_token")
    def test_multiple_scopes_pass(self, mock_verify: MagicMock) -> None:
        mock_verify.return_value = MOCK_GRANT
        grantex = GrantexAuth(jwks_uri=JWKS_URI)
        app = _make_app(grantex, scopes=("calendar:read", "email:read"))
        client = TestClient(app)

        resp = client.get("/api/test", headers={"Authorization": "Bearer valid.token"})

        assert resp.status_code == 200

    @patch("grantex_fastapi._middleware.verify_grant_token")
    def test_missing_scope(self, mock_verify: MagicMock) -> None:
        mock_verify.return_value = MOCK_GRANT
        grantex = GrantexAuth(jwks_uri=JWKS_URI)
        app = _make_app(grantex, scopes=("calendar:write",))
        client = TestClient(app)

        resp = client.get("/api/test", headers={"Authorization": "Bearer valid.token"})

        assert resp.status_code == 403
        data = resp.json()
        assert data["error"] == "SCOPE_INSUFFICIENT"
        assert "calendar:write" in data["message"]

    @patch("grantex_fastapi._middleware.verify_grant_token")
    def test_multiple_missing_scopes(self, mock_verify: MagicMock) -> None:
        mock_verify.return_value = MOCK_GRANT
        grantex = GrantexAuth(jwks_uri=JWKS_URI)
        app = _make_app(grantex, scopes=("calendar:write", "email:write"))
        client = TestClient(app)

        resp = client.get("/api/test", headers={"Authorization": "Bearer valid.token"})

        assert resp.status_code == 403
        data = resp.json()
        assert "calendar:write" in data["message"]
        assert "email:write" in data["message"]

    def test_scope_check_without_token(self) -> None:
        grantex = GrantexAuth(jwks_uri=JWKS_URI)
        app = _make_app(grantex, scopes=("calendar:read",))
        client = TestClient(app)

        resp = client.get("/api/test")

        assert resp.status_code == 401
        assert resp.json()["error"] == "TOKEN_MISSING"


# ─── require_scopes standalone ───────────────────────────────────────────────


class TestRequireScopes:
    def test_passes_when_scopes_present(self) -> None:
        require_scopes(MOCK_GRANT, "calendar:read")

    def test_passes_for_multiple_present_scopes(self) -> None:
        require_scopes(MOCK_GRANT, "calendar:read", "email:read")

    def test_raises_for_missing_scope(self) -> None:
        with pytest.raises(GrantexFastAPIError) as exc_info:
            require_scopes(MOCK_GRANT, "calendar:write")
        assert exc_info.value.code == "SCOPE_INSUFFICIENT"
        assert exc_info.value.status_code == 403

    def test_raises_with_all_missing_scopes_listed(self) -> None:
        with pytest.raises(GrantexFastAPIError) as exc_info:
            require_scopes(MOCK_GRANT, "calendar:write", "email:write")
        msg = str(exc_info.value)
        assert "calendar:write" in msg
        assert "email:write" in msg


# ─── GrantexFastAPIError ─────────────────────────────────────────────────────


class TestError:
    def test_properties(self) -> None:
        err = GrantexFastAPIError("TOKEN_INVALID", "bad token", 401)
        assert err.code == "TOKEN_INVALID"
        assert err.status_code == 401
        assert str(err) == "bad token"
        assert isinstance(err, Exception)

    def test_exception_handler_returns_json(self) -> None:
        app = FastAPI()
        app.add_exception_handler(GrantexFastAPIError, grantex_exception_handler)  # type: ignore[arg-type]

        @app.get("/err")
        async def err_route() -> None:
            raise GrantexFastAPIError("TOKEN_EXPIRED", "Token expired", 401)

        client = TestClient(app)
        resp = client.get("/err")
        assert resp.status_code == 401
        assert resp.json() == {"error": "TOKEN_EXPIRED", "message": "Token expired"}
