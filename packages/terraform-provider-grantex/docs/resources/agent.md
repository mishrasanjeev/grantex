# grantex_agent (Resource)

Manages a Grantex agent. Agents represent AI applications that request delegated authorization from principals (end-users).

## Example Usage

```hcl
resource "grantex_agent" "calendar_bot" {
  name        = "Calendar Bot"
  description = "Manages calendar events on behalf of users"
  scopes      = ["calendar:read", "calendar:write", "calendar:delete"]
}
```

## Schema

### Required

- `name` (String) - The display name of the agent.
- `scopes` (List of String) - The list of scopes this agent can request.

### Optional

- `description` (String) - A description of the agent's purpose.

### Read-Only

- `agent_id` (String) - The unique identifier for the agent.
- `did` (String) - The decentralized identifier (DID) for the agent.
- `status` (String) - The current status of the agent.
- `created_at` (String) - The timestamp when the agent was created.
- `updated_at` (String) - The timestamp when the agent was last updated.

## Import

Agents can be imported using the agent ID:

```shell
terraform import grantex_agent.calendar_bot <agent_id>
```
