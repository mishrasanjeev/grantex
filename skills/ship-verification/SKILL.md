---
name: ship-verification
description: Post-merge verification pass for Grantex. After any PR merges to main or ships to prod, run this pass without being asked — verify README, Mintlify docs, landing page, SDK READMEs (TS, Python, Go), integration docs, and SEO surfaces are consistent with what just shipped. Use this skill whenever a PR merges, a release goes out, or a feature ships.
---

# Ship Verification

Behavioral guideline for keeping Grantex's public surfaces honest after every merge. The goal is to catch drift between what the code does and what the docs claim — before a user runs into it.

**Trigger**: run this pass automatically after any merge to `main` or any prod deploy. Do not wait to be reminded. If the diff is trivial (dependabot version bump, CI-only change, internal refactor with no public contract change), say so and skip.

**Tradeoff**: biases toward catching drift over speed. For a pure CI / dependabot / internal refactor PR, a one-sentence "no public surface touched, skipping" is the right output.

## 1. Scope the diff first

Before touching any doc, identify what actually shipped:

- What routes, SDK methods, response shapes, or CLI commands changed?
- Did any behavior change silently — e.g. a request that used to succeed now 400s, or a value now appears in a different place?
- If the answer to both is "no" (CI, deps, tests, security-internal hardening with no contract change), skip the rest and report that.

Do not fabricate updates. A security fix that tightens verification without changing the API contract usually needs no doc change.

## 2. Surfaces to check

Walk these in order. Stop when the diff doesn't touch a surface.

1. **`README.md`** (repo root) — quickstart code, feature matrix, example table, package versions.
2. **Mintlify docs (`docs/`)** — concept pages, SDK reference pages (TS + Python), guides, integration pages. Check `docs/sdks/typescript/` and `docs/sdks/python/` mirror each other when a feature exists in both.
3. **SDK READMEs** — `packages/sdk-ts/README.md`, `packages/sdk-py/README.md`, `packages/go-sdk/README.md`. Each has its own quickstart that can drift from the root.
4. **Landing page** — `web/index.html`. Only update for new capabilities that change the value proposition. Security-internal changes do not belong here.
5. **Integrations index** — `docs/integrations/overview.mdx` if a new integration shipped.
6. **SDK test fixtures** — mocked response shapes in `packages/sdk-*/tests/*` that encode server behavior. These are technically tests, but they document the shape; keep them honest.
7. **SEO** — only when keywords or messaging change. Never touch for internal fixes. Use the keywords from `seo-system` memory, not generic SEO audit advice.

## 3. What counts as a real gap

A finding is real when:

- A code example would fail if copy-pasted.
- A response field or URL format in docs no longer matches what the server returns.
- A parameter's documented behavior (defaults, validation, errors) diverges from the implementation.
- A feature shipped but is not mentioned anywhere a user would discover it.

A finding is not real when:

- Docs use a synonym or different phrasing for the same thing.
- A test mock uses a stale value that is not user-visible and does not affect production (flag it, but it's not a release blocker).
- A page could be restructured for clarity but is not wrong.

## 4. Output shape

Keep reports tight. For each surface:

- `README.md` — OK / needs X
- `docs/` — OK / list files needing updates with one-line reason each
- SDK READMEs — OK / which package and why
- Landing page — OK / out of scope for this change
- SEO — OK / out of scope

If changes are needed, batch them in a single PR named `docs/<topic>-followup` unless the diff naturally splits. Do not open a PR per file.

## 5. When to skip

Skip the pass entirely when:

- PR is a dependabot bump that did not touch source.
- PR only touches `.github/workflows/`, `skills/`, or `scripts/`.
- PR is an internal refactor with no change to exported symbols, route shapes, or response bodies.
- PR is a test-only change.

Always report what you skipped and why, in one line. Silence is not the right signal.

## 6. Order of operations in a session

When multiple PRs merge in a session:

1. Batch the doc audit at the end of the session, not after each merge.
2. Group updates from related PRs into one follow-up PR.
3. If a single PR is large enough that its doc impact is nontrivial (e.g. a new SDK method), audit and fix as part of the same PR if still open; otherwise follow-up immediately.

## Checklist

Use this before declaring done:

1. Did I scope the diff to what actually shipped, not speculate?
2. For each affected surface, did I read the current doc and compare it to the code?
3. Did I avoid editing surfaces the change did not touch?
4. Is there a single clean PR for the follow-up, or a clear statement that none was needed?
