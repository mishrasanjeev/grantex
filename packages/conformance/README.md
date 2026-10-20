# @grantex/conformance

Conformance test suite for the [Grantex protocol](https://grantex.dev). Validates that a server implementation correctly implements the Grantex specification by running black-box HTTP tests against a live endpoint.

## Quick Start

```bash
npx @grantex/conformance --base-url http://localhost:3001 --api-key YOUR_API_KEY
```

## Installation

```bash
npm install -g @grantex/conformance
```

## Usage

```
grantex-conformance --base-url URL --api-key KEY [options]

Options:
  --base-url <url>       Base URL of the Grantex auth service (required)
  --api-key <key>        API key for authentication (required)
  --suite <name>         Run a specific suite only
  --include <ext,...>    Include optional extensions (comma-separated)
  --format <format>      Output format: text or json (default: text)
  --bail                 Stop on first failure
  --oacp-issuer <url>    Pinned OACP issuer identifier (default: the base URL)
  --oacp-tenant <id>     Commerce tenant the oacp suite issues under
                         (default: cten_CONFORMANCE)
  -h, --help             Display help
```

Secrets are read from the environment, never from arguments:
`GRANTEX_CONFORMANCE_INTERNAL_TOKEN` is the internal service token for the
`oacp` suite. `GRANTEX_CONFORMANCE_OACP_ISSUER` and
`GRANTEX_CONFORMANCE_OACP_TENANT` stand in for the two `--oacp-*` options.

### Run all core suites

```bash
grantex-conformance --base-url http://localhost:3001 --api-key sk_test_xxx
```

### Run a single suite

```bash
grantex-conformance --base-url http://localhost:3001 --api-key sk_test_xxx --suite health
```

### Include optional extensions

```bash
grantex-conformance --base-url http://localhost:3001 --api-key sk_test_xxx \
  --include policies,webhooks,scim
```

### JSON output

```bash
grantex-conformance --base-url http://localhost:3001 --api-key sk_test_xxx --format json
```

## Core Suites (40 tests)

| Suite | Tests | Description |
|-------|-------|-------------|
| `health` | 2 | Health check endpoint and JWKS key validation |
| `agents` | 5 | Agent registration, listing, retrieval, update, deletion |
| `authorize` | 4 | Authorization request creation and consent flow |
| `token` | 3 | Token exchange, invalid code rejection, code reuse prevention |
| `tokens` | 4 | Token verification, revocation, post-revoke verification |
| `grants` | 4 | Grant listing, retrieval, revocation, status validation |
| `delegation` | 5 | Grant delegation, JWT claims, scope enforcement, depth limits, cascade revocation |
| `audit` | 5 | Audit log creation, hash chain integrity, entry retrieval |
| `security` | 5 | Auth enforcement, JWKS algorithm, scope escalation prevention, audit immutability |
| `rate-limit-headers` | 3 | Rate limit header presence and format, JWKS endpoint exemption |

## Optional Extensions

| Suite | Tests | Description |
|-------|-------|-------------|
| `policies` | 5 | Policy CRUD operations |
| `webhooks` | 3 | Webhook registration and management |
| `scim` | 6 | SCIM 2.0 provisioning endpoints |
| `sso` | 4 | SSO configuration and flow |
| `anomalies` | 3 | Anomaly detection and acknowledgement |
| `compliance` | 4 | Compliance reporting and evidence export |
| `oacp` | 9 | OACP artifacts: issue, persist and replay, Token Status List, SDK verification, revoke, status flip, protocol adapter artifact |

### The `oacp` suite

> This is a source addition, not yet in a published release of this package.
> Check [release status](https://docs.grantex.dev/release-status) before relying on
> an installed version.

`--include oacp --suite oacp` runs the OACP artifact lifecycle (profile
`oacp-artifact-jws-v1`) against a live auth service:

1. **issue**: `POST /v1/commerce/oacp/c6z/authority-requests` with synthetic
   read-only connector evidence for a merchant and seller id unique to the run;
   every artifact must carry a detached ES256 JWS with the OACP header, the
   pinned `issuer`, and a `status.status_list` entry matching
   `revocation_status_url`;
2. **persist**: `GET /v1/commerce/oacp/artifacts/:artifactId` returns the
   issued envelope unchanged with status `issued`, and the replay
   `GET /v1/commerce/oacp/artifacts?tenant_id&merchant_id&seller_agent_id&limit`
   lists every issued artifact and nothing outside the scope;
3. **status list**: `GET /status/oacp/:list` is served as
   `application/statuslist+jwt`, verifies against `/.well-known/jwks.json`,
   and the entry is VALID;
4. **verify**: `verifyOacpArtifact()` from `@grantex/sdk` accepts every issued
   artifact (status list included) and refuses a tampered payload
   (`payload_hash_mismatch`) and a tampered envelope
   (`detached_jws_verification_failed`);
5. **revoke**: `POST /v1/commerce/oacp/artifacts/:artifactId/revoke`, after
   which the artifact reads back `revoked` with `revoked_at`; a returned
   `revocation_artifact` must be of type `revocation` and name the artifact;
6. **status flips**: the entry reads INVALID and the verifier refuses with
   `artifact_revoked`;
7. **adapter render**: the issued `protocol_adapter` artifact verifies and
   lists its adapter surfaces without allowing execution (skipped when the
   service issues none).

The suite needs `@grantex/sdk` with the OACP verifier installed beside the
CLI (an optional peer dependency, `>=0.9.0 <1`). Once both packages are
released with the suite and the verifier:

```bash
npm install @grantex/conformance @grantex/sdk
GRANTEX_CONFORMANCE_INTERNAL_TOKEN=... npx grantex-conformance \
  --base-url http://localhost:3001 --api-key sk_test_xxx \
  --include oacp --suite oacp --oacp-issuer https://issuer.example
```

Until then, build `packages/sdk-ts` and `packages/conformance` from this
repository, make the built SDK resolvable as `@grantex/sdk` from
`packages/conformance` (the in-tree SDK version is still below the peer
range, so `npm install ../sdk-ts` refuses to link it), and run
`node packages/conformance/dist/index.js` with the same options.

The internal token is the auth service's
`COMMERCE_C6Z_AUTHORITY_SERVICE_TOKEN` (or the token whose SHA-256 is
`COMMERCE_C6Z_AUTHORITY_SERVICE_TOKEN_SHA256`), and the tenant must be listed
in `COMMERCE_C6Z_AUTHORITY_SERVICE_TENANTS`; without the token the suite uses
the API key as an operator caller. `--oacp-issuer` must equal the service's
`JWT_ISSUER`. The suite accepts http status-list and JWKS URLs only on
loopback hosts. Running `--suite oacp` alone makes no agent calls.

## Programmatic API

```typescript
import { runConformanceTests } from '@grantex/conformance/runner';
import { reportJson } from '@grantex/conformance/reporter';

const report = await runConformanceTests({
  baseUrl: 'http://localhost:3001',
  apiKey: 'sk_test_xxx',
  format: 'json',
  bail: false,
});

console.log(reportJson(report));
```

## Server Requirements

- The server must implement the Grantex protocol endpoints
- An API key with sufficient permissions to create agents, authorize, and manage grants
- For sandbox mode servers, authorization codes are returned directly
- For non-sandbox servers, the `/v1/consent/:id/approve` endpoint must be available

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | All tests passed |
| `1` | One or more tests failed |
| `2` | Configuration or runtime error |

## License

PolyForm Noncommercial License 1.0.0, licensor Orchestrum Technologies LLP
([LICENSE](https://github.com/mishrasanjeev/grantex/blob/main/LICENSE)).
Noncommercial self use is free. Commercial use of any sort, including internal
use by a for-profit business, hosting or SaaS, resale, embedding and paid
services, needs a written agreement with Orchestrum Technologies LLP: see
[commercial licensing](https://github.com/mishrasanjeev/grantex/blob/main/COMMERCIAL-LICENSE.md)
or write to [sanjeev@orchestrum.in](mailto:sanjeev@orchestrum.in). Versions
published before 21 October 2026 remain available under the Apache License 2.0
they were released with. "Grantex" is a trademark of Orchestrum Technologies LLP
([trademarks](https://github.com/mishrasanjeev/grantex/blob/main/TRADEMARKS.md)).

## Ownership

Grantex is owned by Orchestrum Technologies LLP. Inventor and owner: Sanjeev Kumar. Ownership contact: [sanjeev@orchestrum.in](mailto:sanjeev@orchestrum.in) or [mishra.sanjeev@gmail.com](mailto:mishra.sanjeev@gmail.com).

## Source Development

Use Node.js 24 LTS and `npm ci` to build or test this checkout with Vitest 5.
Repository validation steps are in [the dependency upgrade guide](https://docs.grantex.dev/guides/dependency-updates).
Source-tooling requirements are separate from published package runtime support.
