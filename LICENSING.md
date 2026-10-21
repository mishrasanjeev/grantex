# Usage and licensing

## LICENSE-SCOPE

| Directory | Licence | Licence file |
| --- | --- | --- |
| `packages/` (every SDK and client package: `sdk-ts`, `sdk-py`, `go-sdk`, the framework integrations, verifiers, `agent-passport*`, `agent-httpsig*`, `x402`, `mpp`, `mcp`, `mcp-auth`, `adapters`, `a2a*`, `gateway`, `mock-issuer`, `cli`, `conformance`, `destinations`, `dpdp`, `terraform-provider-grantex`, `strands*` and the rest) | Apache-2.0 | `packages/<name>/LICENSE` |
| `examples/` | Apache-2.0 | [examples/LICENSE](examples/LICENSE) |
| `spec/examples/` (interoperability test vectors) and `spec/*.schema.json` (machine-readable schemas), which the SDKs use | Apache-2.0 | [spec/examples/LICENSE](spec/examples/LICENSE) |
| `apps/` (auth service, developer portal and the other apps) | LicenseRef-Orchestrum-Personal-Use-1.0 | [LICENSE](LICENSE) |
| The rest of `spec/` (specification prose), `SPEC.md`, `docs/`, `web/`, `deploy/`, `assets/`, `skills/`, `scripts/`, `tests/`, `security/`, `qa/` and root files | LicenseRef-Orchestrum-Personal-Use-1.0 | [LICENSE](LICENSE) |
| Third-party files listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) | Their own licences | As listed |

`LicenseRef-Orchestrum-Personal-Use-1.0` is the SPDX identifier this repository
uses for the Orchestrum Personal Use License 1.0 in the root [LICENSE](LICENSE).
A file's own header or notice takes precedence over this table.

## What this means

- **SDKs and client packages are open source** under the Apache License 2.0:
  free for any use, including commercial use.
- **The Grantex platform is source-available.** From 21 October 2026 the
  server, portal, specification text, documentation and website are licensed
  under the Orchestrum Personal Use License 1.0, including all updates. Only an
  individual using them for their own personal purposes is free. Every
  organisation (companies, firms, sole proprietors' businesses, charities,
  schools, universities, research bodies and government) needs prior written
  permission from Orchestrum Technologies LLP in a signed agreement, including
  for evaluation, testing, pilots, internal use, hosting, resale and embedding,
  paid or free. Permission:
  [sanjeev@orchestrum.in](mailto:sanjeev@orchestrum.in).

| Document | What it covers |
| --- | --- |
| [LICENSE](LICENSE) | Orchestrum Personal Use License 1.0 text and the ownership notice |
| [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md) | What is free, what needs permission, how to obtain it, earlier versions |
| [TRADEMARKS.md](TRADEMARKS.md) | The Grantex and AgenticOrg names, logos, hosted services and brand |
| [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) | Third-party material that keeps its own licence |
| [CONTRIBUTING.md](CONTRIBUTING.md) | The licence contributors grant |

Releases published before 21 October 2026 remain available under the terms
they were released with.
