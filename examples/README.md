# Grantex Examples

Runnable examples showing how to use the Grantex SDK and framework integrations.

## Prerequisites

- **Node.js 18+** (TypeScript examples)
- **Python 3.9+** (Python examples)
- **Docker** (for the local Grantex stack)

## Start the local stack

From the repo root:

```bash
docker compose up -d
```

This starts PostgreSQL, Redis, and the Grantex auth service on `http://localhost:3001`. Two API keys are seeded automatically:

| Key | Mode | Purpose |
|---|---|---|
| `dev-api-key-local` | live | Full consent flow with redirect |
| `sandbox-api-key-local` | sandbox | Auto-approved — no consent UI needed |

All examples use the sandbox key by default.

## Examples

| Example | Description | Key packages |
|---|---|---|
| [`quickstart-ts`](./quickstart-ts/) | Core authorization flow — register, authorize, token, verify, audit, revoke | `@grantex/sdk` |
| [`langchain-agent`](./langchain-agent/) | LangChain agent with scoped tools and audit callbacks | `@grantex/sdk`, `@grantex/langchain` |
| [`vercel-ai-chatbot`](./vercel-ai-chatbot/) | Vercel AI SDK tools with scope enforcement and audit logging | `@grantex/sdk`, `@grantex/vercel-ai` |
| [`quickstart-py`](./quickstart-py/) | Core authorization flow in Python — register, authorize, token, verify, audit, revoke | `grantex` |
| [`crewai-agent`](./crewai-agent/) | CrewAI agent with scoped tools and audit logging | `grantex`, `grantex-crewai` |
| [`nextjs-starter`](./nextjs-starter/) | Next.js interactive consent flow with callback handling | `@grantex/sdk` |
| [`openai-agents`](./openai-agents/) | OpenAI Agents SDK with scope enforcement | `grantex`, `grantex-openai-agents` |
| [`google-adk`](./google-adk/) | Google ADK with scoped function tools | `grantex`, `grantex-adk` |

## Running an example

**TypeScript examples:**
```bash
cd examples/<example-name>
npm install
npm start
```

**Python examples:**
```bash
cd examples/<example-name>
pip install -r requirements.txt
python main.py
```

Each example has its own README with expected output and environment variable options.

## Notes

- **Sandbox mode** auto-approves authorization requests so you can test the full token lifecycle without a consent UI.
- The **LangChain** and **Vercel AI** examples work without an `OPENAI_API_KEY` — they invoke tools directly to demonstrate the Grantex integration. Set the key to use a real LLM.
- All examples point at `http://localhost:3001` by default. Override with the `GRANTEX_URL` environment variable.
