# Local Base USDC Compatibility Tests

This suite uses its own Docker project (`grantex-base-compat`), loopback ports
3349/3459/5549/8549, ephemeral signing keys, PostgreSQL, Redis and an Anvil chain
with chain ID 8453. The mintable `TestUSDC.sol` fixture is installed only on that
isolated chain at the native USDC address. It is not production token code.
The merchant uses the official `@x402/evm` facilitator implementation.

Never point this suite at a real network. It resets its local Anvil state and
uses direct fixture-only database time changes to test rolling-window edges.
Do not run two copies against the same Docker project concurrently.

From the repository root in PowerShell:

```powershell
npm ci --prefix apps/auth-service
npm ci --prefix packages/sdk-ts
npm run build --prefix packages/sdk-ts
npm ci --prefix packages/x402
npm run build --prefix packages/x402
npm ci --prefix tests/base-usdc
npm ci
node --test tests/base-usdc/api-contract.test.mjs
docker compose -p grantex-base-compat -f tests/base-usdc/compose.yml up --build -d
$env:GRANTEX_BASE_DOCKER_TEST = '1'
node --test tests/base-usdc/base-usdc.test.mjs
# After inspecting the exit code and output, remove only this disposable stack:
docker compose -p grantex-base-compat -f tests/base-usdc/compose.yml down --volumes
```

Tests cover custody ownership, duplicate registration, exact finalized funding,
duplicate funding, denied spend terms, missing/malformed payment headers,
standard 402/authorize/retry, actual token
transfer, official facilitator verification, tampering, replay, concurrent
idempotency, auth-service restart, rolling-window exposure, blocking, settlement
after blocking, RPC outage and finalized unused expiry. The existing root
`tests/e2e/prepaid-wallets.test.ts` and `wallet-spend-controls.test.ts` cover the
broader multi-wallet, approval and reload lifecycle and are run separately.

This does not prove that a third-party production merchant or PayAI will accept
a funded mainnet payment. The captured UK taxi challenge is a wire fixture; the
local test substitutes only the local resource URL and test recipient.

To verify release tarballs or published packages instead of checkout builds,
install the exact SDK and x402 artifacts in a clean directory and set
`GRANTEX_SDK_TEST_ROOT` to its absolute path before running the same suite.
The test then imports both clients from that directory's `node_modules`.
Run `node scripts/verify-sdk-artifacts.mjs <consumer-directory>` for the
packaged export, wire-contract and version checks. Unset the environment
variable after verification; all chain operations still target local Anvil.

The test compiler's `memorystream@0.3.1` tarball includes the MIT license
(Copyright 2011 Dmitry Nizovtsev) but omits current lockfile license metadata.
The supply-chain checker records that exact reviewed version, not a blanket
license exception. Preserve dependency license files when redistributing tools.
