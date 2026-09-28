# Changelog

## 4.0.0

### Breaking
- Authorization requires `resolvePrincipal`, derived from a verified host session.
  The OAuth client ID is no longer the human by default. An explicit
  `allowLegacyClientPrincipal: true` migration opt-out warns and is evaluation-only.
- Resource guards and Express/Hono middleware require `currentGrant`, in addition
  to `revocations`. Use `grantexCurrentGrantVerifier(grantex)` for issuer-side
  online authority checks. `currentGrant: 'none'` is a warned evaluation opt-out.
- Pending authorizations, codes and refresh bindings without principal bindings
  require reauthorization. Drain old requests before upgrading all replicas;
  do not mix v3 and v4 replicas against the same state namespace.
- `TokenIssuedEvent.agentDid` is optional when upstream tokens do not carry it.

### Security and consent
- Bind the authenticated human at authorization, approval and upstream callback.
  Logout, account switching, missing sessions and identity-service failures refuse
  issuance. Bind token exchange and refresh to the upstream principal subject.
- Refuse changed purpose/duration and hidden duration overrides after consent.
- Consult current upstream grant authority on every protected request; inactive
  grants return 401 and issuer outages return 503 without executing tools.
- Invoke `hooks.onTokenIssued` on successful exchange and refresh. A failed
  observability hook emits a fixed warning without breaking token delivery.
- Replace the package README's legacy v2 walkthrough with the current deployment
  contract. Historical v2 limitations remain in the dedicated archived guide.

## 3.0.0

- Durable Postgres/Redis state, rendered consent, browser/CSRF binding,
  PKCE/resource binding, tool/decision enforcement and explicit local revocation.
- Historical limitation: OAuth client ID was used as the upstream principal.

## 2.0.2

- Historical single-process evaluation release without a rendered consent page.
  It remains immutable; see the historical deployment guide.
