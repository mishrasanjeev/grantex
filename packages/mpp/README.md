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

MIT
