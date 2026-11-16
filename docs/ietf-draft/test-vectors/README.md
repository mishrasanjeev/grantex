# OAuth Agent Grants Revision 03 Test Vectors

The JSON corpus in this directory describes protocol behaviors for
`draft-mishra-oauth-agent-grants-03` without depending on Grantex identifiers,
database tables, or private API endpoints. Each vector identifies the
conforming role, preconditions, operation, and expected result.

The placeholders use angle brackets, such as `<issuer>` and `<client-id>`, and
must be replaced with values from the implementation under test. Successful
setup operations create the artifacts referenced by later operations. A test
harness should use a fresh authorization and a fresh DPoP `jti` unless the
vector explicitly tests reuse.

The Grantex Docker E2E suite exercises the same behavior in
`tests/e2e/oauth-agent-profile.test.ts`. This corpus is suitable as a starting
point for independent interop work, but its publication is not evidence that a
second implementation has passed it and is not an external certification.
The current corpus contains 32 behavioral vectors.

The Grantex standard-profile endpoints issue no `act` claim, so
`refresh.valid.actor-preserved` and `refresh.reject.actor-dropped` do not apply
to them; Grantex tests the converse rule instead, that a refreshed profile
token gains no `act`.

## Files

| File | Purpose |
|:-----|:--------|
| `oauth-agent-grants-03.json` | Machine-readable positive and negative behavioral cases |

## Result Conventions

- `outcome: pass` means the operation must complete with the listed HTTP status
  and response properties.
- `outcome: reject` means the operation must fail with the listed OAuth error or
  protected-resource status.
- Where `expect` lists boolean properties instead of an HTTP status, each
  property must have the listed value. For example,
  `refresh.reject.actor-dropped` fails when a refreshed access token is issued
  without the `act` claim of the token it replaces.
- The refresh-reuse probes in `refresh.valid.atomic-rotation` and
  `refresh.reject.family-reuse` present no lost-response recovery key. A server
  that returns the already issued successor to that probe, however soon after
  rotation, fails the vector: the profile treats time-only replay as
  refresh-token reuse.
- Exact human-readable error descriptions are not compared.
- Redirect results list query parameters rather than prescribing a browser or
  HTTP client implementation.
