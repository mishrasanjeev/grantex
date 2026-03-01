# grantex_agent (Data Source)

Use this data source to look up an existing Grantex agent by its ID.

## Example Usage

```hcl
data "grantex_agent" "existing" {
  agent_id = "agt_abc123"
}

output "agent_name" {
  value = data.grantex_agent.existing.name
}

output "agent_scopes" {
  value = data.grantex_agent.existing.scopes
}
```

## Schema

### Required

- `agent_id` (String) - The unique identifier of the agent to look up.

### Read-Only

- `did` (String) - The decentralized identifier (DID) for the agent.
- `name` (String) - The display name of the agent.
- `description` (String) - A description of the agent's purpose.
- `scopes` (List of String) - The list of scopes this agent can request.
- `status` (String) - The current status of the agent.
- `created_at` (String) - The timestamp when the agent was created.
- `updated_at` (String) - The timestamp when the agent was last updated.
