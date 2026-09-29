# SDK Authority Audit

Date: 2026-09-29

Source baseline: `c6508190aeb380a4722d90cb3dc12d06dc4ed072` plus the
SDK authority audit source changes. This is a local source validation report,
not a registry release or production deployment attestation.

## Scope and Verdict

All 34 package directories were reviewed for the recently identified human
identity, consent, current-authority and execution-boundary gaps. The same
OAuth-client-ID-as-human substitution was not found in the other SDKs.
Related defects and missing explicit authority bindings were found and fixed
in the affected source paths. The full package sweep passes.

This is **not** an unconditional sign-off on every SDK configuration. Historical
offline verification defaults remain offline. The new issuer check and trusted
human/agent bindings are opt-in. A caller that omits them does not acquire a
current-authority guarantee merely by updating a package.

Primary release candidates are TypeScript SDK **0.8.1** and Python SDK **0.7.1**.
Go changes are source-only until a new module tag. Changed integrations need
their own release versions after the primary SDK releases. No packages were
published, tagged, pushed or deployed by this audit.

## Findings and Fixes

| Finding | Source remediation | Remaining boundary |
| --- | --- | --- |
| Malformed online authority responses could be accepted using truthiness | TS/Python require literal `active: true` and valid claims; Go adds a strict typed `Grants.Verify` endpoint client | Use a trusted issuer/API transport; legacy Go `Tokens.Verify` is a different API |
| A response claiming `revoked: false` with a contradictory status could allow execution | TS/Python online revocation allows only `status: active` with a literal false revocation flag | Do not replace issuer checks with positive caches |
| Empty principal/token identifiers could pass normalization | TS/Python/Go reject empty `sub` and `jti` | Host login must bind the principal; an agent argument is not authentication |
| Local signature/scopes alone cannot establish current grant authority | Optional uncached callbacks compare issuer, audience, token, grant, principal, agent, tenant, times and scopes before execution | Existing offline APIs deliberately retain their defaults |
| Wrappers lacked explicit trusted human/agent bindings | Options forwarded across 15 execution integration packages | Configure these from trusted host state, per user/request where needed |
| Online tool authorization used truthiness | Both Strands wrappers require literal `allowed: true`; bound online tools verify identity/scope first | Permissive SDK enforcement remains evaluation-only |
| Bound Python tool creation could consume enforcement work before execution | Bound creation performs token/scope checks but does not call `enforce`; enforcement occurs on invocation | Actual operation inputs and reservation settlement remain host responsibilities |
| Gateway YAML could silently drop a requested new control | Loader preserves/validates authority flags and fixed human/agent bindings; callback values in YAML are rejected | A static gateway principal is not multi-user host login |
| Identity-denial messages could be misclassified as expiry | Express/gateway expiry classification uses expiry terms rather than any `exp` substring | Denials still prevent execution |
| Mock issuer could miss same-size state changes under coarse timestamps | State content comparison replaces mtime/size caching; disappeared loaded state refuses status with HTTP 503 | Private testing issuer, not a production concurrent state store |
| Documentation example tests assumed LF line endings and inherited shell startup state | Tests normalize CRLF and isolate the example shell | Documentation examples still execute and must pass |

## Package Inventory

The counts below are passing tests in each package's complete suite. Go counts
top-level passing tests; nested subtests are not double-counted. Terraform's
tests are its default local suite, not production acceptance tests.

| Package | Passed | Reviewed role and changes |
| --- | ---: | --- |
| sdk-ts | 1383 | Strict authority validation, optional current-authority/identity profile |
| sdk-py | 1618 | Equivalent profile and malformed/contradictory response denial |
| go-sdk | 229 | Current `Grants.Verify` API, optional authority/identity profile; no full manifest engine parity |
| anthropic | 44 | Execution callback receives current-authority/identity options |
| autogen | 25 | Execution callback receives current-authority/identity options |
| langchain | 20 | Construction and invocation checks forward the new options |
| vercel-ai | 23 | Tool checks forward the new options |
| strands | 16 | Offline/online binding, literal online authorization and denied execution regressions |
| crewai | 11 | Tool checks forward the Python options |
| openai-agents | 7 | Tool checks forward the Python options |
| google-adk | 6 | Tool checks forward the Python options |
| strands-py | 17 | Bound online enforcement deferred to invocation; literal authorization |
| express | 23 | HTTP guard forwards binding and authority options |
| fastapi | 20 | Worker-thread guard forwards binding and authority options |
| a2a | 35 | Incoming grant guard forwards binding and authority options |
| a2a-py | 29 | Incoming grant guard forwards binding and authority options |
| adapters | 164 | Checks occur before upstream credential resolution/execution |
| gateway | 123 | Checks occur before proxying; strict YAML controls |
| cli | 556 | Privileged administration; candidate SDK minimum raised |
| mcp-auth | 396 | Existing authenticated human resolver/current-grant guards; candidate SDK minimum raised |
| mcp | 45 | Privileged management, not an end-customer human-login service |
| agent-passport | 131 | Credential/issuer/status proof, not human delegation consent |
| agent-passport-py | 208 | Credential/issuer/status proof, not human delegation consent |
| agent-httpsig | 179 | Request/key possession, separate grant policy needed |
| agent-httpsig-py | 182 | Request/key possession, separate grant policy needed |
| mpp | 76 | Passport transport; trusted issuer/status configuration required |
| x402 | 210 | Payment/delegation boundary; legacy registry is process-local by default |
| gemma | 142 | Offline snapshot verification; cannot guarantee immediate issuer revocation |
| gemma-py | 54 | Offline snapshot verification; cannot guarantee immediate issuer revocation |
| dpdp | 106 | Purpose/privacy helpers, not a human-consent authentication guard |
| destinations | 15 | Audit delivery, not an execution authorization guard |
| conformance | 39 | Protocol testing, not runtime authorization |
| mock-issuer | 70 | Test issuer; persisted status freshness fixed |
| terraform-provider-grantex | 9 | Privileged provisioning; default local tests and Go vet |

Totals: **6,211 passed**, **0 failed**, **2 existing MCP Auth skips**. The skips
are storage-contract raw-dump inspection checks for an adapter without that
test interface: secret persistence and stored authorization-code hashing.
They are not evidence that those checks executed for every storage backend.

## Execution-Boundary Regressions

`scripts/verify-sdk-authority.mjs` ran **101** signed-token/HTTP checks across
nine TypeScript integrations, including a gateway configuration-loader path
using the real SDK client. `tests/sdk-authority/verify_python.py` ran **54**
equivalent checks across six Python integrations.

The fixtures use locally generated RS256 keys, a local JWKS HTTP server and
an issuer HTTP stub. Cases cover active authority, revocation after success,
issuer outage, malformed active flags, human/agent/tenant/token/issuer/audience
substitution and trusted-host identity mismatch. Every denied operation is
checked for zero callback, credential-resolution or proxy effects as applicable.
Authority checks are counted to detect positive-cache reuse.

Go additionally exercises the real HTTP grant client and signed JWKS verifier,
malformed authority responses, trusted identity, post-success revocation and
ten substituted authority fields. Monorepo spec fixtures execute, not skip.

TypeScript framework libraries are installed in the Docker sweep. Some optional
Python vendor runtime objects use local test doubles. This is not certification
of every model runtime, hardware passkey, browser or external payment rail.

## Workstation Docker Validation

- Node 24.20.0: 22 package full suites, typechecks and available builds.
- Python 3.12: ten package full suites; primary SDK strict mypy (121 source
  files) and Ruff pass.
- Go 1.26.1: SDK and Terraform default full suites plus `go vet ./...`.
- Disposable PostgreSQL 16 and Redis 7 enable primary SDK caps integration
  tests; no production databases, customer accounts or real payment funds.
- Documentation integrity and workflow actionlint pass.
- Package vendor denylist audit passes; pre-existing terminology warnings
  remain informational.

The dedicated `SDK Authority Boundaries` workflow runs Node/Python/Go jobs,
retains test artifacts and disposes its test services. It has been validated
locally, not yet run as a remote check on these unpushed source changes.
See [reproduction instructions](../../tests/sdk-authority/README.md).

## Required Release and Deployment Decisions

1. Publish and verify primary SDK candidates before dependent integrations.
   Candidate dependencies require TS >=0.8.1 or Python >=0.7.1; source dev
   links used by CI are not proof of registry availability.
2. Rebuild CLI/MCP Auth and integration artifacts from audited source. Do not
   reuse earlier prepared archives with the old primary SDK dependency range.
3. Decide separately whether production-oriented integrations should make
   current authority mandatory by default in breaking releases. This audit
   does not flip offline defaults or publish additional packages.
4. Host authentication, live human consent, action-bound decisions and atomic
   cumulative caps remain independent requirements. Scope guards alone do
   not implement the whole policy engine. Go has no equivalent full manifest
   `enforce` implementation in this change.
5. A pre-execution issuer check cannot make an unrelated external side effect
   atomic with revocation. Irreversible work needs authoritative decision/
   reservation consumption and settlement at its actual execution boundary.
6. Administrative MCP/CLI/Terraform access must remain privileged. Passport,
   request-signature, legacy payment and offline snapshot packages must not
   be presented as proof of authenticated human approval or fresh delegation.

No production, registry or universal-security sign-off follows merely from
passing these local tests. The tested source fixes and configured profile
passed; omitted host controls and evaluation/offline configurations do not
carry the same guarantee.
