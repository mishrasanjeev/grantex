# Repository Guardrails

Keep protocol and SDK changes small, explicit, and verifiable across the supported languages.

## Security and interoperability

- Fail closed when a token, audience, purpose, scope, cap, decision grant, revocation state, or manifest cannot be verified.
- Derive tenant and principal identity from verified credentials, not caller-provided body fields.
- Never expose tokens, credentials, or personal data in logs, metrics labels, fixtures, or public documentation.
- Use structured parsers for tokens and manifests. Preserve backward compatibility only where a documented flag or migration explicitly allows it.
- Keep connector and verification interfaces provider-neutral. Use `mock` and `acme_kyb` in examples; commercial adapters belong in separate packages.
- Keep metrics labels low-cardinality and use asynchronous clients in async request paths.

## Changes and verification

- Add a forward-only database migration for every auth-service schema change, with a rollout and backfill path.
- Test denial paths, tenant isolation, replay, concurrency, and token expiry when changing authority behavior.
- Run the affected package's typecheck and tests. Run `make check` and `make test` for shared protocol changes; use a disposable Postgres instance for database integration tests.
- Keep code examples backed by executable tests and document user-visible changes in the changelog.
- Keep private plans, customer identities, local paths, commercial terms, and real secret values out of this public repository.
- Commit under the repository owner's configured identity without tool-credit trailers or generated-by notes.
