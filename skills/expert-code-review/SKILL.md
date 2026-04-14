---
name: expert-code-review
description: Expert review guidelines for auditing repositories, pull requests, and system designs. Use when performing code review to find functional gaps, security risks, correctness bugs, maintainability problems, missing tests, and architectural weaknesses without making direct code changes.
---

# Expert Code Review

Behavioral guidelines for high-signal engineering reviews. The goal is to identify the most important problems first, prove them with concrete evidence, and distinguish real defects from stylistic preference.

**Tradeoff:** These guidelines bias toward rigor over speed. For trivial diffs, use judgment.

## 1. Review for Behavior First

**Start from what can break for users, operators, or integrators.**

- Check correctness before style.
- Look for security, data loss, privilege escalation, race conditions, and broken API contracts first.
- Prefer end-to-end reasoning over isolated line comments.
- Ask: "What bad outcome becomes possible because of this code?"

## 2. Prove Every Claim

**Do not speculate silently. Build findings from evidence.**

- Read the code path far enough to understand inputs, state transitions, and outputs.
- Cite exact files and lines for each finding.
- Explain the failure mode, not just the suspicious code.
- If a concern depends on an assumption, state that assumption explicitly.

## 3. Separate Severity from Preference

**Not every imperfection is a bug.**

- Treat user-visible regressions, security flaws, and integrity issues as high severity.
- Treat maintainability issues as findings only when they create real delivery or reliability risk.
- Do not file style-only comments as defects.
- If something is merely a tradeoff, label it as such.

## 4. Hunt for Functional Gaps

**Review what the system claims to support against what the code actually implements.**

- Compare README, API surface, routes, SDK methods, and tests.
- Look for missing validation, partial implementations, unsupported edge cases, and inconsistent behavior across SDKs or adapters.
- Check whether auth, pagination, filtering, retry, revocation, idempotency, and observability are handled consistently.
- Treat "documented but not enforced" as a real gap.

## 5. Audit Code Quality Through Risk

**Code quality matters when it increases the chance of defects.**

- Flag duplication when it creates drift risk.
- Flag weak typing when it hides unsafe behavior.
- Flag oversized files or mixed responsibilities when they block safe change.
- Flag tests that only prove happy paths while critical failure modes remain uncovered.

## 6. Be Surgical in Output

**Deliver the shortest review that still changes engineering decisions.**

- Lead with findings, ordered by severity.
- For each finding, include: impact, evidence, and why it matters.
- Keep summaries brief.
- If no defects are found, say so explicitly and note residual risk areas or test gaps.

## Review Checklist

Use this checklist to guide the pass:

1. Public contract: Does implementation match documented behavior?
2. Auth and trust: Are identity, authorization, and secret boundaries enforced correctly?
3. Data integrity: Can bad state be created, persisted, or returned?
4. Failure handling: Do retries, timeouts, and partial failures behave safely?
5. Concurrency: Can workers, background jobs, or duplicate requests race?
6. SDK parity: Do TypeScript, Python, Go, CLI, and adapters behave consistently where expected?
7. Test coverage: Are high-risk branches and regressions actually exercised?

## Output Shape

For substantial reviews, use:

1. Findings
2. Open questions or assumptions
3. Residual risks or testing gaps

Do not propose code changes unless asked. Focus on surfacing the most important gaps with defensible reasoning.
