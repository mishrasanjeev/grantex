# Webhooks

Grantex can POST a signed JSON payload to your server whenever key events occur — grant created, grant revoked, or token issued. Use webhooks to keep your application in sync with the authorization lifecycle without polling.

---

## Supported Events

| Event | When it fires |
|-------|---------------|
| `grant.created` | A new grant is issued (user completes consent flow) |
| `grant.revoked` | A grant is revoked (root or cascade) |
| `token.issued`  | A token is issued (same moment as `grant.created` for initial exchange) |

---

## Registering an Endpoint

```bash
curl -X POST https://api.grantex.dev/v1/webhooks \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://your-app.com/webhooks/grantex",
    "events": ["grant.created", "grant.revoked"]
  }'
```

**Response:**

```json
{
  "id": "wh_01JXYZ...",
  "url": "https://your-app.com/webhooks/grantex",
  "events": ["grant.created", "grant.revoked"],
  "secret": "a3f8c2...",
  "createdAt": "2026-02-26T12:00:00Z"
}
```

> **Important:** The `secret` is returned only once. Store it securely — you will need it to verify incoming payloads.

---

## Event Payload Shape

Every webhook POST has the same envelope:

```json
{
  "id": "evt_01JXYZ...",
  "type": "grant.created",
  "createdAt": "2026-02-26T12:00:00Z",
  "data": { ... }
}
```

### `grant.created`

```json
{
  "grantId": "grnt_01...",
  "agentId": "ag_01...",
  "principalId": "user-123",
  "scopes": ["calendar:read"],
  "expiresAt": "2026-03-26T12:00:00Z"
}
```

### `grant.revoked`

```json
{
  "grantId": "grnt_01...",
  "cascade": true
}
```

`cascade: true` means descendant grants were also revoked.

### `token.issued`

```json
{
  "tokenId": "tok_01...",
  "grantId": "grnt_01...",
  "agentId": "ag_01...",
  "principalId": "user-123",
  "scopes": ["calendar:read"],
  "expiresAt": "2026-03-26T12:00:00Z"
}
```

---

## Verifying Signatures

Every request includes an `X-Grantex-Signature` header with a hex-encoded HMAC-SHA256 signature of the raw request body:

```
X-Grantex-Signature: sha256=<hex>
```

**TypeScript:**

```typescript
import { verifyWebhookSignature } from '@grantex/sdk';

app.post('/webhooks/grantex', (req, res) => {
  const sig = req.headers['x-grantex-signature'] as string;
  const rawBody = req.rawBody; // must be the raw string/Buffer, not parsed JSON

  if (!verifyWebhookSignature(rawBody, sig, process.env.GRANTEX_WEBHOOK_SECRET!)) {
    return res.status(401).send('Invalid signature');
  }

  const event = JSON.parse(rawBody);
  console.log('Received event:', event.type);
  res.status(200).send();
});
```

**Python:**

```python
from grantex import verify_webhook_signature
import os

@app.route('/webhooks/grantex', methods=['POST'])
def handle_webhook():
    sig = request.headers.get('X-Grantex-Signature', '')
    raw_body = request.get_data(as_text=True)

    if not verify_webhook_signature(raw_body, sig, os.environ['GRANTEX_WEBHOOK_SECRET']):
        return 'Invalid signature', 401

    event = request.get_json()
    print('Received event:', event['type'])
    return '', 200
```

> Always verify signatures before trusting the payload. Use the raw request body — not the parsed JSON.

---

## Managing Endpoints

**List registered webhooks:**

```bash
curl https://api.grantex.dev/v1/webhooks \
  -H "Authorization: Bearer <your-api-key>"
```

**Delete a webhook:**

```bash
curl -X DELETE https://api.grantex.dev/v1/webhooks/<webhook-id> \
  -H "Authorization: Bearer <your-api-key>"
```

---

## SDK Usage

**TypeScript:**

```typescript
import { Grantex } from '@grantex/sdk';

const grantex = new Grantex({ apiKey: process.env.GRANTEX_API_KEY });

// Register
const endpoint = await grantex.webhooks.create({
  url: 'https://your-app.com/webhooks/grantex',
  events: ['grant.created', 'grant.revoked', 'token.issued'],
});
console.log('Webhook secret:', endpoint.secret); // save this!

// List
const { webhooks } = await grantex.webhooks.list();

// Delete
await grantex.webhooks.delete(endpoint.id);
```

**Python:**

```python
from grantex import Grantex

grantex = Grantex(api_key=os.environ['GRANTEX_API_KEY'])

# Register
endpoint = grantex.webhooks.create(
    url='https://your-app.com/webhooks/grantex',
    events=['grant.created', 'grant.revoked', 'token.issued'],
)
print('Webhook secret:', endpoint.secret)  # save this!

# List
result = grantex.webhooks.list()

# Delete
grantex.webhooks.delete(endpoint.id)
```

---

## Delivery Behaviour

- Grantex delivers webhooks with a **10-second timeout** per request.
- Delivery is **best-effort** — if your endpoint is unreachable, the event is not retried in the current version.
- Your endpoint should return **any 2xx status** to be considered successful.
- Respond quickly (under 5s) and do heavy processing asynchronously.

---

## Local Development

Use a tunnel tool to expose your local server:

```bash
# ngrok
ngrok http 3000

# then register the tunnel URL
curl -X POST http://localhost:3001/v1/webhooks \
  -H "Authorization: Bearer dev-api-key-local" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://<your-ngrok-id>.ngrok.io/webhooks","events":["grant.created"]}'
```
