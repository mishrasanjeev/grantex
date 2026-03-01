# grantex_webhook (Resource)

Manages a Grantex webhook. Webhooks deliver real-time event notifications to your application via HTTP POST requests, signed with HMAC-SHA256.

## Example Usage

```hcl
resource "grantex_webhook" "grant_events" {
  url    = "https://example.com/webhooks/grantex"
  events = ["grant.created", "grant.revoked", "token.used"]
  secret = var.webhook_secret
}
```

## Schema

### Required

- `url` (String) - The URL to deliver webhook events to.
- `events` (List of String) - The list of event types to subscribe to (e.g., `"grant.created"`, `"grant.revoked"`, `"token.used"`).

### Optional

- `secret` (String, Sensitive) - The secret used to sign webhook payloads for HMAC-SHA256 verification.

### Read-Only

- `id` (String) - The unique identifier for the webhook.
- `created_at` (String) - The timestamp when the webhook was created.

## Import

Webhooks can be imported using the webhook ID:

```shell
terraform import grantex_webhook.grant_events <webhook_id>
```
