# @grantex/mpp

Agent identity and delegation for the [Machine Payments Protocol (MPP)](https://mpp.dev). Lets merchants verify who authorized an AI agent's payment before fulfilling the request.

## Install

```bash
npm install @grantex/mpp @grantex/sdk
```

## Quick Start

### Issue a Passport

```typescript
import { Grantex } from '@grantex/sdk';
import { issuePassport } from '@grantex/mpp';

const grantex = new Grantex({ apiKey: process.env.GRANTEX_API_KEY });

const passport = await issuePassport(grantex, {
  agentId: 'ag_01HXYZ...',
  grantId: 'grnt_01HXYZ...',
  allowedMPPCategories: ['inference', 'compute'],
  maxTransactionAmount: { amount: 50, currency: 'USDC' },
  expiresIn: '24h',
});
```

### Attach to MPP Requests

```typescript
import { createMppPassportMiddleware } from '@grantex/mpp';

const middleware = createMppPassportMiddleware({ passport });
const enrichedRequest = await middleware(new Request(url, init));
const response = await fetch(enrichedRequest);
```

### Verify on Merchant Side

```typescript
import { verifyPassport, requireAgentPassport } from '@grantex/mpp';

// Standalone
const verified = await verifyPassport(encodedCredential, {
  requiredCategories: ['inference'],
  maxAmount: 10,
});

// Express middleware
app.use('/api/resource', requireAgentPassport({
  requiredCategories: ['inference'],
}));
```

### Trust Registry

```typescript
import { lookupOrgTrust } from '@grantex/mpp';

const record = await lookupOrgTrust('did:web:acme.com');
// { organizationDID, trustLevel, verificationMethod, domains, verifiedAt }
```

## KYA tier claim

With `AGENT_PASSPORT_KYA_TIER_ENABLED=true` (default off), an issued passport's
`credentialSubject` may carry `kyaTier`:

```json
"kyaTier": {
  "tier": "tier-1",
  "trustMarks": ["urn:grantex:tm:agent.identity"],
  "mappingVersion": "2026-10-pending-scheme-specs"
}
```

The tier comes from an operator-configured table, `AGENT_PASSPORT_KYA_TIER_MAP`,
that maps registry trust marks to tier labels. The table is empty by default, so
no tier is issued until an operator configures one. The card networks' and
wallet schemes' KYA tier specifications are not yet published; until they are,
Grantex defines no tiers of its own and attaches no meaning to a label beyond
the mapping. The first table entry whose trust marks the agent's counted
attestations all hold gives the tier. The claim reflects the registry at
issuance; read the registry lookup for the agent's standing now.
`verifyPassport` in `@grantex/mpp` returns `kyaTier` when the signed passport
carries one, and refuses a malformed one (`MALFORMED_CREDENTIAL`).

## Error Codes

| Code | Description |
|------|-------------|
| `PASSPORT_EXPIRED` | Passport `validUntil` has passed |
| `PASSPORT_REVOKED` | StatusList2021 bit is set |
| `INVALID_SIGNATURE` | Ed25519/RS256 signature verification failed |
| `UNTRUSTED_ISSUER` | Issuer DID not in trusted list |
| `CATEGORY_MISMATCH` | Passport categories don't cover required service |
| `AMOUNT_EXCEEDED` | Passport max amount below required threshold |
| `MISSING_PASSPORT` | No X-Grantex-Passport header |
| `MALFORMED_CREDENTIAL` | Invalid base64url or missing VC fields |

## License

Apache-2.0

## Ownership

Grantex is owned by Orchestrum Technologies LLP. Inventor and owner: Sanjeev Kumar. Ownership contact: [sanjeev@orchestrum.in](mailto:sanjeev@orchestrum.in) or [mishra.sanjeev@gmail.com](mailto:mishra.sanjeev@gmail.com).
