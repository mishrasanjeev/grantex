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
The current corpus contains 30 behavioral vectors.

## Files

| File | Purpose |
|:-----|:--------|
| `oauth-agent-grants-03.json` | Machine-readable positive and negative behavioral cases |

## Result Conventions

- `outcome: pass` means the operation must complete with the listed HTTP status
  and response properties.
- `outcome: reject` means the operation must fail with the listed OAuth error or
  protected-resource status.
- Exact human-readable error descriptions are not compared.
- Redirect results list query parameters rather than prescribing a browser or
  HTTP client implementation.
