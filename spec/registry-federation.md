# Registry issuers and trust marks

Status: draft, Agent Trust Registry Phase 1. Sections 1 to 5 are implemented
by the auth service (`apps/auth-service`: `routes/registry-issuers.ts`,
`lib/registry/issuers.ts`, migration 121). Section 6 describes Phase 2 and is
not implemented.

The registry records **accredited issuers**: organisations whose Agent
Passports and attestations it accepts. This document defines the issuer
record, the trust mark taxonomy and the rules a relying party, and the
registry itself, apply when deciding whether an issuer may be relied on for a
given claim.

Keywords MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## 1. Roles

| Role | Credential | Can |
|---|---|---|
| Registry operator | A key from `REGISTRY_OPERATOR_API_KEYS` of the auth service | Accredit an issuer; suspend, reinstate or withdraw it; change its trust marks; replace its JWK Set; revoke one of its keys. |
| Accredited issuer | Its signing keys, as recorded | Issue Agent Passports and attestations covered by its trust marks. |
| Relying party | None for the public list | Read the public issuer list and decide whether to rely on an issuer's signature. |

An issuer never writes its own record. Accreditation evidence stays with the
operator; the record carries only an opaque reference to it.

## 2. The issuer record

| Member | Type | Rules |
|---|---|---|
| `entity_id` | string | REQUIRED. An Entity Identifier as defined in OpenID Federation 1.0, section 1.2: a URL using the `https` scheme with a host component, optionally a port and a path, and no query or fragment component. In addition the registry refuses userinfo and any form other than the WHATWG URL serialisation of the same URL (lower-case host, no default port, no dot segments), except that a bare origin MUST be written without the final `/` (`https://issuer.example`, not `https://issuer.example/`), so one origin has one spelling. Unique in the registry. |
| `did` | string | OPTIONAL. A DID for the issuer. |
| `jwks` | object | REQUIRED. A JWK Set, section 3. |
| `trust_marks` | array of string | REQUIRED, MAY be empty. Trust mark types, section 4, each at most once. |
| `status` | string | `active`, `suspended` or `withdrawn`, section 5. Set by the registry: `active` on accreditation. |
| `suspended_effective_from` | date-time | Present exactly when `status` is `suspended`: the time from which the suspension is in effect. MAY be in the future. |
| `status_list_base` | string | REQUIRED. An `https` URL, as for `entity_id`, that ends in `/`. Every status list of the issuer's passports MUST be under this prefix; a status list URL that is not is not accepted for the issuer. The final `/` prevents a prefix such as `https://issuer.example/status` from also covering `https://issuer.example/status-other/`. |
| `events_endpoint` | string | OPTIONAL. An `https` URL, as for `entity_id`. Recorded only in Phase 1. |
| `data_residency` | string | OPTIONAL. A short region label, at most 64 characters. |
| `accredited_at` | date-time | Set by the registry. |
| `accreditation_evidence_ref` | string | REQUIRED. An opaque reference, 1 to 256 characters from `A-Z a-z 0-9 . _ : / -`, starting with a letter or digit. It MUST NOT be the evidence. |
| `revoked_keys` | array | Set by the registry: `{kid, revoked_at}` for each revoked kid, section 3. |

### 2.1 Public view

The public list, `GET /v1/registry/issuers`, carries only `entity_id`,
`trust_marks`, `status`, `status_list_base` and `jwks` for each issuer. In it:

- `status` is the status in effect at the time of the response (section 5), so
  a suspension scheduled for later reads `active`;
- `jwks` leaves out every revoked kid, and is empty for a withdrawn issuer.

The response carries an `ETag` computed over its body. A relying party SHOULD
send it back in `If-None-Match`; an unchanged list answers `304`. The response
carries `Cache-Control: no-cache` (RFC 9111 section 5.2.2.4), so a cache
revalidates every read and a revoked key or a suspension that has taken effect
is not served from it. The list is limited per client address.

## 3. Keys

In Phase 1 an issuer's keys are a static JWK Set recorded at accreditation.

- `jwks` MUST be a JWK Set (RFC 7517 section 5) whose only member is `keys`,
  holding 1 to 16 keys, and at most 16384 bytes as JSON.
- Each key MUST be a public key of one of these types:
  - `kty` `EC`, `crv` `P-256`, with `x` and `y` each the base64url encoding of
    the full 32-byte coordinate (RFC 7518 section 6.2.1), for `ES256`
    (RFC 7518 section 3.4). Support is REQUIRED.
  - `kty` `OKP`, `crv` `Ed25519`, with `x` the base64url encoding of the
    32-byte public key (RFC 8037 section 2), for `EdDSA` (RFC 8037 section
    3.1). Support is OPTIONAL for relying parties; the registry accepts it.
- A key MUST NOT carry a private or symmetric member: `d` (RFC 7518 section
  6.2.2, RFC 8037 section 2), `p`, `q`, `dp`, `dq`, `qi`, `oth` (RFC 7518
  section 6.3.2) or `k` (RFC 7518 section 6.4).
- Each key MUST have a `kid` of 1 to 128 printable ASCII characters, and no
  two keys in the set may share one. (RFC 7517 section 4.5 makes distinct
  kids a SHOULD; a verifier choosing a key by kid needs exactly one.)
- `alg`, if present, MUST be `ES256` for an EC key and `EdDSA` for an OKP key;
  the registry records it either way. `use`, if present, MUST be `sig`;
  `key_ops`, if present, MUST be `["verify"]`, and a key MUST NOT have both
  (RFC 7517 section 4.3). No other member is accepted.
- The point MUST be a valid public key for its curve.

**Revocation.** The operator revokes a key by `kid`. From then on the
registry does not serve that key, and a replacement set that carries the same
`kid` is refused: a revoked kid does not come back. A relying party MUST NOT
verify with a key the current public list does not carry.

## 4. Trust marks

A trust mark type names what an accredited issuer may attest. Phase 1 defines
five, and the registry refuses any other value:

| Trust mark type | The issuer may attest |
|---|---|
| `urn:grantex:tm:provider.entity` | that the agent provider is a registered legal entity |
| `urn:grantex:tm:provider.ownership` | who owns and controls the agent provider |
| `urn:grantex:tm:provider.screening` | that the agent provider has been screened |
| `urn:grantex:tm:agent.identity` | the identity of a specific agent |
| `urn:grantex:tm:agent.security` | the security review of a specific agent |

Trust mark types are compared as exact strings. In Phase 1 a trust mark is
the operator's entry in the issuer record, not a signed Trust Mark JWT
(section 6).

## 5. Status and accreditation checks

At a time `t`, an issuer is:

- **not accredited** if the registry has no record for its `entity_id`, or
  its `status` is `withdrawn`;
- **suspended** if its `status` is `suspended` and `t` is at or after
  `suspended_effective_from`;
- **accredited** otherwise.

An issuer is accredited **for** a trust mark type at `t` when it is accredited
at `t` and its `trust_marks` contain that type. A check answers, in this
order:

| Condition | Denial code |
|---|---|
| unknown or withdrawn | `issuer_not_accredited` |
| suspended at `t` | `issuer_suspended` |
| the type is not in `trust_marks`, or not in the taxonomy | `trust_mark_missing` |

Any failure to read the record MUST be treated as a refusal, never as
accredited. Reinstating an issuer (`status` back to `active`) clears
`suspended_effective_from`.

Every change to an issuer record is appended, with the operator's reason, to
the registry's audit chain in the same transaction as the change
(`grantex.registry.issuer_accredited`, `grantex.registry.issuer_updated`).

## 6. Phase 2: OpenID Federation (not implemented)

Phase 2 resolves issuer keys and trust marks through OpenID Federation 1.0
instead of the static record: the registry acts as a Trust Anchor, issuers
publish Entity Configurations at their Entity Identifiers, and trust marks
are signed Trust Mark JWTs whose `trust_mark_type` claim (OpenID Federation
1.0 section 7.1) carries the types of section 4. Because `entity_id` is already
an Entity Identifier, Phase 1 records carry over unchanged. Until Phase 2
ships, relying parties MUST use the public list of section 2.1 and MUST NOT
expect Federation endpoints.
