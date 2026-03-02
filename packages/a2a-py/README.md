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
    A2AAuthMiddlewareOptions(jwks_uri="https://grantex.dev/.well-known/jwks.json")
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
    jwks_uri="https://grantex.dev/.well-known/jwks.json",
    issuer="https://grantex.dev",
))
```
