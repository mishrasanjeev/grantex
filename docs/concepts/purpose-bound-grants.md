---
title: "Purpose-Bound Grants"
sidebarTitle: "Purpose-Bound Grants"
description: "Bind a grant to the purpose a person approved, and let tools refuse calls made for any other purpose."
---

<Warning>
The examples on this page describe the newer SDK source in this repository.
At the September 24, 2026 registry check, published Python `grantex==0.5.1`
does not enforce purpose from a token. AgenticOrg's governed-case integration
currently uses an exact local purpose allowlist, not this token-level control.
See [the integration boundary](/guides/agenticorg-governed-cases) and
[Release Status](/release-status) before using these examples in production.
</Warning>

## What a purpose is

A scope says *what* an agent may do. A purpose says *why*. A grant issued for
customer due diligence at onboarding should not be usable to enrich a
marketing list, even though both call the same verification tool.

A grant carries one purpose from a controlled vocabulary:

| Purpose | Meaning |
|---|---|
| `aml.cdd.onboarding` | Customer due diligence at onboarding |
| `aml.cdd.ongoing` | Ongoing customer due diligence |
| `aml.screening` | Screening against watch lists |
| `procurement.vendor_onboarding` | Vendor onboarding |
| `payments.payout` | Payouts |

Organisations add private terms under their own namespace:
`x-<org>.<term>`, for example `x-acme-bank.kyb_refresh`. Any other value is
rejected when the grant is requested, and denied by `enforce()` if it ever
appears in a token.

## Requesting a purpose-bound grant

Pass `purpose` when creating the authorization request. It needs at least one
`tool:<connector>:<permission>` scope, because the purpose binds tool calls on
those connectors.

```python
request = grantex.authorize(AuthorizeParams(
    agent_id=agent.id,
    user_id="user_01",
    scopes=["tool:acme_kyb:read"],
    purpose="aml.cdd.onboarding",
))
```

```typescript
const request = await grantex.authorize({
  agentId: agent.id,
  userId: 'user_01',
  scopes: ['tool:acme_kyb:read'],
  purpose: 'aml.cdd.onboarding',
});
```

The consent page shows the purpose above the requested permissions. The
purpose the person approved is stored on the grant, recorded on every audit
entry logged for the grant (`purpose` on audit entries and on
`GET /v1/grants/:id`), inherited by delegated grants, and kept when the grant
token is refreshed.

## How the purpose travels in the token

Grant tokens carry the purpose in `authorization_details` (RFC 9396), one
entry per connector named by the grant's scopes:

```json
{
  "scp": ["tool:acme_kyb:read"],
  "authorization_details": [
    {"type": "urn:grantex:tools:v1", "connector": "acme_kyb", "purpose": "aml.cdd.onboarding"}
  ]
}
```

An entry of this type may also carry `tools` (tool names, or prefixes ending
in `*`), `caps` and `data_region`. `enforce()` applies an entry's `tools` list
in addition to the scopes. `data_region` is carried and reported but not yet
evaluated. Entries of other types are ignored. A claim that cannot be read
unambiguously (not an array, an entry without `type`, an unknown key in a
`urn:grantex:tools:v1` entry, or two entries for the same connector) denies
every call with `token_invalid` / `malformed_authorization_details`.

## Restricting a tool to purposes

A manifest declares which purposes a tool may be called for with
`allowed_purposes` (see the manifest 0.6 schema in `spec/manifest-0.6.md`):

```json
{
  "connector": "acme_kyb",
  "tools": {
    "get_case": "read",
    "resolve_business": {"permission": "read", "allowed_purposes": ["aml.cdd.*"]},
    "screen_person":    {"permission": "read", "allowed_purposes": ["aml.*"]},
    "monitor_enroll":   {"permission": "write", "allowed_purposes": ["aml.cdd.ongoing"]}
  }
}
```

### Matching rules

Patterns match whole dot-separated segments.

- A pattern without a wildcard matches only the identical purpose.
  `aml.cdd.ongoing` matches `aml.cdd.ongoing` and nothing else.
- `prefix.*` matches a purpose that starts with all of `prefix`'s segments and
  has at least one more. `aml.cdd.*` matches `aml.cdd.onboarding` and
  `aml.cdd.ongoing`; it does **not** match `aml.cddx` (a different segment) or
  `aml.cdd` itself.
- **`aml.*` does not match `aml`.** A wildcard stands for at least one further
  segment, so a pattern never matches its own prefix. `aml` alone is not a
  purpose in the vocabulary, and treating `aml.*` as covering it would let a
  vague purpose satisfy every specific restriction below it.
- A wildcard is only allowed as the whole last segment: `*`,
  `aml.*.onboarding` and `aml.cdd*` are rejected when the manifest loads.
- Matching is case-sensitive and purposes are lower case, so `AML.cdd.onboarding`
  never matches.

### What `enforce()` does

For a tool that declares `allowed_purposes`, after the scope and permission
checks:

| Grant | Result |
|---|---|
| No `urn:grantex:tools:v1` entry for the connector, or an entry without purpose | denied, `purpose_not_allowed` / `missing` |
| Purpose outside the vocabulary and not a private term | denied, `purpose_not_allowed` / `unknown_purpose` |
| Purpose matches none of the patterns | denied, `purpose_not_allowed` / `not_matched` |
| Purpose matches a pattern | continues to the remaining checks |

```python
result = grantex.enforce(grant_token=token, connector="acme_kyb", tool="resolve_business")
if not result.allowed:
    # result.reason_code == "purpose_not_allowed"
    # result.sub_reason == "not_matched"
    # result.details == {"allowed_purposes": ["aml.cdd.*"], "purpose": "marketing.enrichment"}
    raise PermissionError(result.reason)
```

`result.purpose` (`result.purpose` in TypeScript as well) reports the grant's
purpose for the connector on allowed and denied results, so it can be written
to your own audit records.

## Compatibility

- Tools without `allowed_purposes` behave exactly as before, whatever purpose
  the grant carries or lacks.
- Requests without `purpose` issue the same tokens as before (no
  `authorization_details` entry is added).
- The purpose columns added to `auth_requests`, `grants` and `audit_entries`
  are nullable; existing rows have no purpose.
- Purpose is not part of the audit entry hash. It is stamped from the grant
  record, which the entry already references by `grantId`.
- Offline consent bundles and the OAuth agent-grants profile do not accept a
  purpose yet.
