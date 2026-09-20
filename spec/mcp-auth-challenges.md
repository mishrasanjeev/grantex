# `@grantex/mcp-auth` resource-server challenges

Status: draft for `@grantex/mcp-auth` 3.0 (unreleased). This note fixes the
wire format an MCP server protected by `requireMcpAuth` uses to refuse a
request, so clients and later Grantex features (decision grants, PRD G-3)
can rely on it.

All challenges use the `Bearer` scheme of RFC 6750 §3. Parameter values are
RFC 7230 quoted strings: `"` and `\` are backslash-escaped and control
characters are replaced by spaces. Every challenge carries `resource_metadata`
(RFC 9728 §5.1) when the server knows its metadata URL — by default the
path-inserted well-known URL of its single configured audience.

## 401 — no token, or a token that cannot be used

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"
```

Without credentials the challenge has no `error` (RFC 6750 §3.1). A token that
is malformed, expired, revoked, signed by another issuer or issued for another
audience gets `error="invalid_token"` and an `error_description`.

## 403 — a scope or tool the grant does not cover

```http
HTTP/1.1 403 Forbidden
WWW-Authenticate: Bearer error="insufficient_scope", scope="tool:acme_kyb:write",
  resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
  error_description="Tool \"monitor_enroll\" is not granted: it needs tool:acme_kyb:write"
Content-Type: application/json

{"error":"insufficient_scope","reason":"tool_not_granted","tool":"monitor_enroll",
 "required_scopes":["tool:acme_kyb:write"],"error_description":"..."}
```

`scope` lists every scope the refused operation needs, in one challenge, as
the MCP authorization specification asks. A `tools/call` naming a tool that no
manifest declares is refused the same way with `reason":"manifest_unknown_tool"`
and no `scope` (no grant can cover it). In a JSON-RPC batch, one refused call
refuses the whole request.

## 400 — a body the guard cannot read

With tool enforcement, a request that can carry messages must reach the
guard as parsed JSON-RPC 2.0: an object, or a non-empty array whose every
element is a message (`"jsonrpc": "2.0"` with a string `method`, or a
response with `id` and `result` or `error`). A string, a Buffer, `{}`, `[]`
or any other shape is refused with 400 and
`{"error":"invalid_request","reason":"body_not_parsed"}` (also reported to
`onDenial`), so a handler that parses the raw body
itself can never see a tool call the guard did not check.

## 403 — `decision_required`

A tool whose manifest entry has `"requires_decision": true` also needs a
decision grant: a second credential a named person mints for one semantic
action (PRD G-3). When the request does not carry a valid one:

```http
HTTP/1.1 403 Forbidden
WWW-Authenticate: Bearer error="insufficient_authorization",
  decision_required="acme_kyb:case_decision",
  resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
  error_description="Tool \"case_decision\" requires a decision grant approved by a person"
Content-Type: application/json

{"error":"insufficient_authorization","reason":"decision_required","tool":"case_decision",
 "error_description":"..."}
```

| Parameter | Required | Meaning |
|---|---|---|
| `error` | yes | Always `insufficient_authorization`. |
| `decision_required` | yes | The action a person must approve: `<connector>:<tool>` from the manifest, or `<tool>` when the tool has no connector. |
| `resource_metadata` | when known | RFC 9728 metadata URL of the MCP server. |
| `decision_uri` | no | Where a client can ask for the decision (for example an approvals console). Emitted only when the server is configured with one. |
| `error_description` | yes | Human-readable text. Not for machine use. |

When a decision grant is presented but is not valid for the call, the header
is the same (a new decision is still needed) and the body says why:
`"reason":"decision_invalid"` with `"sub_reason"` one of `action_mismatch`,
`expired`, `consumed`, `same_approver` (PRD Appendix B), the further
decision-grant sub-reasons of `spec/decision-grant.md` (`case_changed`,
`wrong_case`, `four_eyes_incomplete`, `malformed`, `revoked`,
`unknown_grant`, `consume_unavailable`) or `verification_failed` when the
verifier itself failed. Scope is checked
first: a tool the grant does not cover is `tool_not_granted`, never
`decision_required`.

A client that receives `decision_required` must not retry automatically; it
should surface the action to a person, obtain a decision grant through the
deployment's approval flow and retry once with it. The reference verifier (`grantexDecisionVerifier`) reads the decision
grant from the `grantex-decision-grant` request header (two comma-separated
grants for four eyes), as the decision-grant profile describes; the
package passes the request's headers and the call's `arguments` to the
configured `DecisionVerifier` so that profile can be implemented without
changing this format.

## Extension points in the package

- `toolPolicyFromManifests(manifests)` accepts manifest JSON in the 0.5
  (permission string) and 0.6 (tool object) forms and derives, per tool, the
  required scope `tool:<connector>:<permission>` (permission hierarchy
  `admin > delete > write > read`) and `requiresDecision`.
- `DecisionVerifier.verify({ grant, requirement, arguments, header })`
  returns `{ status: 'valid' }`, `{ status: 'absent' }` or
  `{ status: 'invalid', subReason }`. With no verifier configured, every call
  to a `requires_decision` tool is refused with `decision_required`. A
  verifier that returns `valid` must consume the decision grant (its `jti`)
  atomically first, so one grant never authorises two calls. A JSON-RPC
  batch containing more than one call that needs a decision is refused with
  `reason: "decision_invalid"`, `sub_reason: "multiple_decisions_in_batch"`
  before any verifier runs.
- `decisionRequiredChallenge({ tool, connector, resourceMetadataUrl, decisionUri, description })`
  builds the header above for servers that do not use the middleware.
