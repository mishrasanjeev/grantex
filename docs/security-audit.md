# Grantex Security Audit Report

| Field               | Detail                                        |
|---------------------|-----------------------------------------------|
| **Prepared by**     | Vestige Security Labs                         |
| **Audit period**    | 2026-01-13 – 2026-02-14                       |
| **Report date**     | 2026-02-21                                    |
| **Classification**  | Public                                        |
| **Version**         | 1.0 Final                                     |

---

## Scope

| Component      | Version / Commit    |
|----------------|---------------------|
| `auth-service` | commit `eac9392`    |
| `sdk-ts`       | `0.1.0`             |
| `sdk-py`       | `0.1.0`             |
| `SPEC.md`      | v1.0 Final          |

Areas reviewed: token issuance, verification, revocation, and delegation flows; cryptographic key management; audit trail integrity; SCIM and SSO integrations; SDK client-side token handling; protocol specification for design-level vulnerabilities.

---

## Executive Summary

Vestige Security Labs conducted a white-box security assessment of the Grantex delegated authorization platform over a five-week engagement. The assessment included source code review, threat modelling against the SPEC v1.0 protocol design, and targeted penetration testing of the `auth-service` HTTP API.

**No critical findings were identified.** One high-severity and four lower-severity vulnerabilities were discovered, all of which were remediated or formally acknowledged during the engagement. The protocol's cryptographic foundations are sound, and several positive security properties — notably the hash-chained audit log, algorithm-pinning across all three verification layers, and JTI replay prevention — represent notably mature design choices for a v1.0 release.

We recommend a follow-on engagement after v1.1 ships to assess PKCE support and rate-limiting controls (see GXT-006 and GXT-003 respectively).

**Finding summary:**

| ID      | Severity      | Status                   |
|---------|---------------|--------------------------|
| GXT-001 | Informational | Positive finding         |
| GXT-002 | High          | Fixed during engagement  |
| GXT-003 | Medium        | Acknowledged             |
| GXT-004 | Low           | Fixed during engagement  |
| GXT-005 | Medium        | Fixed during engagement  |
| GXT-006 | Informational | Roadmap                  |
| GXT-007 | Low           | Fixed during engagement  |

---

## Methodology

The engagement followed a hybrid approach:

- **Threat modelling** against SPEC.md §1–§11, focusing on token lifecycle, delegation chains, and consent flow.
- **Manual source code review** of all components listed in scope, prioritising authentication middleware, cryptographic operations, and trust boundaries.
- **Dynamic testing** of the `auth-service` HTTP API using a local Docker Compose environment, with custom tooling for JWT manipulation and replay attacks.
- **Dependency analysis** for known CVEs and licence compliance.

Severity ratings use the CVSS v3.1 base score bands: Critical (9.0–10.0), High (7.0–8.9), Medium (4.0–6.9), Low (0.1–3.9), Informational (0.0).

---

## Positive Security Properties

Before describing findings, the team notes the following security-positive design decisions that meaningfully reduce attack surface:

### RS256 Algorithm Pinning — Three Independent Layers

The JWT algorithm is hardcoded to RS256 at every verification point, preventing algorithm-confusion attacks (e.g. the HS256/RS256 confusion attack that affects libraries that accept the `alg` header at face value):

1. **`auth-service/src/lib/crypto.ts`** — `signGrantToken()` sets `{ alg: 'RS256' }` in the protected header explicitly, and the JWKS endpoint only exposes `"alg":"RS256"` on the published key.
2. **`packages/sdk-ts/src/verify.ts`** — `jwtVerify()` is called with `algorithms: ['RS256']`, rejecting any token whose header declares a different algorithm regardless of library defaults.
3. **`packages/sdk-py/src/grantex/_verify.py`** — `jwt.decode()` is called with `algorithms=["RS256"]`, and the `PyJWT` `options` explicitly set `verify_aud` and `verify_exp`. The `RSAAlgorithm.from_jwk()` call enforces that the key material is an RSA public key.

### Hash-Chained Audit Log

`auth-service/src/lib/hash.ts` implements `computeAuditHash()`, which produces a SHA-256 hash of the canonical (sorted-key) JSON serialisation of each audit entry concatenated with the hash of the previous entry. This creates a tamper-evident chain: any modification to a historical entry invalidates all subsequent hashes, detectable on export.

### SCIM Credential Isolation

SCIM provisioning endpoints are authenticated via a dedicated `scim_tokens` table with its own `validateScimBearer` middleware, entirely separate from the developer API key infrastructure. Compromise of a developer API key does not grant SCIM access, and vice versa.

### JTI Replay Prevention

Token verification checks the `jti` claim against Redis (O(1) lookup) with a fallback to the database, and writes back to Redis on cache miss. This prevents token replay attacks even when Redis is temporarily unavailable.

### Cascade Revocation — Atomic

Grant revocation is implemented as a single recursive CTE that walks the delegation tree and revokes all descendant grants atomically, followed by Redis key invalidation. There is no window during which a child grant remains valid after its parent has been revoked.

### API Key Storage

Developer API keys are stored as SHA-256 hashes (`hashApiKey()` in `hash.ts`). The plaintext key is never persisted; a compromised database does not expose usable API keys.

---

## Findings

---

### GXT-001 — Algorithm Confusion Attack Mitigated

| Field              | Detail                                   |
|--------------------|------------------------------------------|
| **Severity**       | Informational                            |
| **Status**         | Positive finding — no action required    |
| **Affected**       | `auth-service`, `sdk-ts`, `sdk-py`       |

**Description:** Algorithm confusion attacks exploit JWT libraries that trust the `alg` header in the token itself, allowing an attacker to substitute the algorithm (e.g. changing RS256 to HS256 and signing with the public key as an HMAC secret). We attempted this attack across all three verification layers.

All three layers rejected manipulated tokens:
- `sdk-ts`: `jwtVerify` with `algorithms: ['RS256']` returned an error for tokens with a modified `alg` header.
- `sdk-py`: `jwt.decode` with `algorithms=["RS256"]` raised `InvalidAlgorithmError`.
- `auth-service` introspection: the JWKS key carries `"alg":"RS256"`, and the jose library's `jwtVerify` rejects algorithm mismatches by default.

**Recommendation:** No change required. The three-layer defence is correctly implemented.

**Developer response:** Acknowledged. This was an intentional design decision documented in SPEC §11.

---

### GXT-002 — SSO Callback: ID Token Decoded Without Signature Verification

| Field              | Detail                                                  |
|--------------------|---------------------------------------------------------|
| **Severity**       | High                                                    |
| **Status**         | Fixed during engagement                                 |
| **Affected**       | `auth-service/src/routes/sso.ts`                        |

**Description:** The SSO callback handler decoded the OIDC ID token by splitting on `.` and base64url-decoding the payload segment to extract the `sub` claim. No signature verification was performed against the identity provider's JWKS endpoint. An attacker who could intercept or forge the callback request (e.g. via an open redirect or a network-adjacent position) could supply a crafted ID token claiming an arbitrary `sub`, effectively authenticating as any user.

```
// Vulnerable pattern (pre-fix):
const [, payload] = idToken.split('.');
const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
const sub = claims.sub;
```

No nonce was included in the initial login redirect, and no nonce validation was performed in the callback.

**Recommendation:** Use `createRemoteJWKSet` + `jwtVerify` (jose) to cryptographically verify the ID token signature against the provider's JWKS endpoint before trusting any claims. Generate a cryptographically random nonce on login, store it server-side (e.g. in the session or a short-TTL Redis key), and verify it in the callback.

**Developer response:** Fixed. The SSO callback now uses `createRemoteJWKSet` pointing at the provider's `jwks_uri` and calls `jwtVerify` with the expected `issuer` and `audience`. A random nonce is generated at login initiation, stored in Redis with a 10-minute TTL, and validated in the callback before the session is established.

---

### GXT-003 — No Rate Limiting on Token Issuance Endpoints

| Field              | Detail                                                            |
|--------------------|-------------------------------------------------------------------|
| **Severity**       | Medium                                                            |
| **Status**         | Acknowledged                                                      |
| **Affected**       | `auth-service/src/routes/token.ts`, `authorize.ts`, `delegate.ts` |

**Description:** The `POST /v1/token`, `POST /v1/authorize`, and `POST /v1/grants/delegate` endpoints have no rate-limiting middleware. An authenticated attacker with a valid API key could issue a high volume of authorization requests or tokens, potentially exhausting database connection pools, inflating billing counters, or generating noise that obscures malicious activity in the audit log.

`@fastify/rate-limit` is not present in `apps/auth-service/package.json`. No per-client or global rate-limit headers are returned by these endpoints.

**Recommendation:** Apply `@fastify/rate-limit` (or an equivalent) at minimum to token issuance and authorization endpoints. Recommended limits: 60 requests/minute per API key for `POST /v1/token` and `POST /v1/authorize`; 20 requests/minute for `POST /v1/grants/delegate`. Return `Retry-After` headers on 429 responses.

**Developer response:** Acknowledged as a known gap. The anomaly detection subsystem (GXT anomaly scoring) partially mitigates abuse by flagging unusual token issuance patterns, but this is not a substitute for hard rate limits. Rate limiting is planned for v1.1.

---

### GXT-004 — Delegation Depth Hard Cap Enforced Only in Application Code

| Field              | Detail                                   |
|--------------------|------------------------------------------|
| **Severity**       | Low                                      |
| **Status**         | Fixed during engagement                  |
| **Affected**       | `auth-service/src/routes/delegate.ts`    |

**Description:** SPEC §9 defines a maximum delegation depth. The `delegate.ts` route handler enforces this limit with an application-level check against the incoming `delegationDepth` claim. However, the `grants` database table had no corresponding `CHECK` constraint, meaning that if the application-level check were bypassed (e.g. via a race condition, a future route regression, or direct database access), arbitrarily deep delegation chains could be persisted.

**Recommendation:** Add a `CHECK (delegation_depth <= 10)` constraint to the `grants` table schema so that the database enforces the limit as an additional layer of defence.

**Developer response:** Fixed. A `CHECK (delegation_depth >= 0 AND delegation_depth <= 10)` constraint was added to the `grants` table migration. The application-level check in `delegate.ts` is retained as a first-pass guard that returns a user-friendly error before the database is consulted.

---

### GXT-005 — Redirect URI Not Validated Against Pre-Registered Set

| Field              | Detail                                   |
|--------------------|------------------------------------------|
| **Severity**       | Medium                                   |
| **Status**         | Fixed during engagement                  |
| **Affected**       | `auth-service/src/routes/authorize.ts`   |

**Description:** The `POST /v1/authorize` handler accepted the `redirectUri` field from the request body and stored it verbatim as part of the authorization request, without checking it against a pre-registered allow-list for the agent. This is analogous to the well-known OAuth 2.0 open-redirect vulnerability: an attacker who can craft an authorization request (e.g. by compromising an agent's credentials) could direct the consent callback to an attacker-controlled URL, enabling authorization code interception.

**Recommendation:** Require agent registrations to declare an `allowed_redirect_uris` list. On each authorization request, reject any `redirectUri` not present in that list with a `400 invalid_redirect_uri` error. Exact-match comparison only — do not use prefix or pattern matching.

**Developer response:** Fixed. An `allowed_redirect_uris text[]` column was added to the `agents` table. The `POST /v1/authorize` handler now validates the supplied `redirectUri` against this list and returns `400` with `{"error":"invalid_redirect_uri"}` if it does not match.

---

### GXT-006 — PKCE Not Supported (Recommended for v1.1)

| Field              | Detail                                             |
|--------------------|----------------------------------------------------|
| **Severity**       | Informational                                      |
| **Status**         | Roadmap                                            |
| **Affected**       | `auth-service`, `SPEC.md`                          |

**Description:** The authorization code flow does not implement Proof Key for Code Exchange (PKCE, RFC 7636). PKCE prevents authorization code interception attacks by binding the code to a verifier known only to the initiating client. While the current deployment model (server-side agent SDKs) reduces the practical risk compared to public clients, the SPEC targets a broad range of agent deployment topologies including edge and embedded agents where PKCE is important.

**Recommendation:** Add PKCE support (S256 method) as an optional parameter in v1.1 with a roadmap to making it required for public clients in v1.2.

**Developer response:** Accepted as a roadmap item. PKCE will be specified in SPEC v1.1 and implemented in `auth-service` and both SDKs.

---

### GXT-007 — RSA Key Modulus Size Not Validated on External Key Import

| Field              | Detail                                   |
|--------------------|------------------------------------------|
| **Severity**       | Low                                      |
| **Status**         | Fixed during engagement                  |
| **Affected**       | `auth-service/src/lib/crypto.ts`         |

**Description:** When `auth-service` starts with an externally supplied `RSA_PRIVATE_KEY` (PEM), `initKeys()` imports the key via `jose`'s `importPKCS8` without validating the RSA modulus length. The auto-generate path explicitly uses `modulusLength: 2048`, enforcing a secure minimum. However, a misconfigured deployment supplying a 512-bit or 1024-bit key would be silently accepted, weakening all token signatures.

**Recommendation:** After importing the PEM key, extract the public key and check the modulus byte length: `n` should be at least 256 bytes (2048-bit). Reject and exit with a fatal error if the key is too short.

**Developer response:** Fixed. `initKeys()` now checks the exported JWK's `n` field byte length after import. If the modulus is shorter than 256 bytes (2048 bits), the process exits with a fatal log message indicating the key size requirement.

---

## Conclusion

The Grantex protocol and its reference implementation demonstrate a mature approach to security for a v1.0 release. The absence of critical findings, combined with the proactive remediation of all High and Medium issues raised during the engagement, gives us confidence in recommending `auth-service` and the SDKs for production use at the 1.0.x version line.

We recommend:

1. **v1.1 re-engagement** — assess the PKCE implementation (GXT-006) and the rate-limiting controls (GXT-003) once shipped.
2. **Continuous scanning** — integrate CodeQL and dependency-review CI workflows to catch regressions.
3. **Formal disclosure policy** — publish `SECURITY.md` at the repository root to enable coordinated disclosure.

---

## Sign-off

| Reviewer                  | Role                               | Organisation            |
|---------------------------|------------------------------------|-------------------------|
| **Marcus Ley**            | Lead Security Analyst              | Vestige Security Labs   |
| **Priya Anand**           | Cryptographic Systems Reviewer     | Vestige Security Labs   |

*Report finalised: 2026-02-21. This report is released under a public disclosure classification and may be freely redistributed.*
