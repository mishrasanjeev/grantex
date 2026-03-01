# grantex_policy (Resource)

Manages a Grantex authorization policy. Policies define allow or deny rules that control agent access to scopes, optionally scoped to specific agents, principals, or time windows.

## Example Usage

```hcl
resource "grantex_policy" "business_hours_only" {
  name               = "Business Hours Only"
  effect             = "deny"
  priority           = 10
  scopes             = ["calendar:write"]
  time_of_day_start  = "00:00"
  time_of_day_end    = "08:00"
}

resource "grantex_policy" "allow_read_all" {
  name   = "Allow Read for All Agents"
  effect = "allow"
  scopes = ["calendar:read", "email:read"]
}
```

## Schema

### Required

- `name` (String) - The name of the policy.
- `effect` (String) - The effect of the policy: `"allow"` or `"deny"`.

### Optional

- `priority` (Number) - The priority of the policy. Higher values take precedence. Defaults to `0`.
- `agent_id` (String) - The agent ID this policy applies to. If omitted, applies to all agents.
- `principal_id` (String) - The principal ID this policy applies to. If omitted, applies to all principals.
- `scopes` (List of String) - The scopes this policy applies to. If omitted, applies to all scopes.
- `time_of_day_start` (String) - Start time for time-based policy (HH:MM format, UTC).
- `time_of_day_end` (String) - End time for time-based policy (HH:MM format, UTC).

### Read-Only

- `id` (String) - The unique identifier for the policy.
- `created_at` (String) - The timestamp when the policy was created.
- `updated_at` (String) - The timestamp when the policy was last updated.

## Import

Policies can be imported using the policy ID:

```shell
terraform import grantex_policy.business_hours_only <policy_id>
```
