# @grantex/sdk

TypeScript SDK for the [Grantex](https://grantex.dev) delegated authorization protocol — OAuth 2.0 for AI agents.

[![npm version](https://img.shields.io/npm/v/@grantex/sdk)](https://www.npmjs.com/package/@grantex/sdk)
[![License](https://img.shields.io/npm/l/@grantex/sdk)](https://github.com/mishrasanjeev/grantex/blob/main/LICENSE)

## Installation

```bash
npm install @grantex/sdk
```

## Quick Start

```typescript
import { Grantex } from '@grantex/sdk';

const grantex = new Grantex({ apiKey: 'YOUR_API_KEY' });

// 1. Register an agent
const agent = await grantex.agents.register({
  name: 'Email Assistant',
  description: 'Reads and sends email on behalf of users',
  scopes: ['email:read', 'email:send'],
});

// 2. Request authorization
const { consentUrl } = await grantex.authorize({
  agentId: agent.id,
  userId: 'usr_01J...',
  scopes: ['email:read', 'email:send'],
});
// Redirect the user to consentUrl — they approve in plain language

// 3. Verify a grant token (offline, no network call)
import { verifyGrantToken } from '@grantex/sdk';

const grant = await verifyGrantToken(token, {
  jwksUri: 'https://api.grantex.dev/.well-known/jwks.json',
});
console.log(grant.scopes);       // ['email:read', 'email:send']
console.log(grant.principalId);  // 'usr_01J...'

// 4. Revoke when done
await grantex.tokens.revoke(grant.tokenId);
```

## Configuration

```typescript
const grantex = new Grantex({
  apiKey: 'gx_....',              // or set GRANTEX_API_KEY env var
  baseUrl: 'https://api.grantex.dev', // default
  timeout: 30000,                 // request timeout in ms (default: 30s)
});
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiKey` | `string` | `process.env.GRANTEX_API_KEY` | API key for authentication |
| `baseUrl` | `string` | `https://api.grantex.dev` | Base URL of the Grantex API |
| `timeout` | `number` | `30000` | Request timeout in milliseconds |

## API Reference

### Authorization

#### `grantex.authorize(params)`

Initiate the delegated authorization flow. Returns a consent URL to redirect the user to.

```typescript
const request = await grantex.authorize({
  agentId: 'ag_01J...',
  userId: 'usr_01J...',
  scopes: ['files:read', 'email:send'],
  expiresIn: '24h',          // optional
  redirectUri: 'https://...' // optional
});

console.log(request.consentUrl);     // redirect user here
console.log(request.authRequestId);  // track the request
console.log(request.expiresAt);      // ISO 8601 timestamp
```

**Returns**: `AuthorizationRequest`

| Field | Type | Description |
|-------|------|-------------|
| `authRequestId` | `string` | Unique ID for this authorization request |
| `consentUrl` | `string` | URL to redirect the user to for consent |
| `agentId` | `string` | The agent requesting authorization |
| `principalId` | `string` | The user being asked for consent |
| `scopes` | `string[]` | Requested scopes |
| `expiresAt` | `string` | When the request expires (ISO 8601) |
| `status` | `string` | `'pending'`, `'approved'`, `'denied'`, or `'expired'` |

---

### Agents

#### `grantex.agents.register(params)`

Register a new AI agent.

```typescript
const agent = await grantex.agents.register({
  name: 'Code Review Bot',
  description: 'Reviews pull requests and suggests improvements',
  scopes: ['repo:read', 'pr:comment'],
});
```

#### `grantex.agents.get(agentId)`

```typescript
const agent = await grantex.agents.get('ag_01J...');
```

#### `grantex.agents.list()`

```typescript
const { agents, total } = await grantex.agents.list();
```

#### `grantex.agents.update(agentId, params)`

```typescript
const agent = await grantex.agents.update('ag_01J...', {
  name: 'Updated Name',
  scopes: ['repo:read', 'pr:comment', 'pr:approve'],
});
```

#### `grantex.agents.delete(agentId)`

```typescript
await grantex.agents.delete('ag_01J...');
```

---

### Grants

#### `grantex.grants.get(grantId)`

```typescript
const grant = await grantex.grants.get('grnt_01J...');
```

#### `grantex.grants.list(params?)`

```typescript
const { grants, total } = await grantex.grants.list({
  agentId: 'ag_01J...',       // optional filter
  principalId: 'usr_01J...',  // optional filter
  status: 'active',           // 'active' | 'revoked' | 'expired'
  page: 1,
  pageSize: 20,
});
```

#### `grantex.grants.revoke(grantId)`

```typescript
await grantex.grants.revoke('grnt_01J...');
```

#### `grantex.grants.delegate(params)`

Create a delegated sub-agent grant (per [SPEC Section 9](https://github.com/mishrasanjeev/grantex/blob/main/SPEC.md)).

```typescript
const delegation = await grantex.grants.delegate({
  parentGrantToken: 'eyJhbG...',
  subAgentId: 'ag_02K...',
  scopes: ['files:read'],         // must be subset of parent scopes
  expiresIn: '1h',                // optional, cannot exceed parent
});

console.log(delegation.grantToken); // new JWT for the sub-agent
console.log(delegation.grantId);
```

#### `grantex.grants.verify(token)`

Verify a grant token via the API (online verification with real-time revocation check).

```typescript
const verified = await grantex.grants.verify('eyJhbG...');
console.log(verified.principalId);
console.log(verified.scopes);
```

---

### Tokens

#### `grantex.tokens.verify(token)`

Online token verification with revocation status.

```typescript
const result = await grantex.tokens.verify('eyJhbG...');
if (result.valid) {
  console.log(result.scopes);     // ['files:read']
  console.log(result.principal);  // 'usr_01J...'
  console.log(result.agent);      // 'ag_01J...'
  console.log(result.grantId);
  console.log(result.expiresAt);
}
```

#### `grantex.tokens.revoke(tokenId)`

Revoke a token by its JTI. Blocklisted in Redis immediately; all sub-delegated tokens are also invalidated.

```typescript
await grantex.tokens.revoke('tok_01J...');
```

---

### Offline Token Verification

#### `verifyGrantToken(token, options)`

Verify a grant token offline using the published JWKS. No API call needed — signature is verified locally using RS256.

```typescript
import { verifyGrantToken } from '@grantex/sdk';

const grant = await verifyGrantToken('eyJhbG...', {
  jwksUri: 'https://api.grantex.dev/.well-known/jwks.json',
  requiredScopes: ['files:read'],   // optional — rejects if missing
  audience: 'https://myapp.com',    // optional — validates aud claim
});
```

**Returns**: `VerifiedGrant`

| Field | Type | Description |
|-------|------|-------------|
| `tokenId` | `string` | Unique token ID (JWT `jti` claim) |
| `grantId` | `string` | Grant record ID |
| `principalId` | `string` | User who authorized the grant (`sub` claim) |
| `agentDid` | `string` | Agent's DID (`agt` claim) |
| `developerId` | `string` | Developer org ID (`dev` claim) |
| `scopes` | `string[]` | Granted scopes (`scp` claim) |
| `issuedAt` | `number` | Issued-at timestamp (seconds since epoch) |
| `expiresAt` | `number` | Expiry timestamp (seconds since epoch) |
| `parentAgentDid` | `string?` | Parent agent DID (delegation only) |
| `parentGrantId` | `string?` | Parent grant ID (delegation only) |
| `delegationDepth` | `number?` | Delegation depth (0 = root) |

---

### Audit

#### `grantex.audit.log(params)`

Log an auditable action taken by an agent.

```typescript
const entry = await grantex.audit.log({
  agentId: 'ag_01J...',
  grantId: 'grnt_01J...',
  action: 'email:send',
  metadata: { to: 'user@example.com', subject: 'Hello' },
  status: 'success',   // 'success' | 'failure' | 'blocked'
});
```

#### `grantex.audit.list(params?)`

```typescript
const { entries, total } = await grantex.audit.list({
  agentId: 'ag_01J...',
  action: 'email:send',
  since: '2026-01-01T00:00:00Z',
  until: '2026-02-28T23:59:59Z',
  page: 1,
  pageSize: 50,
});
```

#### `grantex.audit.get(entryId)`

```typescript
const entry = await grantex.audit.get('aud_01J...');
console.log(entry.hash);      // SHA-256 hash for tamper evidence
console.log(entry.prevHash);   // previous entry hash (chain integrity)
```

---

### Webhooks

#### `grantex.webhooks.create(params)`

```typescript
const webhook = await grantex.webhooks.create({
  url: 'https://myapp.com/webhooks/grantex',
  events: ['grant.created', 'grant.revoked', 'token.issued'],
});
console.log(webhook.secret); // HMAC secret for signature verification
```

#### `grantex.webhooks.list()`

```typescript
const { webhooks } = await grantex.webhooks.list();
```

#### `grantex.webhooks.delete(webhookId)`

```typescript
await grantex.webhooks.delete('wh_01J...');
```

#### Webhook Signature Verification

```typescript
import { verifyWebhookSignature } from '@grantex/sdk';

// In your webhook handler
verifyWebhookSignature(requestBody, signatureHeader, webhookSecret);
```

---

### Policies

Define fine-grained access control rules for agents.

#### `grantex.policies.create(params)`

```typescript
const policy = await grantex.policies.create({
  name: 'Block after hours',
  effect: 'deny',
  priority: 10,
  scopes: ['email:send'],
  timeOfDayStart: '18:00',
  timeOfDayEnd: '08:00',
});
```

#### `grantex.policies.list()`

```typescript
const { policies, total } = await grantex.policies.list();
```

#### `grantex.policies.get(policyId)` / `update(policyId, params)` / `delete(policyId)`

```typescript
const policy = await grantex.policies.get('pol_01J...');

await grantex.policies.update('pol_01J...', { effect: 'allow' });

await grantex.policies.delete('pol_01J...');
```

---

### Compliance

#### `grantex.compliance.getSummary(params?)`

```typescript
const summary = await grantex.compliance.getSummary({
  since: '2026-01-01T00:00:00Z',
  until: '2026-02-28T23:59:59Z',
});
console.log(summary.agents);        // { total, active, suspended, revoked }
console.log(summary.grants);        // { total, active, revoked, expired }
console.log(summary.auditEntries);  // { total, success, failure, blocked }
```

#### `grantex.compliance.exportGrants(params?)`

```typescript
const { grants, total } = await grantex.compliance.exportGrants({
  status: 'active',
});
```

#### `grantex.compliance.exportAudit(params?)`

```typescript
const { entries, total } = await grantex.compliance.exportAudit({
  since: '2026-01-01T00:00:00Z',
  agentId: 'ag_01J...',
});
```

#### `grantex.compliance.evidencePack(params?)`

Generate a full SOC 2 / GDPR evidence pack with audit chain integrity verification.

```typescript
const pack = await grantex.compliance.evidencePack({
  framework: 'soc2',   // 'soc2' | 'gdpr' | 'all'
  since: '2026-01-01T00:00:00Z',
});

console.log(pack.chainIntegrity.valid);          // true
console.log(pack.chainIntegrity.checkedEntries);  // 1042
console.log(pack.summary);
console.log(pack.grants);
console.log(pack.auditEntries);
console.log(pack.policies);
```

---

### Anomaly Detection

#### `grantex.anomalies.detect()`

Run anomaly detection across all agents.

```typescript
const { anomalies, total } = await grantex.anomalies.detect();
// anomaly types: 'rate_spike' | 'high_failure_rate' | 'new_principal' | 'off_hours_activity'
```

#### `grantex.anomalies.list(params?)`

```typescript
const { anomalies } = await grantex.anomalies.list({
  unacknowledged: true,  // only open anomalies
});
```

#### `grantex.anomalies.acknowledge(anomalyId)`

```typescript
const anomaly = await grantex.anomalies.acknowledge('anom_01J...');
```

---

### Billing

#### `grantex.billing.getSubscription()`

```typescript
const sub = await grantex.billing.getSubscription();
console.log(sub.plan);             // 'free' | 'pro' | 'enterprise'
console.log(sub.status);           // 'active' | 'past_due' | 'canceled'
console.log(sub.currentPeriodEnd); // ISO 8601 or null
```

#### `grantex.billing.createCheckout(params)`

```typescript
const { checkoutUrl } = await grantex.billing.createCheckout({
  plan: 'pro',
  successUrl: 'https://myapp.com/billing/success',
  cancelUrl: 'https://myapp.com/billing/cancel',
});
// Redirect user to checkoutUrl
```

#### `grantex.billing.createPortal(params)`

```typescript
const { portalUrl } = await grantex.billing.createPortal({
  returnUrl: 'https://myapp.com/settings',
});
```

---

### SCIM 2.0 Provisioning

Sync users from your identity provider.

#### Token Management

```typescript
// Create a SCIM bearer token
const { token, id, label } = await grantex.scim.createToken({
  label: 'Okta SCIM integration',
});
// token is returned once — store it securely

const { tokens } = await grantex.scim.listTokens();

await grantex.scim.revokeToken('scimtok_01J...');
```

#### User Operations

```typescript
// List provisioned users
const { Resources, totalResults } = await grantex.scim.listUsers({
  startIndex: 1,
  count: 100,
});

// Create a user
const user = await grantex.scim.createUser({
  userName: 'alice@example.com',
  displayName: 'Alice',
  emails: [{ value: 'alice@example.com', primary: true }],
});

// Get / Replace / Patch / Delete
const user = await grantex.scim.getUser('scimusr_01J...');

await grantex.scim.replaceUser('scimusr_01J...', { userName: 'alice@new.com' });

await grantex.scim.updateUser('scimusr_01J...', [
  { op: 'replace', path: 'active', value: false },
]);

await grantex.scim.deleteUser('scimusr_01J...');
```

---

### SSO (OIDC)

#### `grantex.sso.createConfig(params)`

```typescript
const config = await grantex.sso.createConfig({
  issuerUrl: 'https://accounts.google.com',
  clientId: 'xxx.apps.googleusercontent.com',
  clientSecret: 'GOCSPX-...',
  redirectUri: 'https://myapp.com/auth/callback',
});
```

#### `grantex.sso.getConfig()` / `deleteConfig()`

```typescript
const config = await grantex.sso.getConfig();
await grantex.sso.deleteConfig();
```

#### `grantex.sso.getLoginUrl(org)`

```typescript
const { authorizeUrl } = await grantex.sso.getLoginUrl('dev_01J...');
// Redirect user to authorizeUrl
```

#### `grantex.sso.handleCallback(code, state)`

```typescript
const { email, name, sub, developerId } = await grantex.sso.handleCallback(code, state);
```

---

## Error Handling

All errors extend `GrantexError`:

```typescript
import {
  GrantexError,          // base class
  GrantexApiError,       // API returned an error (has statusCode, body, requestId)
  GrantexAuthError,      // 401/403 — invalid or missing API key
  GrantexTokenError,     // token verification failed (invalid signature, expired, etc.)
  GrantexNetworkError,   // network failure (timeout, DNS, connection refused)
} from '@grantex/sdk';

try {
  await grantex.agents.get('ag_invalid');
} catch (err) {
  if (err instanceof GrantexAuthError) {
    console.error('Auth failed:', err.statusCode);     // 401 or 403
    console.error('Request ID:', err.requestId);
  } else if (err instanceof GrantexApiError) {
    console.error('API error:', err.statusCode, err.body);
  } else if (err instanceof GrantexNetworkError) {
    console.error('Network error:', err.message, err.cause);
  }
}
```

---

## Requirements

- Node.js 18+
- ESM (`"type": "module"` in your package.json, or use dynamic `import()`)

## Links

- [GitHub](https://github.com/mishrasanjeev/grantex)
- [Protocol Specification](https://github.com/mishrasanjeev/grantex/blob/main/SPEC.md)
- [Python SDK](https://pypi.org/project/grantex/)
- [API Reference](https://api.grantex.dev/.well-known/jwks.json)

## License

[Apache 2.0](https://github.com/mishrasanjeev/grantex/blob/main/LICENSE)
