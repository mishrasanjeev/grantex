# Agent Passport 1.0: SD-JWT VC profile

Status: draft (PRD section 6, "Passport"). Implemented by
`@grantex/agent-passport` (`packages/agent-passport`) and
`grantex-agent-passport` (`packages/agent-passport-py`), both at 0.1.0 and not
yet published. Both pass the shared vectors in
[`examples/agent-passport-vectors.json`](examples/agent-passport-vectors.json).

The **Agent Passport** is the credential an accredited issuer gives an AI
agent. It says who provides the agent, what software it is, what the issuer
checked and which key the agent holds. This document profiles SD-JWT VC for it.
The primary rendering is SD-JWT VC; a secondary rendering as a W3C VC secured
with VC-JOSE-COSE is planned for Phase 3 and is not specified here.

Keywords MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

Normative references:

- RFC 9901, Selective Disclosure for JSON Web Tokens (SD-JWT).
- draft-ietf-oauth-sd-jwt-vc-19, SD-JWT-based Verifiable Digital Credentials.
- draft-ietf-oauth-status-list-21, Token Status List (section 6.2, the `status`
  claim; section 7.1, status values; section 8.3, validation).
- W3C Decentralized Identifiers (DIDs) v1.0, section 3.1 (DID Syntax).
- RFC 7515 (JWS), RFC 7518 (ES256), RFC 8037 (EdDSA, OKP thumbprints),
  RFC 7638 (JWK thumbprint), RFC 7800 (`cnf`).

## 1. Format

An Agent Passport is an SD-JWT (RFC 9901 section 4):

```
<Issuer-signed JWT>~<Disclosure 1>~...~<Disclosure N>~[<KB-JWT>]
```

Without a Key Binding JWT the string ends with `~`. A presentation carries the
disclosures the holder chose, in any order, and, where the relying party asks
for key binding, a KB-JWT (section 5).

| Header | Value |
|---|---|
| `typ` | `dc+sd-jwt` (draft-ietf-oauth-sd-jwt-vc section 2.2.1; media type `application/dc+sd-jwt`, section 2.1). The earlier `vc+sd-jwt` is refused. |
| `alg` | `ES256` (P-256) is REQUIRED to verify. `EdDSA` (Ed25519) MAY be accepted when the relying party turns it on; it is off by default. Every other value, including `none`, is refused. |
| `kid` | OPTIONAL; when present it selects the issuer key. |
| `jku`, `x5u`, `jwk`, `x5c` | MUST NOT be present. Issuer keys come only from the relying party's trust configuration (section 8). |
| `crit` | MUST NOT be present. |

## 2. Claims

Claims in the clear (never disclosures):

| Claim | Rule |
|---|---|
| `iss` | The issuer's `entity_id`, an `https` URL. |
| `sub` | The agent's DID: the whole value matches the `did` rule of W3C DID Core section 3.1 (`"did:" method-name ":" method-specific-id`, where `method-name` is lower-case letters and digits and `method-specific-id` is colon-separated `idchar`s (`ALPHA / DIGIT / "." / "-" / "_" / pct-encoded`) with a non-empty last segment). A DID URL (path, query or fragment) is not a DID and is refused. |
| `vct` | `urn:grantex:agent-passport:1` (draft-ietf-oauth-sd-jwt-vc section 2.2.2.1). |
| `iat`, `exp` | Integers (seconds). `exp` > `iat` and `exp` ≤ `iat` + 31 536 000 (one year of 365 days). |
| `nbf` | OPTIONAL integer. |
| `cnf` | `{"jwk": <agent public key>}` (RFC 7800 section 3.2): a P-256 or Ed25519 public JWK with no private members. |
| `status` | `{"status_list": {"uri": <string>, "idx": <non-negative integer>}}`, a Token Status List reference (draft-ietf-oauth-status-list section 6.2). |
| `_sd`, `_sd_alg` | The digests of the disclosures, sorted, and `sha-256`. |

`iss`, `nbf`, `exp`, `cnf`, `vct`, `vct#integrity`, `aka_vcts` and `status`
MUST NOT be disclosures (draft-ietf-oauth-sd-jwt-vc section 2.2.2.3). This
profile also keeps `sub` and `iat` in the clear.

Selectively disclosable claims, one disclosure each:

| Claim | Members |
|---|---|
| `provider` | `did` (REQUIRED, a DID with the same syntax as `sub`), `legal_identifiers` (array), `name` (string). |
| `agent` | `software_name` and `software_version` (REQUIRED, non-empty strings), `cimd_uri` (`https` URL of the client metadata document), `categories` (array of strings), `declared_limits` (object). |
| `verification` | `level` (REQUIRED, non-empty string), `types` (array of strings), `performed_at` (integer, seconds). |
| `attestation_id` | Non-empty string: the attestation this passport was issued from. |

Members not listed are allowed and returned unchanged. A disclosed claim that
does not have the listed shape is refused (`bad_claim`).

## 3. Disclosures and digests

A disclosure is `base64url(UTF-8(JSON([salt, name, value])))`, or
`[salt, value]` for an array element (RFC 9901 sections 4.2.1 and 4.2.2). Each
salt carries at least 128 random bits (section 9.3). A digest is
`base64url(SHA-256(US-ASCII(disclosure)))` (section 4.2.3). Issuers put the
digests in `_sd` in sorted order so the order of the claims is not revealed.

A verifier rebuilds the claims as RFC 9901 section 7.1 describes, including
nested `_sd` arrays and `{"...": digest}` array elements, and refuses:

- a disclosure presented twice (`duplicate_disclosure`);
- a digest that appears twice in the payload and the disclosures (`duplicate_digest`);
- a disclosure whose digest is not referenced (`disclosure_not_referenced`);
- a disclosure named `_sd` or `...`, or one of the claims of section 2 that must stay in the clear (`disclosure_name_not_allowed`);
- a disclosure of a name that already exists at its level (`claim_name_conflict`);
- a disclosure that is not base64url JSON of the right form, or an object-property disclosure used as an array element or the reverse (`disclosure_malformed`).

Digests without a disclosure are decoys or withheld claims and are ignored.

## 4. Verification

A relying party verifies in this order and stops at the first refusal. Every
refusal carries a code and a reason (section 9).

1. Split the SD-JWT; refuse empty elements before the last `~` (`not_sd_jwt`)
   and an issuer-signed JWT that is not a compact JWS (`bad_encoding`).
2. Check the header (section 1): `typ`, `alg`, EdDSA only when enabled, no
   key-bearing member, no `crit`.
3. Read `iss`, obtain the issuer's keys from the relying party's resolver, and
   verify the signature (`passport_invalid_signature`). A resolver failure is a
   refusal, not a pass.
4. Check `vct`, `sub`, `iat`, `exp`, `nbf`, `status` and `_sd_alg`; the
   lifetime (at most one year); then the time: `iat` or `nbf` after now plus
   skew is `not_yet_valid`, now at or after `exp` plus skew is `expired`
   (`passport_expired`). Clock skew defaults to 0.
5. Check `cnf` (section 7).
6. Rebuild the claims from the disclosures (section 3) and check the shape of
   the profile claims (section 2).
7. If the relying party requires key binding, verify the KB-JWT (section 5).
   If it does not, a presentation that carries a KB-JWT is refused
   (`unexpected_key_binding`).
8. Check the status (below).

**Status is required, and verification fails closed without it.** A relying
party MUST NOT accept a passport without resolving `status.status_list`
(`uri`, `idx`) through its own status-list component, as
draft-ietf-oauth-status-list-21 section 8.3 describes (fetch the Status List
Token from `uri`, verify its signature with the issuer's keys from the relying
party's trust configuration, read the value at `idx`), and:

- refuse with `passport_revoked` when the value is not `VALID` (0x00), which
  includes `INVALID` (0x01) and `SUSPENDED` (0x02) (section 7.1);
- refuse with `status_stale` when it has no Status List Token that is still
  fresh by its `exp` and `ttl` (section 13.7), including when the fetch or the
  signature check fails. An unknown status is a refusal, never a pass.

`verifyPassport` / `verify_passport` require the caller to choose one of two
ways to meet this, and refuse to run (a `TypeError` / `ValueError`, not a
`PassportError`) with neither or both:

- a status resolver (`statusResolver` / `status_resolver`), a function of
  (`uri`, `idx`) that answers `valid`, `invalid` or `suspended` from the
  relying party's status-list component. The library calls it after steps 1
  to 7 pass, and refuses `invalid` (`status_invalid`) and `suspended`
  (`status_suspended`) with `passport_revoked`, and a resolver that throws or
  answers anything else with `status_stale` (`status_unresolved`,
  `status_unknown`);
- `statusCheckedBy: 'caller'` / `status_checked_by="caller"`, the caller's
  statement that it resolves the status itself, as above, before accepting.

The result's `statusCheckedBy` / `status_checked_by` (`resolver` or `caller`)
records which applied.

## 5. Key binding

A holder proves possession of the `cnf` key with a KB-JWT (RFC 9901 section
4.3): header `typ` `kb+jwt`, `alg` matching the `cnf` key (ES256 for P-256,
EdDSA for Ed25519), and claims `iat`, `aud`, `nonce` and `sd_hash`, where
`sd_hash` = `base64url(SHA-256(US-ASCII(<Issuer-signed JWT>~<Disclosure>~...~)))`
over the SD-JWT exactly as presented (section 4.3.1).

A relying party that requires key binding gives its `aud` and the `nonce` it
issued, and refuses:

| Failure | Code | Reason |
|---|---|---|
| No KB-JWT | `key_unproven` | `key_binding_missing` |
| Wrong `typ`, `alg`, a key-bearing or `crit` header member, a missing claim, `aud` not a string | `key_unproven` | `kb_malformed` |
| Not signed by the `cnf` key | `key_binding_mismatch` | `kb_signature_mismatch` |
| Another `aud` | `audience_mismatch` | `audience_mismatch` |
| Another `nonce` | `key_unproven` | `nonce_mismatch` |
| `iat` after now plus skew, or older than the maximum age (300 s by default) | `key_unproven` | `kb_stale` |
| `sd_hash` does not match the disclosures presented | `key_binding_mismatch` | `sd_hash_mismatch` |

## 6. Hash rule

```
externalCredentialHash(compact) = "sha-256:" + base64url(SHA-256(US-ASCII(issuer-signed JWT)))
```

The issuer-signed JWT is the part of the SD-JWT before the first `~`.
Disclosures and the KB-JWT are **never** hashed, so every presentation of one
passport, whatever it discloses and in whatever order, has the same hash, and
any change to the issuer-signed JWT changes it. Input without a `~`, or whose
first part is not a compact JWS, is refused. The registry records passports by
this hash.

The hash identifies the exact bytes of the issuer-signed JWT, not the
passport's content. An ES256 signature `(r, s)` has a second valid form
`(r, n - s)` (n the P-256 group order), and neither library refuses it, so a
holder can turn one passport into a second issuer-signed JWT that verifies and
has a different hash. Refusing the high-`s` form would refuse passports from
issuers whose signers do not normalise `s`, which JWS (RFC 7515, RFC 7518
section 3.4) does not require. So:

- a registry MAY look a passport up by this hash only to find one the issuer
  registered, where a different hash finds nothing and fails closed
  (`attestation_not_registered`);
- a relying party MUST NOT rely on the hash alone to deny, deduplicate or
  count passports (a deny list, a single-use rule). Use the Token Status List
  entry (`status.status_list` `uri` and `idx`) or `attestation_id` for that.

## 7. Key rule and P-256 rule

Two keys are the same key when their JWK SHA-256 thumbprints are equal
(RFC 7638 section 3), computed over the required members only: `crv`, `kty`,
`x`, `y` for EC; `crv`, `kty`, `x` for OKP (RFC 8037 section 2); `e`, `kty`,
`n` for RSA. `kid`, `alg`, `use` and private members do not change the
thumbprint, so a key registered with a `kid` equals the same key in `cnf`
without one.

`cnf.jwk` MUST be a P-256 or Ed25519 public key; a missing `cnf` is
`cnf_missing`, private members are `cnf_private_key`, any other key is
`cnf_unsupported_key`. On payments rails (`paymentsRails` / `payments_rails`)
the `cnf` key MUST be P-256 (`passport_not_accepted`, `cnf_not_p256`): the
agent's proofs on those rails are ES256 signatures by the `cnf` key.

## 8. Issuer keys

Issuer keys come only from the relying party's resolver, which answers from
its own trust configuration (the registry). A verifier MUST NOT fetch keys
from a URL in the token and MUST NOT use a key carried in it (PRD section 13),
so `jku`, `x5u`, `jwk` and `x5c` in the header are refused before the
resolver is called. A resolver that fails, or returns something other than a
list, is `issuer_key_resolution_failed`; no key for the `kid` and `alg` is
`issuer_key_not_found`; a private key or a point off the curve from the
resolver is `issuer_key_invalid`. JWT VC Issuer Metadata
(draft-ietf-oauth-sd-jwt-vc section 4) is not used.

## 9. Refusal codes

| Code | Reasons |
|---|---|
| `passport_malformed` | `not_sd_jwt`, `bad_encoding`, `wrong_typ`, `alg_not_allowed`, `header_key_not_allowed`, `crit_not_supported`, `bad_claim`, `sd_alg_not_supported`, `cnf_missing`, `cnf_private_key`, `cnf_unsupported_key`, `duplicate_disclosure`, `duplicate_digest`, `disclosure_malformed`, `disclosure_not_referenced`, `disclosure_name_not_allowed`, `claim_name_conflict`, `unexpected_key_binding`, `bad_key` |
| `passport_not_accepted` | `wrong_vct`, `lifetime_exceeds_one_year`, `cnf_not_p256`, `eddsa_not_enabled` |
| `passport_invalid_signature` | `signature_mismatch`, `issuer_key_not_found`, `issuer_key_invalid`, `issuer_key_resolution_failed` |
| `passport_expired` | `expired`, `not_yet_valid` |
| `key_unproven` | `key_binding_missing`, `kb_malformed`, `nonce_mismatch`, `kb_stale` |
| `key_binding_mismatch` | `kb_signature_mismatch`, `sd_hash_mismatch` |
| `audience_mismatch` | `audience_mismatch` |
| `passport_revoked` | `status_invalid`, `status_suspended` |
| `status_stale` | `status_unresolved`, `status_unknown` |

`passport_invalid_signature`, `passport_expired`, `key_unproven`,
`key_binding_mismatch` and `audience_mismatch` are registry denial codes.
`passport_malformed` and `passport_not_accepted` are specific to this profile;
`passport_revoked` and `status_stale` are the status refusals of section 4.

## 10. Shared vectors

[`examples/agent-passport-vectors.json`](examples/agent-passport-vectors.json)
holds accepted and refused passports and presentations with the options to
verify them and the expected claims or code and reason; the Token Status List
values the verify vectors are resolved against (`statusLists`) and status
vectors that re-check an accepted passport against other values or a failing
resolver (`status`); hash-rule inputs,
thumbprints (including the RFC 7638 section 3.1 and RFC 8037 appendix A.3
examples) and key-equality cases. The keys are synthetic, generated for the
file with their private halves discarded; only public keys and signed outputs
are stored. `npm run vectors` in `packages/agent-passport` regenerates it, and
both packages' test suites check every vector.
