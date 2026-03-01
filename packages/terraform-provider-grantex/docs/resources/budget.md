# grantex_budget_allocation (Resource)

Manages a Grantex budget allocation. Allocates a spending budget to a grant for cost control.

This is a create-only resource. Budget allocations cannot be updated after creation. To change the budget, destroy and recreate the resource. Deletion is logical (removes from Terraform state only).

## Example Usage

```hcl
resource "grantex_budget_allocation" "agent_budget" {
  grant_id       = grantex_agent.calendar_bot.agent_id
  initial_budget = 100.00
  currency       = "USD"
}
```

## Schema

### Required

- `grant_id` (String) - The grant ID to allocate budget to. Changing this forces a new resource.
- `initial_budget` (Float) - The initial budget amount to allocate.

### Optional

- `currency` (String) - The currency for the budget. Defaults to `"USD"`. Changing this forces a new resource.

### Read-Only

- `id` (String) - The unique identifier for the budget allocation.
- `remaining_budget` (Float) - The remaining budget amount.
- `created_at` (String) - The timestamp when the budget allocation was created.
