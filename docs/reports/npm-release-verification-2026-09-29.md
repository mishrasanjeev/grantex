# npm Release Verification: September 29, 2026

## Published Artifacts

Both exact versions are available from the public npm registry, and each
package's `latest` dist-tag points to the version below. Registry SHA-1 and
SHA-512 values match the validated local release archives.

| Package | Version | SHA-1 |
| --- | --- | --- |
| `@grantex/sdk` | `0.8.1` | `008ecc34657353f7af5ce62fbd7bb0a65f3e1bcc` |
| `@grantex/mcp-auth` | `4.0.0` | `7a1472371ff83268afda276c9b99c6e2e655baef` |

SDK integrity:

```text
sha512-9oiRKEDjfXi8cE3atWqxEs4RN5VDsggn3fmDNa3ZkJquvRHxtU4wJzWvqRkQG7/5Dbq5e/O/BPRwK9bNkj/mAw==
```

MCP Auth integrity:

```text
sha512-BZyr58p1VDmZyResYvyK3D8NL93YYb88hA9AHUhhNK69sXz3C3lWQD+uBeZpf9VFSoO3jHCR+RXnK1OnDF40eQ==
```

MCP Auth requires `@grantex/sdk >=0.8.1 <1`.

## Validation

- The broader SDK authority audit passed 6,211 package tests, plus 155 execution-boundary checks. See [the audit report](sdk-authority-audit-2026-09-29.md); these totals overlap the release tests and must not be added together.
- Final MCP release validation passed 396 unit tests, 63 PostgreSQL/Redis/restart integration tests and 9 real Chromium browser tests: 468 passes, with two existing unit-test skips.
- Both packed archives passed a clean consumer installation and the artifact verification script.
- A separate disposable Docker consumer installed the exact public-registry versions with no local package links. Rendered human consent, real SDK principal handoff, callback, code exchange, refresh, current authority, revocation and outage checks passed.
- The release helpers are `tests/sdk-authority/run-npm-release.sh` and `tests/sdk-authority/verify-npm-registry.sh`.

## Upgrade

```bash
npm install @grantex/sdk@0.8.1 @grantex/mcp-auth@4.0.0
```

MCP Auth 4 is a breaking release: the host must supply an authenticated
human-principal resolver instead of treating an OAuth client identity as the
human. Configure trusted current-grant verification and durable shared storage
for production. A rendered consent page does not itself authenticate a human
or provision WebAuthn.

SDK 0.8.1 adds opt-in per-invocation issuer-authority verification and trusted
principal/agent binding. Offline verification defaults remain unchanged;
signature verification alone is not current-state enforcement.

## Boundaries

Python 0.7.1, the audited Go changes and changed integration packages remain
source candidates, not new registry releases. This publication did not deploy
the hosted service, push a Git commit, or update live documentation. Release
source and documentation are still local pending integration. No claim of
independent interoperability certification or universal configuration safety
is made.
