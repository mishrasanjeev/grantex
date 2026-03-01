# grantex_grants (Data Source)

Use this data source to list Grantex grants with optional filters. Returns all grants matching the specified criteria.

## Example Usage

```hcl
# List all active grants for a specific agent
data "grantex_grants" "agent_grants" {
  agent_id = grantex_agent.calendar_bot.agent_id
  status   = "active"
}

# List all grants for a principal
data "grantex_grants" "user_grants" {
  principal_id = "user@example.com"
}

output "active_grant_count" {
  value = length(data.grantex_grants.agent_grants.grants)
}
```

## Schema

### Optional

- `agent_id` (String) - Filter grants by agent ID.
- `principal_id` (String) - Filter grants by principal (user) ID.
- `status` (String) - Filter grants by status (e.g., `"active"`, `"revoked"`, `"expired"`).

### Read-Only

- `grants` (List of Object) - The list of grants matching the filters. Each grant has the following attributes:
  - `grant_id` (String) - The unique identifier for the grant.
  - `agent_id` (String) - The agent ID associated with the grant.
  - `principal_id` (String) - The principal (user) ID who authorized the grant.
  - `scopes` (List of String) - The scopes authorized in the grant.
  - `status` (String) - The current status of the grant.
  - `expires_at` (String) - The timestamp when the grant expires.
  - `created_at` (String) - The timestamp when the grant was created.
