# Tool manifest schema 0.6

Status: draft for Grantex 0.6. Normative schema:
[`manifest-0.6.schema.json`](manifest-0.6.schema.json) (JSON Schema 2020-12,
`$id` `https://grantex.dev/spec/manifest-0.6.schema.json`).

A tool manifest declares, for one connector, the permission each tool
requires. Schema 0.6 lets a tool also declare the purposes it may be called
for, call caps, cost units, and whether a human decision is required.
`enforce()` in the Python and TypeScript SDKs reads these declarations.

## Document

```json
{
  "$schema": "https://grantex.dev/spec/manifest-0.6.schema.json",
  "connector": "acme_kyb",
  "version": "1.0.0",
  "description": "Business verification connector",
  "tools": {
    "get_case": "read",
    "resolve_business":  {"permission": "read", "allowed_purposes": ["aml.cdd.*"], "caps": {"per_hour": 200}},
    "verify_business":   {"permission": "read", "allowed_purposes": ["aml.cdd.*"],
                          "caps": {"per_hour": 50, "per_case": 3},
                          "cost_units": {"base": 5, "ownership": 10, "web_insights": 3}},
    "screen_person":     {"permission": "read", "allowed_purposes": ["aml.*"], "caps": {"per_case": 25}},
    "monitor_enroll":    {"permission": "write", "allowed_purposes": ["aml.cdd.ongoing"]},
    "monitor_delete":    {"permission": "delete", "requires_decision": true},
    "case_decision":     {"permission": "write", "requires_decision": true, "four_eyes_on": ["decline"]}
  }
}
```

| Key | Type | Required | Meaning |
|---|---|---|---|
| `$schema` | string | no | Reference to the schema. Ignored by loaders. |
| `connector` | name | yes | Connector identifier; appears in scopes as `tool:<connector>:<permission>`. |
| `version` | string, 1–64 chars | no | Version of this manifest. Default `1.0.0`. |
| `description` | string | no | Human-readable description. |
| `tools` | object, at least one entry | yes | Tool name to declaration. |

A *name* (connector or tool) matches `^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$`.
No other top-level key is allowed.

## Tool declarations

A tool value is either a permission string — `read`, `write`, `delete` or
`admin`, exactly as before 0.6 — or an object. Both forms may be mixed in one
manifest. A string `"read"` is equivalent to `{"permission": "read"}`.

| Key | Type | Meaning |
|---|---|---|
| `permission` | permission | **Required.** Minimum granted permission. `admin > delete > write > read`. |
| `allowed_purposes` | non-empty array of unique purpose patterns | The grant's purpose must match at least one pattern. Omit for no purpose restriction. |
| `caps` | object with at least one of `per_hour`, `per_day`, `per_case` | Call caps. `per_hour` and `per_day` are rolling windows; `per_case` counts calls within one case. |
| `cost_units` | non-empty object, unit name to count | Units charged per call against a grant's cost-unit budget. |
| `requires_decision` | boolean | When `true`, a call also needs a decision grant. |
| `four_eyes_on` | non-empty array of unique decision names | Decisions that need two decision grants from different approvers. |
| `decision_fields` | non-empty array of at most 16 unique field names | Call arguments, beyond `case_id`, `decision`, `subject` and `amount`, that a decision grant binds (for example `currency`). See `spec/canonicalization.md`. |

Counts (caps and cost units) are integers from 0 to 2147483647. A cap of `0`
disables the tool. Unit and decision names match `^[a-z][a-z0-9_]{0,63}$`.

### Purpose patterns

A purpose pattern is either a purpose — dot-separated lower-case segments such
as `aml.cdd.onboarding`, or a private term `x-<org>.<term>` such as
`x-acme-bank.kyb_refresh` — or a purpose prefix followed by `.*`
(`aml.cdd.*`, `x-acme-bank.*`). A wildcard is only allowed as the whole last
segment: `*`, `aml.*.onboarding` and `aml.cdd*` are invalid. Patterns are at
most 128 characters. How a grant's purpose is matched against these patterns
is specified in `docs/concepts/purpose-bound-grants.md`.

### Rules beyond the property types

- An unknown key anywhere — top level, tool object or `caps` — is an error.
- `requires_decision: true` is not allowed on a `read` tool. A decision guards
  a state change; a read tool that needs one is almost always a
  mis-declared permission.
- `four_eyes_on` requires `requires_decision: true`.
- `decision_fields` requires `requires_decision: true` and may not name
  `case_id`, `action`, `decision`, `subject`, `amount` or `extra`.
- Empty `caps`, `cost_units`, `allowed_purposes`, `four_eyes_on` and `decision_fields` are errors
  rather than "no constraint": omit the key instead.

## Loading

`ToolManifest.from_file` / `from_dict` (Python) and `ToolManifest.fromFile` /
`fromJSON` (TypeScript) validate a manifest against this schema and raise
`ManifestValidationError` (a `ValueError` in Python) naming the offending
path, for example:

```
ToolManifest: tools.verify_business.caps: unknown key "per_week" (allowed: per_hour, per_day, per_case)
ToolManifest: tools.resolve_business: requires_decision is not allowed on a tool with read permission
```

Both SDKs produce the same messages; the fixtures under
[`examples/manifest-0.6`](examples/manifest-0.6) are run against the schema
and both loaders in CI.

**Compatibility.** A manifest is loaded strictly when it declares `$schema`
or uses the object form for any tool. A manifest made only of permission
strings keeps its pre-0.6 behaviour so existing files continue to load:
unknown top-level keys are ignored with a deprecation warning, and connector
and tool names are not pattern-checked. A future minor release will apply the
schema to every manifest.

`ToolManifest.tools` still maps each tool to its permission string. The full
declaration is available from `get_tool_spec(name)` (Python) or
`getToolSpec(name)` (TypeScript).

## How `enforce()` applies a declaration

Checks run in this order, and the first failure is returned as a denial with
a `reason_code` (`reasonCode` in TypeScript) and, where one applies, a
`sub_reason` (`subReason`):

| Step | Denial `reason_code` | `sub_reason` |
|---|---|---|
| Grant token verification | `token_invalid` | |
| `authorization_details` readable | `token_invalid` | `malformed_authorization_details` |
| Manifest loaded for the connector | `manifest_unknown_tool` | `unknown_connector` |
| Tool declared | `manifest_unknown_tool` | `unknown_tool`, `invalid_declaration` |
| A scope covers the connector | `tool_not_granted` | |
| Scope permission covers the tool's permission | `permission_insufficient` | |
| The grant's tools list (when present) names the tool | `tool_not_granted` | `not_in_authorization_details` |
| `allowed_purposes` | `purpose_not_allowed` | `missing`, `unknown_purpose`, `not_matched` |
| `requires_decision` | `decision_required` | |
| `amount` within a `capped:N` scope | `cap_exceeded` | `invalid_amount`, `malformed_cap`, `amount_cap` |
| `caps`, `cost_units` (manifest or grant), reserved last | `cap_exceeded` | `limit_reached` (E1008), `case_required`, `invalid_case_id`, `invalid_cost_component`, `meter_unavailable` |

The reason codes are the Grantex denial taxonomy: `purpose_not_allowed`,
`tool_not_granted`, `permission_insufficient`, `cap_exceeded`,
`decision_required`, `decision_invalid` (sub-reasons `action_mismatch`,
`expired`, `consumed`, `same_approver`), `grant_revoked`, `region_mismatch`,
`manifest_unknown_tool`, plus `token_invalid` for a token that fails
verification before any grant is known. They are stable, low-cardinality
values intended for audit records and metric labels; `reason` remains a
human-readable sentence and may change.

Declarations are enforced fail-closed: an SDK that cannot evaluate a declared
constraint denies the call rather than ignoring the constraint. Purpose
matching is specified in `docs/concepts/purpose-bound-grants.md` and caps in
`docs/concepts/caps-and-metering.md`. A tool with caps or cost units is
denied with `meter_unavailable` when the client has no caps meter. In this
release a tool with `requires_decision` always returns `decision_required`.
Tools declared with a permission only behave exactly as before.
