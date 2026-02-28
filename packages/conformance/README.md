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
  -h, --help             Display help
```

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

## Core Suites (37 tests)

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

## Optional Extensions

| Suite | Tests | Description |
|-------|-------|-------------|
| `policies` | 5 | Policy CRUD operations |
| `webhooks` | 3 | Webhook registration and management |
| `scim` | 6 | SCIM 2.0 provisioning endpoints |
| `sso` | 4 | SSO configuration and flow |
| `anomalies` | 3 | Anomaly detection and acknowledgement |
| `compliance` | 4 | Compliance reporting and evidence export |

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

Apache-2.0
