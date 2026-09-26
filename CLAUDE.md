# Grantex Engineering Guide

`AGENTS.md` and `CLAUDE.md` in this repository are the same document. Change both in the
same commit and keep them identical.

Grantex is an open-source authorization protocol and reference implementation for AI agents.
Keep protocol and SDK changes small, explicit, and verifiable across the supported languages.

## Hard rules

These apply to every change, in every file, commit, branch and pull request.

**No tool attribution anywhere.** Commit messages, author and committer fields, branch
names, pull request titles and descriptions, code comments, documentation, changelogs,
release notes, and this file contain no mention of any AI coding tool, assistant or model
provider as an author, contributor or source, and no `Co-Authored-By` or "Generated with"
line for a tool. Naming a model provider or model as a product integration the software
supports (an integration package, a provider id, a model name) is not attribution. Commit
under the repository owner's configured identity: check `git config user.name` and
`git config user.email` before your first commit, and if either names a tool, stop. Name
branches for the work (`feat/registry-attestations`, `fix/enforce-audience`), never for a
tool. Before every push, read `git log --format='%an %ae %cn %ce%n%B' origin/main..HEAD`
and confirm that no tool name, tool co-author trailer or generated-by line appears.

**Vendor-neutral, always.** Do not name any specific identity-verification,
business-verification, KYC, KYB, AML or screening vendor anywhere: code, comments, commits,
branches, pull requests, docs, fixtures, example configuration, package metadata. Keep
connector and verification interfaces provider-neutral: use `mock` and `acme_kyb` for
provider examples; commercial adapters belong in separate packages. The mock issuer is
`mock-issuer.example`; documentation examples use `issuer.example`, `provider.example` and
`merchant.example`; the example agent is `shopper-01`; the example software is
`Nimbus Shopper 2.4`. If a field or behaviour only makes sense for one vendor's product, it
does not belong in the interface. Public payments and identity standards and their
publishers (AP2, Verifiable Intent, ACP, UCP, Stripe Shared Payment Tokens, Visa Trusted
Agent Protocol, Web Bot Auth, OpenID Federation, IETF and W3C documents) may be named,
because this work renders into them.

**House terminology.** Use the left term, never the right: *registry*, not directory;
*operator override*, not kill switch; *issuer-branded*, not white-label; *irregularity*, not
anomaly; *attestation*, not verification result; *accredited issuer*, not trust provider or
verification partner; *relying party*, not consumer; `software_name` / `software_version`,
not name / version; *Agent Passport* for the credential, *grant* for the delegation.

**No new public exposure.** No internal planning documents, customer or partner names, real
individuals' names, local filesystem paths, commercial terms or real secret values in this
public repository.

**Synthetic data only.** `example.com`, `example.test` and `.example` domains, reserved-range
identifiers, invented names and amounts.

**Secrets.** Placeholders only; real values come from the environment or a secret manager.
Never commit `.env` files, keys or certificates.

**Standards, not inventions.** Where a design names a standard (SD-JWT, SD-JWT VC, Token
Status List, Bitstring Status List, OpenID Federation, SSF/CAEP, RFC 9421, RFC 8693,
RFC 9396, RFC 7638/8037, RFC 9651, CIMD, Web Bot Auth), implement it as the current text
specifies and cite the section in a comment. Verify claim names, media types and `typ`
values against the specification text, not memory.

**Feature flags.** Every behaviour change on an existing path ships behind a flag that
defaults off. New endpoints may ship enabled behind authentication. A deliberate default
flip is recorded in `CHANGELOG.md` as a breaking change with an explicit opt-out.

**Local first, then production.** Everything runs locally before it is merged. A merge to
`main` deploys the auth service, so a change must be safe to run in production the moment it
merges: new behaviour stays behind a flag that defaults off until its exit criterion is green
in CI and the owner has approved the runbook for turning it on.

## Security and interoperability

- Fail closed when a token, audience, purpose, scope, cap, decision grant, revocation state, or manifest cannot be verified.
- Derive tenant and principal identity from verified credentials, not caller-provided body fields.
- Never expose tokens, credentials, or personal data in logs, metrics labels, fixtures, or public documentation.
- Use structured parsers for tokens and manifests. Preserve backward compatibility only where a documented flag or migration explicitly allows it.
- Keep metrics labels low-cardinality and use asynchronous clients in async request paths.

## Changes and verification

- Work on a branch off `main`, never on `main` itself, with one pull request per concern.
- Write commit messages as [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `spec:`, `build:`), as `CONTRIBUTING.md` asks.
- Changes to `SPEC.md` follow the RFC process in `CONTRIBUTING.md`.
- Add a forward-only database migration for every auth-service schema change, with a rollout and backfill path.
- Test denial paths, tenant isolation, replay, concurrency, and token expiry when changing authority behavior.
- Run the affected package's typecheck and tests. Run `make check` and `make test` for shared protocol changes; use a disposable Postgres instance for database integration tests.
- Keep code examples backed by executable tests, and add a `CHANGELOG.md` entry under `Unreleased` for user-visible changes.
- Keep `release-status.json` and the READMEs describing what is published, not what is in the tree.
