# Usage and licensing

## LICENSE-SCOPE

| Directory | Licence | Licence file |
| --- | --- | --- |
| `packages/` (every SDK and client package: `sdk-ts`, `sdk-py`, `go-sdk`, the framework integrations, verifiers, `agent-passport*`, `agent-httpsig*`, `x402`, `mpp`, `mcp`, `mcp-auth`, `adapters`, `a2a*`, `gateway`, `mock-issuer`, `cli`, `conformance`, `destinations`, `dpdp`, `terraform-provider-grantex`, `strands*` and the rest) | Apache-2.0 | `packages/<name>/LICENSE` |
| `examples/` | Apache-2.0 | [examples/LICENSE](examples/LICENSE) |
| `spec/examples/` (interoperability test vectors) and `spec/*.schema.json` (machine-readable schemas), which the SDKs use | Apache-2.0 | [spec/examples/LICENSE](spec/examples/LICENSE) |
| `apps/` (auth service, developer portal and the other apps) | PolyForm-Noncommercial-1.0.0 | [LICENSE](LICENSE) |
| The rest of `spec/` (specification prose), `SPEC.md`, `docs/`, `web/`, `deploy/`, `assets/`, `skills/`, `scripts/`, `tests/`, `security/`, `qa/` and root files | PolyForm-Noncommercial-1.0.0 | [LICENSE](LICENSE) |
| Third-party files listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) | Their own licences | As listed |

A file's own header or notice takes precedence over this table.

## What this means

- **SDKs and client packages are open source** under the Apache License 2.0:
  free for any use, including commercial use.
- **The Grantex server, portal and hosted services are source-available.** From
  21 October 2026 they are licensed under the PolyForm Noncommercial License
  1.0.0, including all updates. Only self use is free; commercial use of any
  sort needs Orchestrum's prior approval and a written agreement with
  Orchestrum Technologies LLP. Agreements:
  [sanjeev@orchestrum.in](mailto:sanjeev@orchestrum.in).

| Document | What it covers |
| --- | --- |
| [LICENSE](LICENSE) | PolyForm Noncommercial 1.0.0 text and the `Required Notice:` lines |
| [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md) | What is free, what needs an agreement, how to obtain one, earlier versions |
| [TRADEMARKS.md](TRADEMARKS.md) | The Grantex and AgenticOrg names, logos, hosted services and brand |
| [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) | Third-party material that keeps its own licence |
| [CONTRIBUTING.md](CONTRIBUTING.md) | The licence contributors grant |

This replaces the transition policy published on 12 October 2026 and its
candidate licence text, which no release adopted.
