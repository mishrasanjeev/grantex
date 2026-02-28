# grantex-fastapi

FastAPI dependency injection for [Grantex](https://grantex.dev) grant token verification and scope-based authorization.

Verify Grantex JWTs and enforce scopes on any FastAPI route with a single `Depends()`.

## Install

```bash
pip install grantex-fastapi
```

## Quick Start

```python
from fastapi import Depends, FastAPI
from grantex import VerifiedGrant
from grantex_fastapi import GrantexAuth, GrantexFastAPIError, grantex_exception_handler

app = FastAPI()
app.add_exception_handler(GrantexFastAPIError, grantex_exception_handler)

JWKS_URI = "https://grantex-auth-dd4mtrt2gq-uc.a.run.app/.well-known/jwks.json"
grantex = GrantexAuth(jwks_uri=JWKS_URI)

# Verify token — grant is injected automatically
@app.get("/api/calendar")
async def calendar(grant: VerifiedGrant = Depends(grantex.scopes("calendar:read"))):
    return {"principalId": grant.principal_id, "scopes": list(grant.scopes)}
```

## How It Works

`GrantexAuth` is a callable class that acts as a FastAPI dependency:

1. Extracts the Bearer token from the `Authorization` header
2. Verifies the RS256 signature against the Grantex JWKS endpoint
3. Returns a typed `VerifiedGrant` object with principal, agent, scopes, and timestamps
4. The `.scopes()` method adds scope enforcement on top

## Token Verification Only

Use `Depends(grantex)` to verify the token without checking scopes:

```python
@app.get("/api/me")
async def me(grant: VerifiedGrant = Depends(grantex)):
    return {"principalId": grant.principal_id, "agentDid": grant.agent_did}
```

## Scope Enforcement

Use `Depends(grantex.scopes(...))` to verify the token AND check scopes:

```python
# Single scope
@app.get("/api/calendar")
async def calendar(grant: VerifiedGrant = Depends(grantex.scopes("calendar:read"))):
    ...

# Multiple scopes — all required
@app.post("/api/email/send")
async def send_email(grant: VerifiedGrant = Depends(grantex.scopes("email:read", "email:send"))):
    ...
```

Or check scopes inside the handler:

```python
from grantex_fastapi import require_scopes

@app.get("/api/data")
async def data(grant: VerifiedGrant = Depends(grantex)):
    require_scopes(grant, "data:read")
    ...
```

## Custom Token Extraction

```python
from fastapi import Request

def extract_from_cookie(request: Request) -> str | None:
    return request.cookies.get("grant_token")

grantex = GrantexAuth(jwks_uri=JWKS_URI, token_extractor=extract_from_cookie)
```

## Custom Error Handling

Register the built-in exception handler for JSON error responses:

```python
app.add_exception_handler(GrantexFastAPIError, grantex_exception_handler)
```

Or write your own:

```python
from fastapi import Request
from fastapi.responses import JSONResponse
from grantex_fastapi import GrantexFastAPIError

@app.exception_handler(GrantexFastAPIError)
async def custom_handler(request: Request, exc: GrantexFastAPIError) -> JSONResponse:
    if exc.code == "TOKEN_EXPIRED":
        return JSONResponse(status_code=401, content={"error": "Session expired"})
    return JSONResponse(status_code=exc.status_code, content={"error": exc.code})
```

## Error Codes

| Code | Status | Meaning |
|------|--------|---------|
| `TOKEN_MISSING` | 401 | No token found in request |
| `TOKEN_INVALID` | 401 | Token signature or format is invalid |
| `TOKEN_EXPIRED` | 401 | Token has expired |
| `SCOPE_INSUFFICIENT` | 403 | Token lacks required scopes |

## `grant` Object

The `VerifiedGrant` dataclass contains:

| Field | Type | Description |
|-------|------|-------------|
| `token_id` | `str` | JWT `jti` claim |
| `grant_id` | `str` | Grant record ID |
| `principal_id` | `str` | End-user who authorized the agent |
| `agent_did` | `str` | Agent's DID |
| `developer_id` | `str` | Developer org ID |
| `scopes` | `tuple[str, ...]` | Granted scopes |
| `issued_at` | `int` | Token issued-at (epoch seconds) |
| `expires_at` | `int` | Token expiry (epoch seconds) |

## Requirements

- Python 3.9+
- FastAPI >= 0.100.0
- `grantex` >= 0.1.0

## License

Apache-2.0
