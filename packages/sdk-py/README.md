# grantex

Python SDK for the [Grantex](https://grantex.dev) delegated authorization protocol — OAuth 2.0 for AI agents.

Grantex lets humans authorize AI agents with **verifiable, revocable, audited grants** built on JWT and the OAuth 2.0 model. This SDK provides a complete client for the Grantex API.

[![PyPI](https://img.shields.io/pypi/v/grantex)](https://pypi.org/project/grantex/)
[![Python](https://img.shields.io/pypi/pyversions/grantex)](https://pypi.org/project/grantex/)
[![License](https://img.shields.io/pypi/l/grantex)](https://github.com/mishrasanjeev/grantex/blob/main/LICENSE)

## Install

```bash
pip install grantex
```

## Quick start

```python
from grantex import Grantex, ExchangeTokenParams, verify_grant_token, VerifyGrantTokenOptions

client = Grantex(api_key="YOUR_API_KEY")

# 1. Start the authorization flow
request = client.authorize(
    agent_id="ag_01HXYZ...",
    user_id="usr_01HXYZ...",
    scopes=["files:read", "email:send"],
)

# Redirect the user to the consent page — they approve in plain language
print(request.consent_url)

# 2. Exchange the authorization code for a grant token
# (your redirect callback receives the `code` after user approves)
token = client.tokens.exchange(ExchangeTokenParams(code=code, agent_id="ag_01HXYZ..."))
print(token.grant_token)  # RS256-signed JWT
print(token.scopes)       # ('files:read', 'email:send')

# 3. Verify the grant token offline (no network call)
grant = verify_grant_token(
    token=token.grant_token,
    options=VerifyGrantTokenOptions(
        jwks_uri="https://api.grantex.dev/.well-known/jwks.json",
    ),
)
print(grant.principal_id)  # 'usr_01HXYZ...'

# 4. Revoke when done
client.tokens.revoke(grant.token_id)
```

## Offline verification

Verify grant tokens without a network call using the public JWKS:

```python
from grantex import verify_grant_token

verified = verify_grant_token(
    token="eyJhbGciOiJSUzI1NiIs...",
    jwks_url="https://api.grantex.dev/.well-known/jwks.json",
)

print(verified.scopes)       # ['files:read', 'email:send']
print(verified.principal_id) # 'usr_01HXYZ...'
print(verified.agent_did)    # 'did:web:...'
```

## Features

| Feature | Description |
|---|---|
| **Authorization flow** | `client.authorize()` — initiate consent, get grant tokens |
| **Token exchange** | `client.tokens.exchange()` — exchange an authorization code for a grant token |
| **Token management** | `client.tokens.verify()`, `.revoke()` — online verification and revocation |
| **Offline verification** | `verify_grant_token()` — RS256 signature check against JWKS |
| **Agent management** | `client.agents.create()`, `.get()`, `.list()`, `.update()`, `.delete()` |
| **Grant management** | `client.grants.list()`, `.get()`, `.revoke()` |
| **Multi-agent delegation** | `client.grants.delegate()` — scoped sub-grants with cascade revocation |
| **Audit trail** | `client.audit.log()`, `.list()`, `.get()` — tamper-evident hash-chained log |
| **Policy engine** | `client.policies.create()`, `.list()`, `.update()`, `.delete()` |
| **Anomaly detection** | `client.anomalies.list()`, `.detect()` |
| **Compliance** | `client.compliance.summary()`, `.export_audit()`, `.export_grants()`, `.evidence_pack()` |
| **Webhooks** | `client.webhooks.create()`, `.list()`, `.delete()` + `verify_webhook_signature()` |
| **Billing** | `client.billing.status()`, `.checkout()`, `.portal()` |
| **SCIM 2.0** | `client.scim.create_user()`, `.list_users()`, `.get_user()`, `.update_user()`, `.delete_user()` |
| **OIDC SSO** | `client.sso.create_config()`, `.get_config()`, `.login()`, `.callback()` |

## Configuration

```python
from grantex import Grantex

# Explicit API key
client = Grantex(api_key="gx_live_...")

# Or via environment variable
# export GRANTEX_API_KEY=gx_live_...
client = Grantex()

# Custom base URL (self-hosted)
client = Grantex(
    api_key="gx_live_...",
    base_url="https://auth.your-company.com",
)

# Custom timeout (seconds)
client = Grantex(api_key="gx_live_...", timeout=60.0)
```

The client also works as a context manager:

```python
with Grantex(api_key="gx_live_...") as client:
    agents = client.agents.list()
```

## Error handling

```python
from grantex import Grantex, GrantexApiError, GrantexAuthError, GrantexNetworkError

client = Grantex(api_key="gx_live_...")

try:
    client.agents.get("ag_invalid")
except GrantexAuthError:
    # 401 — invalid or expired API key
    pass
except GrantexApiError as e:
    # Any other API error (4xx/5xx)
    print(e.status_code, e.code, e.message)
except GrantexNetworkError:
    # Connection failure, timeout, DNS error
    pass
```

## Requirements

- Python 3.9+
- [httpx](https://www.python-httpx.org/) (sync HTTP client)
- [PyJWT](https://pyjwt.readthedocs.io/) + [cryptography](https://cryptography.io/) (for offline token verification)

## Links

- [Documentation](https://github.com/mishrasanjeev/grantex)
- [Protocol specification](https://github.com/mishrasanjeev/grantex/blob/main/SPEC.md)
- [TypeScript SDK](https://www.npmjs.com/package/@grantex/sdk)
- [IETF Internet-Draft](https://datatracker.ietf.org/doc/draft-mishra-oauth-agent-grants/)
- [Landing page](https://grantex.dev)

## License

Apache 2.0
