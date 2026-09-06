# External x402 v2 compatibility: UK Taxi / PHV preflight

Tested: 6 September 2026, 16:59:07 UTC (22:29:07 IST).
Source baseline: `0b7f717ca2cb9affdb9ef8af51ae11fa395a0b4d`.

## Verdict

Historical probe below: this records the unmodified published 0.3.0 client's
behavior, not the subsequent source fix. The follow-up implementation and local
verification are recorded in [Base USDC implementation verification](x402-base-usdc-implementation-2026-09-06.md).
The external production endpoint still has not received a paid retry.

The production challenge is valid and parseable. The current Grantex managed
prepaid client cannot complete this service's Base-mainnet payment and retry.
The observed blocker is Grantex's unsupported payment network, not an observed
merchant header/schema defect. Paid service output and settlement are untested.

| Requested result | Observed result |
| --- | --- |
| Challenge parsed | Yes; official decoder and x402 v2 schema accept it |
| Authorization/payment retry | No; unsupported network is rejected before authorization |
| Last server HTTP response | `402 Payment Required`, body `{}` |
| Paid result | Not obtained; no paid retry was sent |
| Header/schema problem | None observed in the initial challenge |
| Funds transferred | None |

## Live request and evidence

One unsigned POST was made through the unmodified published
`@grantex/x402@0.3.0` client to:

`https://uk-taxi-phv-mcp-production-6ef3.up.railway.app/api/v1/preflight`

```json
{
  "authority": "City of Bradford Metropolitan District Council",
  "age": 30,
  "driving_licence_years": 4,
  "has_pass_plus_certificate": true
}
```

The probe disabled redirects, enforced the exact URL/method/body, limited
network calls to one, and refused Authorization and PAYMENT-SIGNATURE headers.
Its authorization callback was an unconfigured fail-closed stub, not a real
wallet. That callback was never reached. No private key, API credential, or
payment signature was sent. This is a genuine external HTTP/client probe, but
not a successful external agent-wallet payment validation.

The standard `payment-required` response header decoded to:

| Field | Value |
| --- | --- |
| x402Version | `2` |
| scheme | `exact` |
| network | `eip155:8453` |
| asset | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| amount | `20000` atomic units, quoted as 0.02 USDC |
| payTo | `0xDAAef0FD525278aAD0bA11066A96c338642A3d1A` |
| maxTimeoutSeconds | `300` |
| extra | `name: USD Coin`, `version: 2` |

The exact resource URL matched the requested endpoint. The header contained
a Bazaar extension describing the POST input. Lowercase HTTP header names and
an empty JSON response body were handled normally. The response used
`Cache-Control: no-store` and Railway request ID `MLjM95LaRjWvPaMem3z_FQ`.
The captured header is preserved in
`packages/x402/tests/fixtures/uk-taxi-phv-base-mainnet-402.json`.

Client failure starts with:

```text
Failed to create payment payload: No network/scheme registered for x402 version: 2 which comply with the payment requirements.
```

The diagnostic reports accepted network `eip155:8453` versus registered network
`grantex:prepaid`. Observed counters: one HTTP request, zero Grantex
authorization calls, zero payment signatures, zero paid retries.

The public [OpenAPI](https://uk-taxi-phv-mcp-production-6ef3.up.railway.app/openapi.json)
and [x402 metadata](https://uk-taxi-phv-mcp-production-6ef3.up.railway.app/.well-known/x402)
agree on the price, endpoint and network.
[PayAI supported schemes](https://facilitator.payai.network/supported) includes
x402 v2 `exact` on `eip155:8453`. Reading that endpoint is not payment
verification or settlement. We did not invoke `/verify` or `/settle`.

## Reproducibility and package verification

The live probe used a clean npm consumer, not the monorepo build. npm's latest
tag was independently checked and returned `0.3.0`.

| Component | Version |
| --- | --- |
| @grantex/x402 | 0.3.0 |
| @x402/core (clean consumer resolution) | 2.25.0 |
| @x402/fetch (clean consumer resolution) | 2.25.0 |

Registry artifact integrity:

```text
sha512-6JXfGIjUS5hWCZ5315LTS3cUP/n2oIm8bjzJ7dAfBFJIxu+MHFvZapVEoRjJH2IeV3u1YW8lyCSgWEdjZVGP6w==
```

The source checkout's lockfile was installed independently for regression
testing. Results:

- `npm test` in `packages/x402`: 192/192 pass across 15 files.
- `npm run typecheck` in `packages/x402`: pass.
- `npm run build` in `packages/x402`: pass.
- Both clean installs reported zero npm audit vulnerabilities.

New regression coverage validates the captured standard schema and verifies
that both the default client and per-request wallet/idempotency client reject
the Base-only challenge before any reservation or paid retry. These tests use
the recorded fixture and never contact the third-party service or spend funds.

## Grantex changes and remaining work

The package README and x402 integration guide now explicitly distinguish x402
v2 message support from payment-network support. Runtime payment behavior and
security checks were not weakened to make this probe appear successful.

Current `createX402Agent` registers only `exact` on `grantex:prepaid`.
The authorization service deliberately rejects external custody funding and
settlement with `CUSTODY_ADAPTER_UNAVAILABLE`. A Grantex signed reservation is
not a Base USDC authorization that PayAI can settle.

To support this merchant through a genuinely governed Grantex wallet:

1. Configure a dedicated funded Base USDC custody wallet and a compatible EVM
   exact-payment signer. Keep signing keys inside the custody/signing service.
2. Enforce Grantex's principal, wallet, agent, amount, cumulative, payee, asset,
   network, and resource policies before issuing each chain authorization.
   Bind action scope from trusted agent configuration; a standard EVM merchant
   is not required to advertise `extra.grantexScope`.
3. Persist the exact authorization, nonce, validity window, payment terms and
   reservation before sending it. Reuse only the same logical payment after
   ambiguous failures, and reconcile verified settlement evidence durably.
4. Handle the irrevocability boundary explicitly: Grantex blocking a wallet or
   releasing an internal reservation does not revoke an already issued on-chain
   authorization. Keep funds reserved until settlement, verified cancellation,
   or verified expiry resolves that exposure.
5. Test signer/provider outages, insufficient USDC, denied policy, duplicate
   retries, response loss, restart recovery, settlement failure, and the exact
   production request before claiming Base/PayAI interoperability.

Simply registering an unrelated EVM signer would exercise standard x402 but
would not prove Grantex spend enforcement or ledger reconciliation. Changing the
merchant to `grantex:prepaid` would also cease to test the requested service as
offered. Neither approach was used.

No paid licensing result, evidence freshness behavior, browser CORS behavior,
or overall service security is certified by this limited probe. No success
example was published and no email was sent to the service owner.

## Suggested reply to the service owner

> We tested your production POST using the published @grantex/x402 0.3.0
> client. Challenge parsed: yes, including the standard x402 v2 schema and
> 0.02 USDC/Base payment terms. Authorization/payment retry: no. The last HTTP
> response was 402; no paid result was obtained and no funds were transferred.
> We found no header/schema issue in the challenge. Our current managed-wallet
> adapter registers grantex:prepaid, so it rejects eip155:8453 before wallet
> authorization. This is a Grantex payment-network integration gap, and we
> cannot yet claim the requested no-workaround Base/PayAI end-to-end success.
