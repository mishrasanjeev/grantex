# Grant token profile 0.6

Status: draft for Grantex 0.6. Example:
[`examples/grant-token-0.6.json`](examples/grant-token-0.6.json). The auth
service's tests issue that exact payload, and the Python, TypeScript and Go
SDK tests verify it with stock JOSE libraries.

A grant token is a JWT access token as profiled by RFC 9068. It can be
validated by any OAuth or JOSE library using only standard semantics: an
explicit algorithm allowlist, issuer, audience, expiry, and the standard
`scope`, `client_id`, `cnf`, `act` and `authorization_details` claims.
Grantex-specific record fields are carried under a collision-resistant claim
name, and the pre-0.6 short claim names remain as aliases behind a
compatibility flag for one minor version.

## Header

```json
{"alg": "ES256", "kid": "grantex-es256-0000000000000000", "typ": "at+jwt"}
```

| Member | Value |
|---|---|
| `alg` | `RS256` (RSA, at least 2048 bits) or `ES256` (ECDSA P-256). One per deployment, `RS256` by default. |
| `kid` | The signing key in the issuer's JWK Set. Every key there carries `kid`, `alg` and `use: "sig"`. |
| `typ` | `at+jwt` |

## Payload

```json
{
  "iss": "https://auth.example.com",
  "sub": "user_01EXAMPLEPRINCIPAL",
  "aud": "https://agents.example.com",
  "exp": 1760000000,
  "iat": 1759996400,
  "jti": "tok_01EXAMPLETOKEN",
  "client_id": "ag_01UNDERWRITER",
  "scope": "tool:acme_kyb:read tool:acme_kyb:write",
  "cnf": {"jkt": "NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs"},
  "act": {"sub": "did:grantex:ag_01ORCHESTRATOR", "act": {"sub": "did:grantex:ag_01INTAKE"}},
  "authorization_details": [
    {
      "type": "urn:grantex:tools:v1",
      "connector": "acme_kyb",
      "purpose": "aml.cdd.onboarding",
      "data_region": "eu",
      "tools": ["resolve_business", "verify_business", "case_decision", "screen_*"],
      "caps": {"verify_business": {"per_hour": 50, "per_case": 3}, "cost_units": {"per_day": 5000}}
    },
    {
      "type": "urn:grantex:decision:v1",
      "connector": "acme_kyb",
      "tools": ["case_decision"],
      "four_eyes_on": {"case_decision": ["decline"]}
    }
  ],
  "urn:grantex:grant": {
    "grant_id": "grnt_01EXAMPLECHILD",
    "agent_did": "did:grantex:ag_01UNDERWRITER",
    "developer_id": "dev_01EXAMPLE",
    "parent_grant_id": "grnt_01EXAMPLEPARENT",
    "delegation_depth": 2
  }
}
```

### Standard claims

| Claim | Defined by | Present | Meaning |
|---|---|---|---|
| `iss` | RFC 7519 | always | The authorization server (`JWT_ISSUER`). |
| `sub` | RFC 7519 | always | The principal who approved the grant. |
| `aud` | RFC 7519 | when the grant is bound to a resource | The resource the token is for. Request an audience; resource servers should require one. |
| `exp`, `iat` | RFC 7519 | always | Expiry and issue time, seconds since the epoch. |
| `jti` | RFC 7519 | always | Token identifier, used for revocation and replay detection. |
| `client_id` | RFC 9068 / RFC 8693 | always for issued grant tokens | The agent's client identifier. |
| `scope` | RFC 9068 / RFC 8693 | always | Granted scopes, space-delimited. A scope never contains whitespace; issuance refuses one that does. |
| `cnf` | RFC 7800 / RFC 9449 | when the agent's key is bound | `jkt` is the RFC 7638 SHA-256 thumbprint of the key that must prove possession (DPoP). |
| `act` | RFC 8693 | delegated grants | The actor chain (below). |
| `authorization_details` | RFC 9396 | when the grant has any | Purpose, tools, caps, budget and decision references (below). |

### `act`: delegation chain

`act.sub` is the agent that delegated to this token's client. Each nested
`act` is the actor one hop further up the chain, so the outermost member is
the most recent delegator and the innermost the first. A root grant has no
`act`. A chain is at most 10 members deep, the delegation hard cap (SPEC §9).
The delegation endpoint stores the chain on the grant, so a refreshed token
carries the same chain. OAuth token exchange preserves the subject token's
`act` without adding an actor.

### `authorization_details` entry types

| `type` | Members | Meaning |
|---|---|---|
| `urn:grantex:tools:v1` | `connector`, `purpose`, `data_region`, `tools`, `caps` | One per connector. Purpose binding (purpose-bound grants), the tools the grant may call (names or prefixes ending in `*`) and per-grant caps including a `cost_units` budget (caps and metering). |
| `urn:grantex:decision:v1` | `connector`, `tools`, `four_eyes_on` | One per connector. The tools that need a decision grant before they run, and for each tool the decisions that need two approvers. `enforce()` returns `decision_required` for a listed tool whether or not the manifest declares `requires_decision`. A delegated grant keeps the entry for every connector it keeps. |
| `urn:grantex:params:oauth:authorization-details:budget` | `amount`, `currency` | The grant's remaining budget at issuance. |

Readers ignore entry types they do not know. An entry of a known type with an
unknown member, a value of the wrong type, or a second entry for the same
connector makes the claim unreadable, and `enforce()` denies every call with
`token_invalid` / `malformed_authorization_details`.

### `urn:grantex:grant`

Grantex's grant record fields, under a collision-resistant name (RFC 7519
§4.2). They are not needed to validate the token.

| Member | Present | Meaning |
|---|---|---|
| `grant_id` | always for issued grant tokens | The grant record, for revocation lookups. Readers fall back to `jti` when absent. |
| `agent_did` | always | The agent's DID. |
| `developer_id` | always | The developer organisation. |
| `parent_grant_id` | delegated grants | The grant this one was delegated from. |
| `delegation_depth` | delegated grants | Hops from the root grant (1 for a first delegation). |

## Legacy claim aliases

Before 0.6 these short names were the only form. While
`GRANT_TOKEN_LEGACY_CLAIMS=true` — the default for 0.6 — the auth service
issues them next to the standard claims, with identical values. The default
becomes `false` in 0.7, and a later release removes the flag.

| Alias | Standard claim |
|---|---|
| `agt` | `urn:grantex:grant.agent_did` |
| `dev` | `urn:grantex:grant.developer_id` |
| `grnt` | `urn:grantex:grant.grant_id` |
| `scp` | `scope` (as an array) |
| `parentAgt` | `act.sub` |
| `parentGrnt` | `urn:grantex:grant.parent_grant_id` |
| `delegationDepth` | `urn:grantex:grant.delegation_depth` |
| `bdg` | the `urn:grantex:params:oauth:authorization-details:budget` entry |

The SDK verifiers read the standard claim first. With their compatibility
option on (`legacy_claims` / `legacyClaims`, default `true` in 0.6;
`StandardClaimsOnly` in Go, default `false`), they read an alias only when
the standard claim is absent. Each alias used this way is reported:

- Python: a `LegacyClaimsWarning` (a `FutureWarning`).
- TypeScript: a `DeprecationWarning` with code `GRANTEX_LEGACY_CLAIM`.
- Go: `OnLegacyClaim`, or a log line once per alias.

The aliases used are also listed in `VerifiedGrant.legacy_claims_used` /
`legacyClaimsUsed` / `LegacyClaimsUsed`. A token whose standard claim and
alias disagree is refused. With the option off, aliases are ignored and the
token must have `typ: at+jwt`.

## Validation

A resource server validating a grant token MUST:

1. Accept only `RS256` and `ES256`, and use the JWK Set key named by `kid`
   whose key type matches the algorithm (RSA for RS256, EC P-256 for ES256)
   and whose `alg`, when present, equals the token's `alg`. `none`, HMAC
   algorithms, an unknown `kid` and a key of the other type are rejected.
2. Check `typ` is `at+jwt`, `iss` is the configured issuer, and `exp` and
   `iat`.
3. Check `aud` against its own identifier when it has one.
4. Compare required scopes against `scope` split on spaces, exactly.
5. When `cnf.jkt` is present, verify proof of possession of that key (RFC 9449).
6. Apply `authorization_details`: the tools entry's purpose, tools and caps,
   and the decision references.
7. Check revocation online when its risk model requires it (SPEC §7).

With a stock library that is, for example:

```ts
import { createRemoteJWKSet, jwtVerify } from 'jose';

const { payload } = await jwtVerify(token, createRemoteJWKSet(new URL('https://auth.example.com/.well-known/jwks.json')), {
  issuer: 'https://auth.example.com',
  audience: 'https://agents.example.com',
  algorithms: ['RS256', 'ES256'],
  typ: 'at+jwt',
  requiredClaims: ['iss', 'sub', 'aud', 'exp', 'iat', 'jti', 'client_id', 'scope'],
});
const scopes = (payload.scope as string).split(' ');
```

```python
import jwt

jwks = jwt.PyJWKClient("https://auth.example.com/.well-known/jwks.json")
payload = jwt.decode(
    token,
    jwks.get_signing_key_from_jwt(token).key,
    algorithms=["RS256", "ES256"],
    issuer="https://auth.example.com",
    audience="https://agents.example.com",
    options={"require": ["iss", "sub", "aud", "exp", "iat", "jti"]},
)
assert jwt.get_unverified_header(token)["typ"] == "at+jwt"
scopes = payload["scope"].split(" ")
```

These are the checks in
`apps/auth-service/tests/grant-token-standard-claims.test.ts`,
`packages/sdk-ts/tests/standard-claims.test.ts` and
`packages/sdk-py/tests/test_standard_claims.py`.
