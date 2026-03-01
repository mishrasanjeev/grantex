# @grantex/adapters

Pre-built service provider adapters for [Grantex](https://grantex.dev) — translate grant tokens into real API calls for Google Calendar, Gmail, Stripe, and Slack.

## Install

```bash
npm install @grantex/adapters @grantex/sdk
```

## Quick Start

```typescript
import { GoogleCalendarAdapter } from '@grantex/adapters';

const calendar = new GoogleCalendarAdapter({
  jwksUri: 'https://your-auth-server/.well-known/jwks.json',
  credentials: process.env.GOOGLE_ACCESS_TOKEN!,
});

// Agent presents a grant token — adapter verifies it, checks scopes, calls Google API
const result = await calendar.listEvents(grantToken, {
  timeMin: new Date().toISOString(),
  maxResults: 10,
});

if (result.success) {
  console.log(result.data); // Google Calendar API response
}
```

## Adapters

### Google Calendar

Requires scopes: `calendar:read`, `calendar:write`

```typescript
import { GoogleCalendarAdapter } from '@grantex/adapters';

const calendar = new GoogleCalendarAdapter({ jwksUri, credentials });

// List events (requires calendar:read)
await calendar.listEvents(token, { calendarId: 'primary', maxResults: 10 });

// Create event (requires calendar:write)
await calendar.createEvent(token, {
  summary: 'Team Sync',
  start: { dateTime: '2026-03-01T10:00:00Z' },
  end: { dateTime: '2026-03-01T11:00:00Z' },
});
```

### Gmail

Requires scopes: `email:read`, `email:send`

```typescript
import { GmailAdapter } from '@grantex/adapters';

const gmail = new GmailAdapter({ jwksUri, credentials });

// List messages (requires email:read)
await gmail.listMessages(token, { q: 'from:alice', maxResults: 5 });

// Send message (requires email:send)
await gmail.sendMessage(token, {
  to: 'bob@example.com',
  subject: 'Hello',
  body: 'Hi Bob!',
});
```

### Stripe

Requires scopes: `payments:read`, `payments:initiate`

Supports constraint enforcement — `payments:initiate:max_500` limits payments to $500.

```typescript
import { StripeAdapter } from '@grantex/adapters';

const stripe = new StripeAdapter({ jwksUri, credentials: process.env.STRIPE_SECRET_KEY! });

// List payment intents (requires payments:read)
await stripe.listPaymentIntents(token, { limit: 10 });

// Create payment intent (requires payments:initiate)
// If grant has payments:initiate:max_500, amount must be <= $500 (50000 cents)
await stripe.createPaymentIntent(token, {
  amount: 10000, // $100 in cents
  currency: 'usd',
});
```

### Slack

Requires scopes: `notifications:send`, `notifications:read`

```typescript
import { SlackAdapter } from '@grantex/adapters';

const slack = new SlackAdapter({ jwksUri, credentials: process.env.SLACK_BOT_TOKEN! });

// Send message (requires notifications:send)
await slack.sendMessage(token, { channel: 'C123ABC', text: 'Hello from agent!' });

// List messages (requires notifications:read)
await slack.listMessages(token, { channel: 'C123ABC', limit: 20 });
```

## Configuration

```typescript
interface AdapterConfig {
  jwksUri: string;             // JWKS endpoint for offline token verification
  credentials: CredentialProvider; // API key/token (string or async function)
  auditLogger?: AuditLogger;   // Optional audit logging callback
  clockTolerance?: number;     // JWT clock skew tolerance in seconds
  timeout?: number;            // Upstream request timeout in ms (default: 30000)
}
```

### Dynamic Credentials

```typescript
const calendar = new GoogleCalendarAdapter({
  jwksUri,
  credentials: async () => {
    // Fetch a fresh access token from your token store
    return await refreshGoogleToken(serviceAccountId);
  },
});
```

### Audit Logging

```typescript
import { Grantex } from '@grantex/sdk';

const grantex = new Grantex({ apiKey, baseUrl });

const stripe = new StripeAdapter({
  jwksUri,
  credentials: stripeKey,
  auditLogger: (params) => grantex.audit.log(params),
});
```

## Constraint Enforcement

Scopes can include constraints like `payments:initiate:max_500`:

| Constraint | Meaning | Example |
|-----------|---------|---------|
| `max_N` | Value must be <= N | `payments:initiate:max_500` — max $500 |
| `min_N` | Value must be >= N | `payments:initiate:min_10` — min $10 |
| `limit_N` | Count must be <= N | `api:calls:limit_1000` — max 1000 calls |

## Error Handling

All adapters throw `GrantexAdapterError` with typed error codes:

| Code | Meaning |
|------|---------|
| `TOKEN_INVALID` | Grant token verification failed |
| `SCOPE_MISSING` | Grant doesn't include required scope |
| `CONSTRAINT_VIOLATED` | Value exceeds scope constraint |
| `UPSTREAM_ERROR` | Upstream API returned an error |
| `CREDENTIAL_ERROR` | Failed to resolve credentials |

```typescript
import { GrantexAdapterError } from '@grantex/adapters';

try {
  await stripe.createPaymentIntent(token, { amount: 100000, currency: 'usd' });
} catch (err) {
  if (err instanceof GrantexAdapterError) {
    console.error(err.code, err.message);
  }
}
```

## Custom Adapters

Extend `BaseAdapter` to build your own:

```typescript
import { BaseAdapter } from '@grantex/adapters';
import type { AdapterConfig, AdapterResult } from '@grantex/adapters';

class MyApiAdapter extends BaseAdapter {
  constructor(config: AdapterConfig) {
    super(config);
  }

  async getData(token: string): Promise<AdapterResult> {
    const { grant } = await this.verifyAndCheckScope(token, 'myapi:read');
    const credential = await this.resolveCredential();

    const data = await this.callUpstream('https://api.myservice.com/data', {
      method: 'GET',
      headers: { Authorization: `Bearer ${credential}` },
    });

    await this.logAudit(grant, 'myapi:getData', 'success');
    return this.wrapResult(grant, data);
  }
}
```

## Requirements

- Node.js 18+
- `@grantex/sdk` >= 0.1.0

## License

Apache-2.0
