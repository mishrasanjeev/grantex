# Contributing to Grantex

Thanks for your interest in contributing. Grantex is an open protocol for delegated AI agent authorization — contributions help shape a safer agentic internet.

---

## Where to Start

### Highest priority right now

| Area | What's needed | Skill |
|------|--------------|-------|
| New integrations | Add Grantex support to more frameworks | TypeScript / Python |
| Examples & tutorials | End-to-end walkthroughs for common use cases | Writing |
| Bug reports | Found a bug? Open an issue with reproduction steps | Any |
| Protocol feedback | Review SPEC.md, open issues for gaps | Any |
| Docs | Improve quickstart, add translations | Writing |

### Good first issues

Look for issues tagged [`good first issue`](https://github.com/mishrasanjeev/grantex/issues?q=is%3Aissue+label%3A%22good+first+issue%22).

---

## Development Setup

```bash
# Prerequisites: Node.js 18+, Python 3.9+, Docker (for local stack)

git clone https://github.com/mishrasanjeev/grantex
cd grantex

# Start the full local stack (PostgreSQL + Redis + auth service)
docker compose up --build

# TypeScript SDK
cd packages/sdk-ts
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest

# Python SDK
cd packages/sdk-py
pip install -e ".[dev]"
pytest

# Auth service
cd apps/auth-service
npm install
npm run typecheck
npm test            # vitest — 174 tests

# CLI
cd packages/cli
npm install
npm run typecheck

# Integration packages (langchain, autogen, vercel-ai)
cd packages/<package>
npm install
npm run typecheck
npm test
```

---

## Repository Structure

```
grantex/
├── SPEC.md                       ← Protocol specification (v1.0 final)
├── ROADMAP.md                    ← What's been built and what's next
├── packages/
│   ├── sdk-ts/                   ← TypeScript SDK (@grantex/sdk)
│   ├── sdk-py/                   ← Python SDK (grantex)
│   ├── go-sdk/                   ← Go SDK (github.com/mishrasanjeev/grantex-go)
│   ├── mcp/                      ← MCP server (@grantex/mcp)
│   ├── langchain/                ← LangChain integration (@grantex/langchain)
│   ├── autogen/                  ← AutoGen integration (@grantex/autogen)
│   ├── vercel-ai/                ← Vercel AI SDK integration (@grantex/vercel-ai)
│   ├── crewai/                   ← CrewAI integration (grantex-crewai)
│   ├── openai-agents/            ← OpenAI Agents SDK integration (grantex-openai-agents)
│   ├── google-adk/               ← Google ADK integration (grantex-adk)
│   ├── express/                  ← Express.js middleware (@grantex/express)
│   ├── fastapi/                  ← FastAPI middleware (grantex-fastapi)
│   ├── adapters/                 ← Service provider adapters (@grantex/adapters)
│   ├── gateway/                  ← Reverse-proxy gateway (@grantex/gateway)
│   ├── conformance/              ← Conformance test suite (@grantex/conformance)
│   └── cli/                      ← CLI tool (@grantex/cli)
├── apps/
│   ├── auth-service/             ← Fastify auth service (REST API)
│   └── portal/                   ← Developer portal (React SPA)
├── examples/                     ← Runnable examples
├── web/                          ← Landing page (Firebase Hosting)
├── deploy/                       ← Docker, Helm, Nginx deployment configs
│   ├── helm/grantex/             ← Helm chart
│   └── nginx/                    ← Nginx reverse proxy config
├── docs/                         ← Mintlify docs site (157+ MDX pages)
└── docker-compose.yml            ← Local development stack
```

---

## PR Guidelines

1. **Open an issue first** for anything non-trivial — align before you build.
2. **One PR per concern** — don't bundle unrelated changes.
3. **Tests required** — all new code needs tests. No exceptions.
4. **Spec changes need discussion** — protocol changes require an open Discussion with at least 72 hours for community input before merging.
5. **Changelog entry** — add a line to `CHANGELOG.md` under `Unreleased`.

---

## Code Style

- TypeScript: ESLint + Prettier (config in repo root)
- Python: Ruff + Black
- Commit messages: [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `spec:`)

---

## Protocol Changes (RFCs)

Changes to `SPEC.md` follow a lightweight RFC process:

1. Open a GitHub Discussion tagged `[RFC]`
2. Describe the change, motivation, and alternatives considered
3. 72-hour minimum comment period
4. Maintainer merges or closes with reasoning

---

## Code of Conduct

Be excellent to each other. Technical disagreements are fine; personal attacks are not.

Full CoC: [CODE_OF_CONDUCT.md](https://github.com/mishrasanjeev/grantex/blob/main/CODE_OF_CONDUCT.md)

---

## Questions?

- GitHub Discussions for design questions
- GitHub Issues for bugs and concrete feature requests
- [Discord](https://discord.gg/grantex) for real-time chat

---

*Thanks for helping build the trust layer for the agentic internet.*
