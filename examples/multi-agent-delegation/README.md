# Multi-Agent Delegation Example

Demonstrates the Grantex delegation chain pattern (SPEC §9) with cascade revocation.

## Setup

```bash
# Start the auth service
docker compose up

# Install and run
cd examples/multi-agent-delegation
npm install && npm start
```

## What it does

1. Registers a parent agent (orchestrator) and a child agent (calendar worker)
2. Parent agent obtains a grant token with broad scopes
3. Parent delegates a subset of scopes (`calendar:read` only) to the child
4. Verifies the child token shows delegation metadata (`delegationDepth`, `parentAgentDid`)
5. Revokes the parent grant — cascade revocation automatically revokes the child grant
