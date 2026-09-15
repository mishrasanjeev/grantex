# Findings

Defects found while doing other work and deliberately left out of that change.
Each entry says where it was found, what is wrong and what fixing it involves.
Remove an entry in the pull request that fixes it.

## G-1 — OpenSSL in the auth-service base image has a fixable HIGH advisory

- **Found:** container scan of `apps/auth-service` (2026-09-14).
- **What:** `node:26-alpine@sha256:2d984a15…` ships `libcrypto3` and `libssl3`
  3.5.7-r0, affected by CVE-2026-14456 (fixed in 3.5.8-r0).
- **Fix:** move the pinned base image digest in `apps/auth-service/Dockerfile`
  to a build carrying openssl 3.5.8-r0 or later, rebuild, rescan and drop the
  two entries from `.trivyignore.yaml`.

## G-2 — npm's bundled dependencies in the runtime image have fixable HIGH advisories

- **Found:** container scan of `apps/auth-service` (2026-09-14).
- **What:** the base image's global npm carries `brace-expansion` 5.0.7
  (CVE-2026-14257, CVE-2026-69152), `ip-address` 10.2.0 (CVE-2026-69192) and
  `tar` 7.5.19 (CVE-2026-73566). These are npm's own dependencies, not the
  service's, but they are present in the production image.
- **Fix:** a newer base image, or removing npm from the runtime stage once
  dependencies are installed (the service runs with `node`, not `npm`).

## G-3 — Native TypeScript compiler binary is shipped in the production image

- **Found:** container scan of `apps/auth-service` (2026-09-14).
- **What:** `npm ci --omit=dev` still installs `typescript` and
  `@typescript/typescript-linux-x64` into `/app/node_modules`, pulled in by a
  production dependency (at least `@opentelemetry/instrumentation-grpc`
  references it). The Go-built binary carries ten fixable HIGH advisories in
  its Go standard library and `golang.org/x/text`. The runtime does not need a
  compiler.
- **Fix:** find the dependency path (`npm ls typescript --omit=dev` in
  `apps/auth-service`), then exclude it from the runtime install or prune it in
  the Dockerfile, and drop the ten entries from `.trivyignore.yaml`.

## G-4 — The OAuth agent-grants flow does not validate tools entries in `authorization_details`

- **Found:** adding purpose-bound grants (2026-09-15).
- **What:** `POST /oauth/par` in `apps/auth-service/src/routes/oauth.ts` accepts
  any typed `authorization_details` objects from the client and copies them
  into the consented grant and its access token. A `urn:grantex:tools:v1`
  entry pushed there is not checked. It can carry a purpose outside the
  vocabulary, an unknown key, or duplicate connectors, all of which
  `POST /v1/authorize` refuses and the SDKs' `enforce()` denies. The consent
  page shows such entries only as raw JSON, and `grants.purpose` is not set
  for OAuth grants.
- **Fix:** validate `urn:grantex:tools:v1` entries in the PAR handler with the
  same rules as `apps/auth-service/src/lib/purpose.ts` and the SDK parsers
  (known purpose, connector name, no unknown keys, one entry per connector,
  well-formed `tools` and `caps`). Reject with `invalid_authorization_details`,
  persist the purpose on the grant, and show it on the consent page.

## G-5 — Duplicate keys in a manifest JSON file are silently accepted

- **Found:** adding manifest schema 0.6 (2026-09-15).
- **What:** `ToolManifest.from_file` (Python, `json.loads`) and
  `ToolManifest.fromFile` (TypeScript, `JSON.parse`) keep the last value of a
  repeated key. A manifest that declares the same tool twice, for example first
  with `requires_decision: true` and then as `"read"`, loads as the second
  declaration without any error. JSON Schema validators cannot see the
  duplicate either, because they validate the parsed object.
- **Fix:** reject duplicate keys while parsing manifest files: in Python an
  `object_pairs_hook` that raises `ManifestValidationError`; in TypeScript a
  duplicate-aware parse, for example a small tokenizer or a vetted
  duplicate-detecting JSON parser. Add a shared invalid fixture that both
  loaders must reject.

## G-6 — Verifiers outside the core SDKs pin RS256

- **Found:** adding ES256 signing (2026-09-15).
- **What:** these reject every token or key from a deployment that sets
  `JWT_SIGNING_ALG=ES256`, and some already disagree with the default JWK Set:
  - `packages/cli/src/commands/verify.ts` calls `jwtVerify` with
    `algorithms: ['RS256']`.
  - `packages/gemma/src/verifier/jwks-cache.ts` and `offline-verifier.ts`, and
    `packages/gemma-py/src/grantex_gemma/_verifier.py`, accept only RS256.
  - `packages/mpp/src/verifier.ts` verifies agent passports with RS256 only;
    passports are signed with the platform signing key.
  - `packages/conformance/src/suites/security.ts` ("JWKS only contains RS256
    keys") fails whenever the JWK Set holds any other key. The auth service
    always publishes an EdDSA key (`initEdKey` generates one), so this check
    already fails against a default deployment.
- **Fix:** accept `RS256` and `ES256` with key-type matching by `kid` (as the
  core SDKs now do), and change the conformance check to "every platform
  signing key is RS256 or ES256 with `kid`, `alg` and `use: sig`", ignoring
  keys published for other purposes.

## G-7 — The default RS256 `kid` changes when an instance restarts in a new month

- **Found:** adding ES256 signing (2026-09-15).
- **What:** the env-store RS256 key's `kid` is `grantex-YYYY-MM` of the process
  start date (`legacyRsaKid` in `apps/auth-service/src/lib/signing-keys.ts`,
  previously `buildKid` in `crypto.ts`). The same key gets a new `kid` after a
  restart in a new month, and two instances started in different months
  publish different `kid`s for one key. SDK verifiers select keys by `kid`, so
  tokens signed before the restart, or by the other instance, fail
  verification until they expire.
- **Fix:** default the `kid` to the RFC 7638 thumbprint (as ES256 and stored
  keys already do) in a release that announces the `kid` change, publishing
  the old `kid` alongside for one token lifetime. Until then, set
  `JWT_SIGNING_KID` (documented in `docs/self-hosting.md` Section 7).
