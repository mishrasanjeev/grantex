# Governed Base USDC x402 implementation verification

Date: 6 September 2026. Baseline: `0b7f717ca2cb9affdb9ef8af51ae11fa395a0b4d`.
Branch: `codex/x402-external-compatibility-20260906`.

## Scope and result

The payment-network implementation gap is addressed in source: opt-in Base
native USDC EIP-3009 signatures are now issued behind Grantex's existing wallet
policies and durable reservations. No merchant-specific schema workaround is
required. The original published-client probe remains historical evidence in
[the external probe report](x402-uk-taxi-phv-compatibility-2026-09-06.md).

This is not a production payment success claim. No funded Base wallet was
configured for a real third-party call, no paid retry was sent to the UK taxi
endpoint, and no real funds were transferred. The changes have not been
published to SDK registries. Server rollout is tracked separately below.

## Release preparation (7 September 2026)

The final workstation Docker rerun passed all 11 Base scenarios (12 test results),
including an explicit final payer-chain balance assertion. Both existing
prepaid/layered-control E2E lifecycles also passed. Full x402 (206), TypeScript
SDK (457), Python SDK (613), Go SDK and full auth-service (2,151 passed, two
existing skips) suites passed again. The API reference
now describes the EVM payload and both authenticated reconciliation routes,
with a passing contract test. Public guidance distinguishes sandbox release
from signed EVM exposure and documents reconciliation scheduling and rollback.

Supply-chain policy initially identified missing test-fixture Dependabot
coverage and missing memorystream license metadata. Both are addressed: the
fixture has its own update stream, and the checker accepts only the reviewed
MIT-licensed memorystream 0.3.1 tarball. All 37 npm lockfiles and 4,308 package
entries pass the policy check; auth-service production and compiler-fixture
vulnerability audits each report zero vulnerabilities.

The first PR CodeQL run flagged the local merchant fixture's request-dependent
setup, reflected exception text and an unused import. The fixture now defines
payment terms before accepting requests, explicitly requires verification and
settlement success, and returns constant JSON errors. A new Docker scenario
confirms missing/malformed headers cannot execute or settle work. The complete
Docker rerun passed after these changes; no scanner suppression was added.

Production deployment and post-deploy verification are pending at preparation
time. Deployment does not provision a funded wallet or publish SDK packages.

## Implemented controls

- Opt-in `baseUsdc` client configuration with application-bound scope, stable
  idempotency, original POST body preservation and standard x402 v2 payloads.
- Exact native token/network/domain restrictions; no Permit2 or contract-wallet
  fallback; redirects and challenge resource mismatches rejected.
- Operator custody key binding to developer, principal and derived address;
  duplicate address registration prevented by migration 094.
- Finalized, canonical, exact USDC funding receipt verification and duplicate
  funding prevention before ledger credit.
- Existing assignment and layered policy checks before signing; real chain
  balance check, encrypted persisted signature, atomic reservation and nonce reuse.
- Whole-second expiry bounded by request, grant, access token and assignment.
- Blocks/revocations cannot prematurely release signed EVM exposure. Outstanding
  reservations continue counting across spend-window boundaries.
- Finalized nonce/transfer reconciliation; unused finalized expiry release;
  conservative holds on RPC failure or incomplete evidence; bounded sweeps with
  sanitized failure warnings and authenticated manual reconciliation endpoints.
- Additive TypeScript/Go response types and agent/principal reconciliation
  methods in TypeScript, Python and Go. Python preserves the EVM payload dictionary.
- Setup documentation and repeatable Docker/CI coverage. Existing prepaid client
  behavior remains the default; the raw client is not a request-bound Base signer.

## Verification results

| Check | Result |
| --- | --- |
| Full auth-service suite | 2,151 passed; 2 pre-existing skips |
| Full x402 suite | 206 passed |
| Final focused x402 wire/default regression | 29 passed |
| Full TypeScript SDK suite | 457 passed |
| Full Python SDK suite | 613 passed; one expected permissive-mode warning |
| Full Go SDK suite | `go test ./...` passed, including new payload/reconciliation coverage |
| TypeScript auth-service, SDK and x402 type checks | Passed |
| Python changed module mypy | Passed |
| Existing prepaid and layered-controls Docker E2E | Both complete lifecycle tests passed |
| New Base Docker E2E | 10 scenarios passed (11 node:test results including parent) |
| Auth-service production dependency audit | 0 vulnerabilities |
| Solidity test-fixture dependency audit | 0 vulnerabilities after patched `tmp` override |
| Workflow/Compose YAML parsing | Passed |

The isolated Docker project ran the authorization service, PostgreSQL, Redis
and Anvil (chain ID 8453). A test-only USDC contract at the native token address
verified EIP-712 signatures and executed transfers. The merchant used the
official `@x402/evm@2.25.0` facilitator verification and settlement code.

The first paid flow transferred exactly 20,000 atomic test units and returned
HTTP 200. A second 10,000-unit authorization issued before a block was settled
after the block and reconciled. A separate 30,000-unit hold remained reserved
through a provider outage and returned to available only after finalized unused
expiry. From a 1,000,000-unit initial test credit, final available and chain
balance were 970,000 with zero reserved, and the merchant held 30,000 units.

Coverage includes ownership and address mismatch, duplicate registration and
funding, denied amount/payee/resource/scope, real 402/sign/retry, token transfer,
tampering, replay, concurrent recovery, auth-service restart, rolling-window
exposure, blocking, post-block settlement, RPC outage and unused expiry.
The test suite uses generated local payer keys, not any production wallet key.

The Docker run found an expiry precision mismatch between fractional OAuth
expiry and integer EIP-3009 time; that was fixed and the full flow rerun. The
test compiler initially depended on vulnerable `tmp`; its override was patched
and audited. Optional Ruff checking reports nine unchanged findings already
present in the baseline Python wallet module; baseline/current comparison found
no newly introduced Ruff findings. These were not disguised as a clean lint run.

## Remaining activation and limitations

Deploy the reviewed migration/server code and publish tested SDK releases
separately. Provision a dedicated funded Base USDC wallet, protected custody key,
trusted production HTTPS RPC and stable vault/OAuth keys. The initial signer is
in-process, not an HSM/MPC service. Operators must assess that custody risk and
avoid sharing its balance with other apps or deployments.

Then perform the authorized single $0.02 production call and retain its actual
HTTP result and settlement evidence. Local official-facilitator compatibility
does not prove PayAI availability, merchant delivery or mainnet settlement.
Merchant result caching/idempotency, funding rails, notification channels and
custodian/regulatory responsibilities remain external. Do not replace an
ambiguous payment with a fresh key and automatically charge again.

See [the operator guide](../guides/base-usdc-custody.mdx) and
[repeatable local commands](../../tests/base-usdc/README.md).
