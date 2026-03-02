# AuthZEN PDP Evaluation API Alignment

**Date:** 2026-03-02
**Author:** Sanjeev Kumar (mishra.sanjeev@gmail.com)
**Status:** Informational

## Overview

This document describes how the Grantex external policy backends (OPA and Cedar) align with the OpenID AuthZEN PDP Evaluation API. AuthZEN standardizes the interface between Policy Enforcement Points (PEPs) and Policy Decision Points (PDPs). Grantex acts as the PEP, and OPA/Cedar instances act as PDPs.

## Architecture

```
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│   Developer App  │────>│  Grantex AuthZ   │────>│   PDP (OPA or    │
│   (Agent)        │     │  Server (PEP)    │     │   Cedar)         │
└──────────────────┘     └──────────────────┘     └──────────────────┘
                               │                         │
                               │  AuthZEN-aligned         │
                               │  evaluation request      │
                               │ ──────────────────────> │
                               │                         │
                               │  decision response      │
                               │ <────────────────────── │
```

The Grantex authorization server (PEP) translates DAAP authorization requests into an evaluation context aligned with the AuthZEN subject/resource/action/context model, then forwards that context to the configured PDP.

## OPA as AuthZEN PDP

### Endpoint

```
POST {OPA_URL}/v1/data/grantex/authz
```

### Input Format

OPA receives the evaluation context in its `input` field, which maps to the AuthZEN model:

```json
{
  "input": {
    "subject": {
      "type": "agent",
      "id": "did:grantex:ag_01HXYZ123abc",
      "properties": {
        "developer": "org_yourcompany",
        "principalId": "user_abc123"
      }
    },
    "resource": {
      "type": "grant",
      "properties": {
        "scopes": ["calendar:read", "payments:initiate:max_500"]
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
}
```

### OPA Policy (Rego)

```rego
package grantex.authz

import rego.v1

default allow := false

# Allow read-only scopes during business hours
allow if {
    every scope in input.resource.properties.scopes {
        endswith(scope, ":read")
    }
    time.clock(time.parse_rfc3339_ns(input.context.timestamp))[0] >= 9
    time.clock(time.parse_rfc3339_ns(input.context.timestamp))[0] < 17
}

# Deny payment scopes above threshold
allow if {
    not payment_exceeds_threshold
}

payment_exceeds_threshold if {
    some scope in input.resource.properties.scopes
    startswith(scope, "payments:initiate:max_")
    limit := to_number(trim_prefix(scope, "payments:initiate:max_"))
    limit > 10000
}
```

### OPA Response

```json
{
  "result": {
    "allow": true
  }
}
```

### AuthZEN Alignment

| AuthZEN Concept | OPA Implementation |
|-----------------|--------------------|
| Evaluation endpoint | `POST /v1/data/{package}` |
| Subject | `input.subject` |
| Resource | `input.resource` |
| Action | `input.action` |
| Context | `input.context` |
| Decision | `result.allow` (boolean) |

## Cedar as AuthZEN PDP

### Endpoint

```
POST {CEDAR_URL}/v1/is_authorized
```

### Input Format

Cedar uses its own entity-based model, which maps from the AuthZEN context:

```json
{
  "principal": "Agent::\"did:grantex:ag_01HXYZ123abc\"",
  "action": "Action::\"authorize\"",
  "resource": "Grant::\"grnt_01HXYZ...\"",
  "context": {
    "developer": "org_yourcompany",
    "principalId": "user_abc123",
    "scopes": ["calendar:read", "payments:initiate:max_500"],
    "timestamp": "2026-02-01T12:00:00Z",
    "ipAddress": "203.0.113.42"
  }
}
```

### Cedar Policy

```cedar
// Allow read-only scopes for all agents
permit (
  principal is Agent,
  action == Action::"authorize",
  resource is Grant
) when {
  context.scopes.containsAll(["calendar:read"]) &&
  !context.scopes.contains("payments:initiate")
};

// Deny high-value payment scopes outside business hours
forbid (
  principal is Agent,
  action == Action::"authorize",
  resource is Grant
) when {
  context.scopes.contains("payments:initiate") &&
  context.hour < 9 || context.hour > 17
};
```

### Cedar Response

```json
{
  "decision": "Allow"
}
```

### AuthZEN Alignment

| AuthZEN Concept | Cedar Implementation |
|-----------------|---------------------|
| Evaluation endpoint | `POST /v1/is_authorized` |
| Subject | `principal` (Cedar entity) |
| Resource | `resource` (Cedar entity) |
| Action | `action` (Cedar entity) |
| Context | `context` (record) |
| Decision | `decision` (`"Allow"` or `"Deny"`) |

## Timeout and Fallback Behavior

Both backends share the same timeout and fallback configuration:

| Parameter | Default | Description |
|-----------|---------|-------------|
| Timeout | 5 seconds | Maximum time to wait for PDP response |
| Fallback: `deny` | Default | Deny the request if PDP is unreachable |
| Fallback: `allow` | Optional | Allow the request (fail-open, use with caution) |
| Fallback: `builtin` | Optional | Fall back to the built-in policy engine |

### Configuration

```bash
# OPA backend
POLICY_BACKEND=opa
OPA_URL=http://localhost:8181
POLICY_TIMEOUT=5000
POLICY_FALLBACK=deny

# Cedar backend
POLICY_BACKEND=cedar
CEDAR_URL=http://localhost:8180
POLICY_TIMEOUT=5000
POLICY_FALLBACK=builtin
```

## Decision Mapping

| AuthZEN Decision | OPA Response | Cedar Response | DAAP Effect |
|-----------------|--------------|----------------|-------------|
| Allow | `{ "result": { "allow": true } }` | `{ "decision": "Allow" }` | `auto_approve` |
| Deny | `{ "result": { "allow": false } }` | `{ "decision": "Deny" }` | `auto_deny` |
| Error/Timeout | N/A | N/A | Configurable fallback |

## Comparison Summary

| Capability | OPA | Cedar | AuthZEN Standard |
|-----------|-----|-------|-----------------|
| Policy language | Rego | Cedar | PDP-defined |
| Entity model | Flat JSON input | Typed entities | Subject/Resource/Action/Context |
| Evaluation model | Data-driven | Request-based | Request-based |
| Decision format | `{ "allow": bool }` | `{ "decision": "Allow"/"Deny" }` | `{ "decision": bool }` |
| DAAP integration | `lib/policy-backends/opa.ts` | `lib/policy-backends/cedar.ts` | Via OPA or Cedar adapter |
| Ecosystem | CNCF graduated | AWS open source | OpenID Foundation |
