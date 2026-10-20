# grantex-a2a

Google A2A protocol bridge for [Grantex](https://grantex.dev) — inject grant tokens into agent-to-agent communication.

## Installation

```bash
pip install grantex-a2a
```

## Usage

### Client — Send tasks to A2A agents with grant token auth

```python
from grantex_a2a import A2AGrantexClient, A2AGrantexClientOptions, TaskSendParams, A2AMessage, A2APart

client = A2AGrantexClient(A2AGrantexClientOptions(
    agent_url="https://agent.example.com/a2a",
    grant_token="eyJ...",
))

task = client.send_task(TaskSendParams(
    message=A2AMessage(role="user", parts=[A2APart(type="text", text="Hello")])
))
```

### Server middleware — Validate incoming grant tokens

```python
from grantex_a2a import create_a2a_auth_middleware, A2AAuthMiddlewareOptions

middleware = create_a2a_auth_middleware(
    A2AAuthMiddlewareOptions(jwks_uri="https://api.grantex.dev/.well-known/jwks.json")
)

# In your request handler:
grant = middleware(dict(request.headers))
print(grant.principal_id, grant.scopes)
```

### Agent Card — Build A2A-compliant agent cards

```python
from grantex_a2a import build_grantex_agent_card, GrantexAgentCardOptions

card = build_grantex_agent_card(GrantexAgentCardOptions(
    name="My Agent",
    description="An agent",
    url="https://my-agent.example.com/a2a",
    jwks_uri="https://api.grantex.dev/.well-known/jwks.json",
    issuer="https://grantex.dev",
))
```

## License

PolyForm Noncommercial License 1.0.0, licensor Orchestrum Technologies LLP
([LICENSE](https://github.com/mishrasanjeev/grantex/blob/main/LICENSE)).
Noncommercial self use is free. Commercial use of any sort, including internal
use by a for-profit business, hosting or SaaS, resale, embedding and paid
services, needs a written agreement with Orchestrum Technologies LLP: see
[commercial licensing](https://github.com/mishrasanjeev/grantex/blob/main/COMMERCIAL-LICENSE.md)
or write to [sanjeev@orchestrum.in](mailto:sanjeev@orchestrum.in). Versions
published before 21 October 2026 remain available under the Apache License 2.0
they were released with. "Grantex" is a trademark of Orchestrum Technologies LLP
([trademarks](https://github.com/mishrasanjeev/grantex/blob/main/TRADEMARKS.md)).

## Ownership

Grantex is owned by Orchestrum Technologies LLP. Inventor and owner: Sanjeev Kumar. Ownership contact: [sanjeev@orchestrum.in](mailto:sanjeev@orchestrum.in) or [mishra.sanjeev@gmail.com](mailto:mishra.sanjeev@gmail.com).
> Authority hardening requires Python SDK 0.7.1 (`current_authority`),
> not just a valid JWT signature. Bind the audience and trusted human/agent
> identities, and check the issuer before every execution. This does not
> create human consent or automatically consume action decisions/spend caps.
> Existing offline defaults remain offline. Verify registry availability before installation.
> See the [SDK execution authority guide](https://docs.grantex.dev/guides/sdk-execution-authority).
