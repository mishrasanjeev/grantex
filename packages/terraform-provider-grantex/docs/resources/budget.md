# grantex_budget_allocation (Resource)

Manages a Grantex budget allocation. Allocates a spending budget to a grant for cost control.

This is a create-only resource. The Grantex API offers neither an update nor a delete endpoint for allocations, so:

- changing `grant_id`, `initial_budget` or `currency` forces a new resource;
- destroying the resource only removes it from Terraform state (the allocation remains on the grant);
- because a grant can hold at most one allocation, replacing an allocation on the same grant is refused by the API with `409 CONFLICT` until the existing allocation is removed out of band. Import the existing allocation instead of recreating it.

## Example Usage

```hcl
resource "grantex_budget_allocation" "agent_budget" {
  grant_id       = "grt_abc123"
  initial_budget = 100.00
  currency       = "USD"
}
```

## Schema

### Required

- `grant_id` (String) - The grant ID to allocate budget to. Changing this forces a new resource.
- `initial_budget` (Float) - The initial budget amount to allocate. Changing this forces a new resource.

### Optional

- `currency` (String) - The currency for the budget. Defaults to `"USD"`. Changing this forces a new resource.

### Read-Only

- `id` (String) - The unique identifier for the budget allocation.
- `remaining_budget` (Float) - The remaining budget amount.
- `created_at` (String) - The timestamp when the budget allocation was created.

## Import

Budget allocations are imported by the grant ID they belong to:

```shell
terraform import grantex_budget_allocation.agent_budget <grant_id>
```

## Ownership

Grantex is owned by Orchestrum Technologies LLP. Inventor and owner: Sanjeev Kumar. Ownership contact: [sanjeev@orchestrum.in](mailto:sanjeev@orchestrum.in) or [mishra.sanjeev@gmail.com](mailto:mishra.sanjeev@gmail.com).
