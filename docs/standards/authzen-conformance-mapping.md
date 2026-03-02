# OpenID AuthZEN Conformance Mapping

**Date:** 2026-03-02
**Author:** Sanjeev Kumar (mishra.sanjeev@gmail.com)
**Status:** Informational

## Overview

This document maps the Grantex Delegated Agent Authorization Protocol (DAAP) policy evaluation context to the OpenID AuthZEN Authorization API 1.0 subject/resource/action/context model. AuthZEN defines a standard interface for Policy Decision Points (PDPs), and this mapping demonstrates how DAAP's authorization requests can be evaluated by any AuthZEN-compliant PDP.

## AuthZEN Evaluation API

The AuthZEN Authorization API defines a single evaluation endpoint:

```
POST /access/v1/evaluation
Content-Type: application/json

{
  "subject": { ... },
  "resource": { ... },
  "action": { ... },
  "context": { ... }
}
```

Response:

```json
{
  "decision": true
}
```

## Mapping: DAAP PolicyEvalContext to AuthZEN

### Subject

The AuthZEN `subject` represents the entity requesting access. In DAAP, this is the Agent acting on behalf of a Principal.

| AuthZEN Field | DAAP Source | Example |
|---------------|------------|---------|
| `subject.type` | Constant | `"agent"` |
| `subject.id` | Agent DID | `"did:grantex:ag_01HXYZ123abc"` |
| `subject.properties.developer` | Developer ID | `"org_yourcompany"` |
| `subject.properties.principalId` | Principal ID (the human) | `"user_abc123"` |
| `subject.properties.delegationDepth` | Delegation depth | `0` |

**Mapping:**

```json
{
  "subject": {
    "type": "agent",
    "id": "did:grantex:ag_01HXYZ123abc",
    "properties": {
      "developer": "org_yourcompany",
      "principalId": "user_abc123",
      "delegationDepth": 0
    }
  }
}
```

### Resource

The AuthZEN `resource` represents the thing being accessed. In DAAP, this is the set of scopes being requested.

| AuthZEN Field | DAAP Source | Example |
|---------------|------------|---------|
| `resource.type` | Constant | `"grant"` |
| `resource.id` | Grant ID (if exists) | `"grnt_01HXYZ..."` |
| `resource.properties.scopes` | Requested scopes | `["calendar:read", "payments:initiate:max_500"]` |
| `resource.properties.expiresIn` | Requested TTL | `"24h"` |

**Mapping:**

```json
{
  "resource": {
    "type": "grant",
    "id": "grnt_01HXYZ...",
    "properties": {
      "scopes": ["calendar:read", "payments:initiate:max_500"],
      "expiresIn": "24h"
    }
  }
}
```

### Action

The AuthZEN `action` represents the operation being performed.

| AuthZEN Field | DAAP Source | Example |
|---------------|------------|---------|
| `action.name` | Authorization action type | `"authorize"`, `"delegate"`, `"verify"` |

**Mapping:**

```json
{
  "action": {
    "name": "authorize"
  }
}
```

DAAP defines the following action names for AuthZEN evaluation:

| Action | When Evaluated |
|--------|---------------|
| `authorize` | Authorization request (`POST /v1/authorize`) |
| `delegate` | Delegation request (`POST /v1/grants/delegate`) |
| `verify` | Token verification (`POST /v1/tokens/verify`) |
| `debit` | Budget debit (`POST /v1/budget/debit`) |

### Context

The AuthZEN `context` carries environmental attributes.

| AuthZEN Field | DAAP Source | Example |
|---------------|------------|---------|
| `context.timestamp` | Request time | `"2026-02-01T12:00:00Z"` |
| `context.ipAddress` | Client IP | `"203.0.113.42"` |
| `context.budget.remaining` | Budget remaining (if applicable) | `5000` |
| `context.budget.requested` | Debit amount (if applicable) | `250` |

**Mapping:**

```json
{
  "context": {
    "timestamp": "2026-02-01T12:00:00Z",
    "ipAddress": "203.0.113.42",
    "budget": {
      "remaining": 5000,
      "requested": 250
    }
  }
}
```

## Complete Example

### DAAP Authorization Request

```http
POST /v1/authorize
Authorization: Bearer <api_key>

{
  "agentId": "ag_01HXYZ123abc",
  "principalId": "user_abc123",
  "scopes": ["calendar:read", "payments:initiate:max_500"],
  "expiresIn": "24h"
}
```

### Translated AuthZEN Evaluation Request

```json
{
  "subject": {
    "type": "agent",
    "id": "did:grantex:ag_01HXYZ123abc",
    "properties": {
      "developer": "org_yourcompany",
      "principalId": "user_abc123",
      "delegationDepth": 0
    }
  },
  "resource": {
    "type": "grant",
    "properties": {
      "scopes": ["calendar:read", "payments:initiate:max_500"],
      "expiresIn": "24h"
    }
  },
  "action": {
    "name": "authorize"
  },
  "context": {
    "timestamp": "2026-02-01T12:00:00Z",
    "ipAddress": "203.0.113.42"
  }
}
```

### AuthZEN Response

```json
{
  "decision": true
}
```

## Scope-to-Permission Mapping

AuthZEN PDPs that use permission-based models can map DAAP scopes to permissions:

| DAAP Scope | AuthZEN Permission | Resource Type |
|------------|-------------------|---------------|
| `calendar:read` | `read` | `Calendar` |
| `calendar:write` | `write` | `Calendar` |
| `email:send` | `send` | `Email` |
| `payments:initiate` | `initiate` | `Payment` |
| `payments:initiate:max_500` | `initiate` | `Payment` (with constraint `max_amount=500`) |

## Implementation Notes

1. **Translation layer**: The DAAP authorization server translates its internal `PolicyEvalContext` to the AuthZEN format before calling the external PDP. This translation is implemented in the `lib/policy-backends/` module.

2. **Response mapping**: AuthZEN returns `{ "decision": true/false }`. DAAP maps `true` to `auto_approve` and `false` to `auto_deny`.

3. **Context enrichment**: The authorization server enriches the context with data not present in the original request (e.g., agent registration metadata, historical anomaly count).

4. **Timeout handling**: If the AuthZEN PDP does not respond within 5 seconds, the DAAP server applies its configured fallback policy (default: `deny`).
