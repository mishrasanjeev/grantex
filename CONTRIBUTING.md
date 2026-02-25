# Contributing to Grantex

Thanks for your interest in contributing. Grantex is an early-stage open protocol — contributions at this stage have outsized impact on the final shape of the standard.

---

## Where to Start

### Highest priority right now

| Area | What's needed | Skill |
|------|--------------|-------|
| Protocol feedback | Review SPEC.md, open issues for gaps | Any |
| TypeScript SDK | Implement core methods in `packages/sdk-ts` | TypeScript |
| Python SDK | Implement core methods in `packages/sdk-py` | Python |
| LangChain integration | Adapter in `packages/integrations/langchain` | TypeScript / Python |
| Consent UI | Next.js OAuth-style consent screen | React / Next.js |
| Docs | Improve quickstart, add examples | Writing |

### Good first issues

Look for issues tagged [`good first issue`](https://github.com/mishrasanjeev/grantex/issues?q=is%3Aissue+label%3A%22good+first+issue%22).

---

## Development Setup

```bash
# Prerequisites: Node.js 20+, Python 3.11+, pnpm

git clone https://github.com/mishrasanjeev/grantex
cd grantex
pnpm install

# Run all tests
pnpm test

# Run TypeScript SDK tests
pnpm --filter @grantex/sdk test

# Run Python SDK tests
cd packages/sdk-py && pip install -e ".[dev]" && pytest
```

---

## Repository Structure

```
grantex/
├── SPEC.md                    ← Protocol specification (start here)
├── ROADMAP.md                 ← What's being built
├── packages/
│   ├── sdk-ts/                ← TypeScript SDK (@grantex/sdk)
│   ├── sdk-py/                ← Python SDK (grantex)
│   └── integrations/
│       ├── langchain/         ← LangChain adapter
│       └── autogen/           ← AutoGen adapter
├── apps/
│   ├── api/                   ← Grantex backend (Fastify)
│   ├── consent/               ← Hosted consent UI (Next.js)
│   └── dashboard/             ← Developer dashboard (Next.js)
└── infra/                     ← Docker / deployment configs
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
