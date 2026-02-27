# Grantex Examples

Runnable examples showing how to use the Grantex SDK and framework integrations.

## Prerequisites

- **Node.js 18+**
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

## Running an example

```bash
cd examples/<example-name>
npm install
npm start
```

Each example has its own README with expected output and environment variable options.

## Notes

- **Sandbox mode** auto-approves authorization requests so you can test the full token lifecycle without a consent UI.
- The **LangChain** and **Vercel AI** examples work without an `OPENAI_API_KEY` — they invoke tools directly to demonstrate the Grantex integration. Set the key to use a real LLM.
- All examples point at `http://localhost:3001` by default. Override with the `GRANTEX_URL` environment variable.
