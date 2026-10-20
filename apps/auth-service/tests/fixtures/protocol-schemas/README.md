# Saved protocol schemas (test fixtures)

JSON Schemas copied from the public protocol repositories, used by the tests to
validate the shapes Grantex renders. Only the files reachable by `$ref` from the
schemas the tests use are kept; content is unchanged apart from JSON
reformatting and one `$id`: the 2026-04-08 `discovery/profile_schema.json`
declares `https://ucp.dev/schemas/discovery/profile.json` but sits at
`source/discovery/` and references `../schemas/ucp.json`, so its `$id` here is
`https://ucp.dev/discovery/profile.json`, which makes that reference resolve
as it does in the source tree.

| Directory | Source | Pinned at | License |
|---|---|---|---|
| `ucp-2026-04-08/` | `github.com/Universal-Commerce-Protocol/ucp`, branch `release/2026-04-08`, `source/` | `0f06734b8946` | Apache-2.0 |
| `ucp-2026-08-25/` | same repository, branch `release/2026-08-25`, `source/` | `cb60c888e50b` | Apache-2.0 |
| `acp-2026-04-17/` | `github.com/agentic-commerce-protocol/agentic-commerce-protocol`, `spec/2026-04-17/json-schema/` | `7fdd78df677a` | Apache-2.0 |

`acp-2026-04-17/webhook-event.schema.json` is the `WebhookEvent` /
`EventDataOrder` pair of `spec/2026-04-17/openapi/openapi.agentic_checkout_webhook.yaml`
written as JSON Schema, with its `Order` reference pointed at
`schema.agentic_checkout.json#/$defs/Order` (the same schema the OpenAPI file
references).

Refresh by copying the same files from a newer pin and re-running the tests.
