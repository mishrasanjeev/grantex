# Production Hardening Change README

Branch: `e2e-review-hardening`

This branch contains an end-to-end product hardening pass focused on functional correctness, production safety, and security controls before merging to `main` and promoting to production.

## What Changed

- Added outbound URL validation for SSO, OIDC discovery, JWKS fetches, LDAP, redirect URIs, and webhooks.
- Blocked embedded URL credentials, unsafe protocols, and private/loopback/link-local hosts by default in production.
- Required TLS certificate validation for LDAP by default.
- Required service-matching scopes before vault credentials can be exchanged and decrypted.
- Added audit events for vault credential store, exchange, and delete operations.
- Protected `/metrics` with a bearer token in production.
- Fixed the global CSP so API responses stay locked down while HTML consent/dashboard routes keep route-specific CSP headers.
- Escaped dashboard and principal UI values used in HTML and inline JavaScript.
- Hardened API key parsing with maximum length checks.
- Verified legacy OIDC callback ID tokens instead of accepting unsigned decoded payloads.
- Added SAML signature fail-closed behavior when signed payload structure is missing.
- Added rate limiting to SAML callback handling.
- Hardened production Docker build to use `npm ci`, a lockfile, `NODE_ENV=production`, and non-root runtime.
- Added production compose and nginx hardening for no-new-privileges, read-only auth container filesystem, proxy timeouts, body size limits, and security headers.

## New Production Environment Variables

Set these before deploying this branch:

```env
PUBLIC_BASE_URL=https://your-domain.example.com
VAULT_ENCRYPTION_KEY=<32-byte-hex-key>
ADMIN_API_KEY=<strong-random-admin-token>
METRICS_ENABLED=true
METRICS_REQUIRE_AUTH=true
METRICS_API_KEY=<strong-random-metrics-token>
SSO_ALLOW_INSECURE_URLS=false
SSO_ALLOW_PRIVATE_HOSTS=false
WEBHOOK_ALLOW_INSECURE_URLS=false
WEBHOOK_ALLOW_PRIVATE_HOSTS=false
LDAP_TLS_REJECT_UNAUTHORIZED=true
CORS_ALLOWED_ORIGINS=https://your-domain.example.com,https://portal.your-domain.example.com
```

`VAULT_ENCRYPTION_KEY`, `ADMIN_API_KEY`, and `METRICS_API_KEY` are now treated as production-critical settings.

## Operational Notes

- Private SSO IdPs or webhook targets now require an explicit environment override. Do not enable those flags unless the target is approved and network-isolated.
- Prometheus or any metrics collector must send `Authorization: Bearer <METRICS_API_KEY>` to `/metrics`.
- Grant tokens used for vault exchange must include a scope such as `github:read`, `github:credentials:read`, `vault:github:read`, or `vault:credentials:exchange`.
- The auth-service container runs as the `node` user with a read-only filesystem in production compose.

## Verification Checklist

- `apps/portal`: build and tests passed before backend hardening edits.
- `packages/sdk-ts`: typecheck and tests passed before backend hardening edits.
- `apps/auth-service`: `npm run typecheck` passed.
- `apps/auth-service`: `npm test` passed, 76 test files / 1010 tests.
- `apps/auth-service`: `npm run build` passed.
- Production compose parse check passed with `docker compose -f docker-compose.prod.yml --env-file .env.prod.example config`.
- Confirm production `.env.prod` contains the new variables above.
- Confirm metrics scraping has the new bearer token header.
- Confirm any private SSO or webhook endpoint has an explicit exception and a threat-model note.
