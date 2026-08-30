# DAAP Revision 03 Brutal Review

**Review date:** 2026-08-30

**Reviewed candidate:** `draft-mishra-oauth-agent-grants-03`

**Published baseline:** `draft-mishra-oauth-agent-grants-02`

## Verdict

Do not submit revision `-03` before 2026-09-09. The final review window is
2026-09-06 through 2026-09-09. That hold is deliberate: the new
role-specific implementation needs independent code review, deployment review,
production E2E, and time for protocol scrutiny before the document date is
refreshed and artifacts are rebuilt one final time.

The source now implements the candidate's client, authorization-server, and
resource-server requirements in a self-contained Docker test. This closes the
previous "no conforming implementation" code gap. It does not create IETF
endorsement, OAuth WG adoption, independent certification, or evidence from a
second implementation.

Submission blockers in the document syntax: **0**.

Submission blockers in the evidence/release process: **4**.

1. The exact source snapshot must receive review beyond its authoring agent.
2. Production endpoints and Firebase rewrites are not yet deployed and tested.
3. The current artifacts are clean but must be rebuilt if the final review
   changes the draft or its upload date.
4. One final review must compare the normative requirements, implementation
   matrix, and production behavior without relying on self-description.

## Implementation Findings Closed

| Previous finding | Resolution |
|:-----------------|:-----------|
| No standard authorization endpoint | Added a PAR-only browser authorization endpoint with exact client/request URI binding and RFC 9207 `iss`. |
| No PAR lifecycle | Added 90-second, single-use RFC 9126 request URIs with exact redirect/resource/scope/PKCE/state validation. |
| No DPoP code binding | Added `dpop_jkt` and DPoP-header binding at PAR and matching fresh proof enforcement at token exchange. |
| No end-to-end DPoP | Added signature, algorithm, public-JWK, method, URI, freshness, replay, `ath`, and `cnf.jkt` checks. Bearer downgrade is rejected. |
| Incomplete RFC 8414 metadata | Metadata now advertises all standard endpoints, grant types, RFC 9207, S256, DPoP algorithms, and accurate public-client authentication methods. |
| No RFC 8693 endpoint | Added same-client, same-key, same-resource exact-scope attenuation at the standard token endpoint. |
| No RFC 7009 endpoint | Added access-token revocation and full refresh-family invalidation with non-disclosing responses. |
| Refresh not bound to current key | Refresh now checks both the grant binding and the current registered key; retired keys cannot issue new tokens. |
| Legacy endpoint crossover | Standard grants/codes are rejected by legacy exchange, refresh, and cross-agent delegation paths; the standard resource and exchange paths reject legacy grants. |
| No conforming client | Added `OAuthAgentClient` with metadata validation, PAR, one-time state/PKCE, issuer validation, DPoP presentation, refresh, attenuation, and revocation. |
| Consent omitted structured constraints | The live view now displays the resource, developer, lifetimes, scopes/consequences, and integrity-protected authorization details. |
| Constraints lost after issuance | Structured authorization details are stored on the grant and preserved through refresh and attenuation. |
| Uploaded key treated as possession | PAR records possession only after a valid DPoP proof; bare `dpop_jkt` is accepted only for a previously verified current key. |
| Agent Key could be shared between instances | Migration 090 adds a unique non-null Agent Key thumbprint index; registration and rotation surface conflicts without replacing another instance's binding. |
| Profile tokens carried legacy short claims | Added a standards-only OAuth signer/verifier. Profile tokens and the resource route use `client_id`, `scope`, `aud`, `cnf`, `act`, and `authorization_details` without requiring `scp`, `agt`, `dev`, or `grnt`. |
| OAuth secrets inherited ULID entropy | PAR handles, authorization codes, and profile refresh tokens now use 256-bit cryptographic random values. |
| Token responses lacked explicit cache prevention | `/oauth/token` now returns `Cache-Control: no-store` and `Pragma: no-cache` for success and error responses. |
| Client accepted duplicated callback parameters | The SDK rejects duplicate `state`, `iss`, `code`, and error parameters, validates token-response shape, and implements the RFC 8414 path-issuer well-known location. |
| PAR silently required `login_hint` | The parameter is now optional. Sandbox has an isolated test principal, and live consent atomically binds an interactive principal selection to the passkey challenge before approval or denial. |
| Profile state blocked agent deletion | PAR foreign keys and explicit route cleanup now remove profile state; fresh Docker E2E asserts zero residual agent/PAR rows. |
| No database-backed profile test | Added a Docker E2E covering positive flow, revocation, replay, bearer downgrade, scope attenuation, and key rotation. |

## Remaining P1 Risks

### No Independent Interoperability Evidence

All current client/AS/RS testing is within one repository. A second
implementation may interpret edge cases differently. Before asking for WG
adoption, stabilize the published vendor-neutral vectors and recruit at least
one independent client or authorization-server implementer.

### Production Is Not Yet the Tested Source

The workstation Docker image is green, but the hosted Cloud Run and Firebase
issuer do not become conforming because local code exists. Do not use a hosted
conformance claim until the exact commit is deployed and the production OAuth
E2E passes through `https://grantex.dev`.

### Principal Enrollment Is Operationally Sensitive

Live consent requires a request-bound WebAuthn assertion, so a developer API
key alone cannot approve. However, trustworthy principal identity proofing,
passkey enrollment, recovery, and deprovisioning remain deployment
responsibilities. The draft should not imply that WebAuthn cryptography proves
the real-world identity asserted during enrollment.

### Crowded OAuth Agent Draft Landscape

AAP, AI Agent Instance, Client Instance Assertion, PACT, delegated
authorization, actor chains, identity chaining, transaction tokens, and
attenuating-token work continue to overlap. The strongest differentiation
remains human authorization plus a strict OAuth deployment profile plus
same-instance attenuation, without new token claim aliases.

## Remaining P2 Risks

- There is no machine-readable DAAP profile identifier. `-03` correctly avoids
  inventing one without consensus or an IANA plan.
- Registration policy is administratively provisioned. Dynamic registration
  fields for resources, scopes, and instance keys remain outside the draft.
- The built-in resource route demonstrates the resource-server role, but broad
  third-party resource integration still needs reusable middleware and
  independent tests.
- Revoked JWT residual lifetime remains deployment-specific. The reference
  access-token lifetime is five minutes plus online status enforcement.
- The SDK client is TypeScript-only. Python and Go SDKs still expose the legacy
  product API and must not be called DAAP-conforming clients.

## Verification Evidence

- Auth-service typecheck passed.
- Auth service: 164 test files passed, 1 skipped; 2,097 tests passed, 2 skipped.
- TypeScript SDK: 30 test files and 444 tests passed; build and typecheck passed.
- Docker OAuth E2E passed every protocol stage and negative case.
- Docker E2E: 21 files and 253 tests passed with no failures when run
  file-by-file against an isolated, fresh database.
- All 90 migrations applied successfully in Docker.
- Postgres and Redis remained healthy. The final OAuth run left no residual
  agent/PAR rows, confirmed the Agent Key uniqueness index, and emitted no
  error-level service logs.

The rebuilt draft passed IETF Author Tools with 0 errors, 0 flaws, 1 Unicode
warning, and 1 non-blocking heuristic comment. It was rendered with
`kramdown-rfc2629` 1.7.43 and `xml2rfc` 3.33.0. Validation must be repeated if
the final review changes the source or upload date.

## Submission Gate On Or After 2026-09-09

1. Review and commit the implementation without unrelated or generated-output
   contamination.
2. Deploy the exact commit to Cloud Run and Firebase, then run the OAuth profile
   and complete production E2E suites.
3. Re-read every `MUST` and `MUST NOT` against tests and production behavior.
4. Stabilize the vendor-neutral test vectors and invite an independent
   implementation to publish results against them.
5. Change the draft date to the actual upload date.
6. Rebuild `.xml`, `.txt`, and `.html` from the exact Markdown source.
7. Run IETF Author Tools submission-mode idnits and reference checks again.
8. Review the complete `-02` to `-03` diff and verify author metadata.
9. Upload only after Sanjeev Kumar gives a new explicit submission confirmation.

**Submission recommendation:** HOLD until the review is complete and at least
2026-09-09. Reassess during the 2026-09-06 to 2026-09-09 window. Do not upload
automatically; require a new explicit approval.
