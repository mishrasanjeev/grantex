# Portable WebAuthn SDK Release Verification

Release date: 2026-09-28 (Asia/Calcutta).
Source snapshot: `a919ea8a47a82a3f5c02daf825ae60d458b833d5`.
Release preparation: https://github.com/mishrasanjeev/grantex/pull/1439.
Main artifact verification: https://github.com/mishrasanjeev/grantex/actions/runs/36340236219.

## Published Artifacts

| Artifact | Version | Verification |
| --- | --- | --- |
| TypeScript | `@grantex/sdk@0.7.1` | CLI publication accepted; public SHA-512 integrity matches the tested tarball; fresh npm install and consumer verifier passed; packaged `WebAuthnGrantEvidence` declaration confirmed |
| Python | `grantex==0.6.1` | Authenticated Twine upload; both public PyPI hashes match; fresh no-cache public-index install and evidence-type import passed |
| Go | `github.com/mishrasanjeev/grantex-go@v0.4.1` | Tagged synced commit `02294fd2b0b0241c06f5e4b368bb1419acd82232`; public proxy resolves it; downloaded module's full test suite passed |
| x402 | `@grantex/x402@0.4.1` | Existing release tested with the new primary SDK; not republished |

npm integrity:
`sha512-bG8e4nEm+fVG9BD6ZaKkNilTrZSQNSMBztogDTyNPuNfoWDqPfel/k26/L3XNUvznAxN9tjDfkxb3vV4gPLX9g==`.

PyPI SHA-256:
- Wheel: `6d2b398f6f4f5a81a96beab0dd5cd367b258dd25bfe35b686b56bfc38c6ac69d`.
- Source distribution: `47b8a38e79d761f4feae6014dfa086f25a56786e051efe209cc2aea3fb18050b`.

Go module checksum: `h1:Jkg3eSX3E+tIdbs3U4vYZGZKZfyaR2LwcQZONalvq10=`.
The Go repository accepted an atomic main/tag push using the authenticated
maintainer account and reported a bypass of its PR-only branch rule. Standard,
vet, and race checks passed before the push; downloaded-module tests passed
afterward. Future releases should configure a PR-based release path there.

## Tests And Hosted Configuration

- Full release workflow: TypeScript typecheck, tests, build and pack; x402
  typecheck, tests and pack; packed npm consumer; Python lint, typecheck,
  tests, wheel/sdist build and Twine check; Go tests. All passed.
- Workstation TypeScript source: 1,249 passed, 17 skipped; Python: 1,478
  passed, 20 skipped. Skips are not counted as executed tests.
- Local disposable Docker Postgres plus Chromium passkey suite: 5/5 passed.
- Focused auth-service WebAuthn/consent/credentials tests: 108/108 passed.
- Production Chromium passkey test: passed twice, including a final 112-second
  run. It exercises isolated-account enrollment, live consent, assertion
  evidence and forgery rejection, VC status, refresh, delegation, response
  policies and revocation. It does not use a customer's account.
- Cloud Run `grantex-auth` in `grantex-prod/us-central1` has
  `PASSKEY_ENROLLMENT_ENABLED=true`, `FIDO_RP_ID=grantex.dev`, and
  `FIDO_ORIGIN=https://grantex.dev`. Portable evidence, cascade revocation,
  and stored-evidence status-check flags are enabled.

## Boundaries And Follow-Up

The later SDK enforcement changes in PRs #1440 and #1441 are not in these
immutable artifacts: audience validation in `enforce()` and fail-closed
handling when capped calls omit amounts require a separate versioned release.
Until then, applications must validate audience themselves and pass validated
amounts for capped calls; wrappers that omit amounts are not safe cap enforcers.

Custom assertion UI helper methods are still not exposed by the primary SDKs;
use the documented REST options/verify sequence. Passkey assertions do not
independently establish legal identity, sign grant scopes, or prove current
revocation. Check the trusted issuer, RP ID/origin, assertion and current status.
Virtual-authenticator Chromium tests do not certify every physical device or
browser. Self-hosted defaults remain off and require an origin-specific rollout.

Direct workstation publication did not configure npm/PyPI trusted publishers
or the Go release token for GitHub Actions. Automated publication remains a
separate operator setup task. No credentials or customer identifiers are
included in this report.
