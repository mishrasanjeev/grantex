# Base USDC SDK release verification

Date: 2026-09-07

## Scope and release state

Release source: `0bb46b0a03ab51f728072a019a0fc285215d9cee`, merged through
[PR #1153](https://github.com/mishrasanjeev/grantex/pull/1153).
All active PR checks and main CI, CodeQL, and Security Scan passed.
The [artifact dry run](https://github.com/mishrasanjeev/grantex/actions/runs/34073148841)
passed with all publication flags disabled.

| Artifact | Result |
| --- | --- |
| Python `grantex==0.5.0` | Published to PyPI; wheel and sdist SHA-256 values match the local tested artifacts; clean public-index install verified |
| Go `github.com/mishrasanjeev/grantex-go@v0.3.0` | Published tag at `1f6806670e908cb5470379c5e370eaff260bb829`; public proxy download and module checksums verified |
| TypeScript `@grantex/sdk@0.6.0` | Published to npm on 2026-09-07; registry integrity matches the tested tarball; exact-version clean registry install verified |
| x402 `@grantex/x402@0.4.0` | Published to npm on 2026-09-07; registry integrity matches the tested tarball; exact-version clean registry install verified |

Earlier npm publish approvals expired and exact-version registry requests
returned 404. A fresh approval completed on 2026-09-07, and both packages were
published successfully. A new consumer directory installed the exact versions
with npm registry tarball URLs in its lockfile and matching integrity values.
The public release snapshot now advertises TypeScript `0.6.0` and x402 `0.4.0`.
Do not infer publication from a manifest or local tarball installation alone.

## Verification

| Check | Evidence |
| --- | --- |
| TypeScript source | 457 tests passed; typecheck and build passed |
| x402 source | 206 tests passed; typecheck and build passed |
| Python source | 613 tests passed; mypy passed for 89 source files; explicit Ruff project rule set passed |
| Python distributions | Wheel and sdist built; Twine checks passed; LICENSE and NOTICE included |
| Python installed artifacts | 613 tests passed against the local wheel and again against the clean public PyPI wheel |
| Go source and publication | Full source tests, standalone race tests, and public-module race tests passed; `go mod verify` passed |
| npm artifact consumer | Exact candidate versions, public exports, LICENSE/NOTICE, synchronous Base safety gates, and principal/DPoP-agent reconciliation wire contracts passed |
| Public npm consumer | A separate clean directory installed exact registry versions; all artifact checks passed and npm audit reported zero vulnerabilities |
| Local Docker Base | 11 scenarios plus the parent result passed (12 Node test results), using the final npm tarballs against the isolated PostgreSQL/Redis/auth-service/Anvil stack |
| Local Docker existing wallets | Complete prepaid-wallet lifecycle and layered spend-control lifecycle passed using installed npm candidates |
| Public npm Docker retest | 11 Base scenarios plus the parent result passed (12 Node results, 42.81s); existing prepaid-wallet and layered-policy lifecycle tests both passed (30.25s), using public registry packages |
| API contract | Both Base API contract tests passed |
| Public Python/Go production boundary | Principal and agent reconciliation requests with deliberately invalid credentials returned 401 in both installed SDKs |
| Full production candidate E2E | 255 tests passed across all 23 files in 282.88 seconds, with `GRANTEX_SDK_TEST_ROOT` selecting installed TypeScript/x402 candidate tarballs; this was not an npm registry install |
| Full production public-registry E2E | 255 tests passed across all 23 files in 281.80 seconds after publication, with `GRANTEX_SDK_TEST_ROOT` selecting the new clean npm registry consumer |
| Documentation | Local integrity, mirrored metadata, links, navigation, JSON-LD, and live registry checks passed |
| Supply chain | 37 lockfiles and 4,308 entries passed repository checks; tested npm dependency installations and consumer audit reported zero vulnerabilities |

These are repeated suites, not additive distinct-test totals. Python and Go
production 401 probes verify routing and authentication boundaries, not successful
funded settlement. The public npm install is distinct from the earlier candidate
installation; both use the same verified immutable artifact bytes.

Final prepared npm artifact integrity values:

```text
@grantex/sdk@0.6.0
sha512-qpdvgB8/U1bL1tNk+hhAb/du/lwv3CjJnl4UW6p6iBwd/1Igcq5sxFT/jqYzAs5QTV0AqE4+TWNBppb8BarGnw==
@grantex/x402@0.4.0
sha512-REjrrQFEnhEJDCuEgl3JDJqA82G3ENLaDobG2e5Xc6jv0x12sM+E9sg78j5LI0h+C97yKiORwBnjNV/bHGPymw==
```

## Packaging and workflow changes

- Release artifacts include Apache-2.0 LICENSE and NOTICE files. Standalone
  NOTICE references use an absolute repository link.
- The guarded SDK workflow tests and packs TypeScript and x402, builds Python
  distributions, and tests Go. Publication flags are limited to main.
- Installed-artifact E2E mode requires both SDK distributions under
  `GRANTEX_SDK_TEST_ROOT`; it fails rather than silently importing repository
  source when a candidate is missing.
- Ruff 0.16 expanded implicit defaults. The project now explicitly preserves
  its existing `E4`, `E7`, `E9`, and `F` gate. This does not claim that all of
  Ruff's additional opt-in findings were remediated.

Local authenticated publication was used for npm, Python and Go. This is not evidence
that npm/PyPI trusted publishing is configured, nor an artifact-provenance claim.
The standalone Go repository accepted an ordinary owner push of main and the
annotated tag, while reporting a bypass of its pull-request rule. No force push
was used; future Go releases should follow a separate PR-gated publication path.

## Remaining boundaries

- Publication and clean registry verification are complete for all four SDKs.
  Future releases still require publishing approval or configured trusted
  publishing. Never commit credentials or disable two-factor authentication.
- Python and Go expose EVM payment responses and authenticated reconciliation,
  not an automatic HTTP 402/sign/retry wrapper. That wrapper belongs to the
  published x402 adapter.
- The Base server implementation was deployed previously. This SDK release
  does not enable or fund custody; production Base RPC and wallet bindings are
  not configured by this release.
- No funded Base-mainnet call to the external taxi preflight service was made.
  Local Anvil execution with the official facilitator is not such evidence.
- The initial custody signer is in-process, not an HSM or MPC provider.
  Previously issued signatures can settle until their on-chain expiry even
  after a wallet block; signed exposure stays reserved until reconciliation.

See the [Base custody guide](../guides/base-usdc-custody.mdx) for operational
requirements and the [release status](../release-status.mdx) for public versions.
