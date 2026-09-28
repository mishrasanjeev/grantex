# Registry federation: issuers, trust marks and acceptance status

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
| Relying party | None for the public list (served only with `REGISTRY_PUBLIC_ENDPOINTS_ENABLED=true`, section 2.1) | Read the public issuer list and decide whether to rely on an issuer's signature. |

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

The list is ordered by `entity_id` and paged: `page` counts from 1 (default
1) and `pageSize` is 1 to 500 (default 100); any other value is refused with
`400`. The response is `{issuers, total, page, pageSize}`, where `total` is the
number of issuers in the registry, read in the same snapshot as the page. A
page past the end has no issuers and still carries `total`. A relying party
that needs the whole list MUST read pages until it holds `total` issuers or a
page is empty, and MUST NOT treat an issuer missing from one page as unknown.

The response carries an `ETag` computed over its body, so one per page. A
relying party SHOULD send it back in `If-None-Match`; an unchanged page answers
`304`. The response carries `Cache-Control: no-cache` (RFC 9111 section
5.2.2.4), so a cache revalidates every read and a revoked key or a suspension
that has taken effect is not served from it. The list is limited per client
address.

The list needs no credential, so the auth service serves it only when
`REGISTRY_PUBLIC_ENDPOINTS_ENABLED` is exactly `true` (default off). Off, the
route is not registered and answers as any unknown route does; the operator
routes and the accreditation checks of section 5 are not affected.

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
## 7. Attestation acceptance status lists

Status: draft. Implemented by the auth service (`apps/auth-service`,
`src/lib/registry/acceptance-status.ts`, `src/routes/registry-status.ts`,
migration `123_registry_acceptance_lists.sql`).

Keywords MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

The registry states, under its own issuer identifier, whether it accepts each
attestation registered with it. An accredited issuer's own status list says
whether the issuer still stands behind an attestation; the registry's
acceptance list says whether the registry still accepts it. A relying party
checks both, and denies with `attestation_not_accepted` when the registry's
entry is not VALID.

The acceptance lists are the registry's own. There is one set of lists for
the whole registry, never one per tenant, and every relying party reads the
same entries.

### Status values

Each entry holds one of the status types of draft-ietf-oauth-status-list-21
§7.1:

| Value | Name | Meaning for the attestation |
|---|---|---|
| `0x00` | VALID | The registry accepts it. Every entry starts here (§13.3). |
| `0x01` | INVALID | The registry has withdrawn its acceptance. Final: an INVALID entry never changes again. |
| `0x02` | SUSPENDED | The registry has suspended its acceptance. It may return to VALID or become INVALID. |

### Publication

Every list is published in two formats. Each is built from the registry's
store; neither is derived from the other.

| Path | Format | Media type |
|---|---|---|
| `GET /status/attestations/{list}` | Token Status List token, draft-ietf-oauth-status-list-21 §5.1 | `application/statuslist+jwt` (§8.2) |
| `GET /status/attestations/{list}/bitstring` | BitstringStatusListCredential, W3C Bitstring Status List v1.0 §2.2, statusPurpose `revocation` (set for INVALID) | `application/vc+jwt` (W3C VC-JOSE-COSE §6.1.1) |
| `GET /status/attestations/{list}/bitstring/suspension` | The same, statusPurpose `suspension` (set for SUSPENDED) | `application/vc+jwt` |

The list URI is `{PUBLIC_BASE_URL}/status/attestations/{list}`. It is the
Token Status List token's `sub`, and it is the `uri` a referenced token
carries next to its `idx` (draft-ietf-oauth-status-list-21 §6.2).

The routes need no authentication, so they are served only when the auth
service runs with `REGISTRY_PUBLIC_ENDPOINTS_ENABLED=true` (exactly `true`,
read at startup; the default is off). With it off the paths are not routes:
they answer like any unknown path, and no CORS preflight is granted for them.
The service's own allocation and status changes (see Allocation) work either
way. When served, the routes are rate-limited per client address (300
requests a minute on each route) and allow reads from any browser origin
(§8.1), following the CORS protocol of the Fetch standard:

- A cross-origin `GET` with `If-None-Match` is not a simple request
  (`If-None-Match` is not a CORS-safelisted request-header), so a browser
  first sends an `OPTIONS` preflight. Each route answers it `204` with
  `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: GET`,
  `Access-Control-Allow-Headers: If-None-Match` and
  `Access-Control-Max-Age: 600`.
- `GET` responses, `304 Not Modified` included, carry
  `Access-Control-Allow-Origin: *` and `Access-Control-Expose-Headers: ETag`,
  since `ETag` is not a CORS-safelisted response header and a script could
  not otherwise read it to revalidate.
- No response carries `Access-Control-Allow-Credentials`; the lists are read
  without credentials.

A list id that is not one of the registry's is a `404`. A store that
cannot be read is a `5xx`: the registry never serves an older copy in its
place, because that copy could show a withdrawn attestation as accepted.

#### Token Status List

Each entry is two bits wide (`bits: 2`), packed from the least significant
bit of each byte, compressed with DEFLATE in the ZLIB format, and
base64url-encoded as `lst` (§4.1, §4.2). A list holds 131,072 entries.

<!-- example: tsl-header -->
```json
{
  "alg": "RS256",
  "kid": "grantex-RS256-0123456789abcdef",
  "typ": "statuslist+jwt"
}
```

<!-- example: tsl-payload -->
```json
{
  "iss": "https://registry.example",
  "sub": "https://registry.example/status/attestations/racl_01J8Z3K4M5N6P7Q8R9S0T1V2W3",
  "iat": 1790596800,
  "exp": 1790600400,
  "ttl": 600,
  "status_list": {
    "bits": 2,
    "lst": "eNrtwQEBAAAAgJD-r-4ICgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYgAAAAQ"
  }
}
```

#### Bitstring Status List

The credential is the JWT claims set, secured as a VC-JWT (W3C VC-JOSE-COSE
§3.1.1: `typ` `vc+jwt`, `cty` `vc`, no `vc` claim). Index 0 is the left-most
bit; the bitstring is GZIP-compressed and multibase-encoded as base64url with
no padding (prefix `u`). The uncompressed bitstring holds 131,072 entries, the
minimum Bitstring Status List §3.2 accepts. `iat` and `exp` are the
signature's; `validFrom` and `validUntil` state the same for the list.

<!-- example: bsl-header -->
```json
{
  "alg": "RS256",
  "kid": "grantex-RS256-0123456789abcdef",
  "typ": "vc+jwt",
  "cty": "vc"
}
```

<!-- example: bsl-payload -->
```json
{
  "@context": ["https://www.w3.org/ns/credentials/v2"],
  "id": "https://registry.example/status/attestations/racl_01J8Z3K4M5N6P7Q8R9S0T1V2W3/bitstring",
  "type": ["VerifiableCredential", "BitstringStatusListCredential"],
  "issuer": "https://registry.example",
  "validFrom": "2026-09-28T12:00:00.000Z",
  "validUntil": "2026-09-28T13:00:00.000Z",
  "credentialSubject": {
    "id": "https://registry.example/status/attestations/racl_01J8Z3K4M5N6P7Q8R9S0T1V2W3/bitstring#list",
    "type": "BitstringStatusList",
    "statusPurpose": "revocation",
    "encodedList": "uH4sIAAAAAAAAA-3BMQEAAADCoPVPbQwfoAAAAAAAAAAAAAAAAAAAAIC3AYbSVKsAQAAA",
    "ttl": 600000
  },
  "iat": 1790596800,
  "exp": 1790600400
}
```

### Signing

Both formats are signed with the auth service's platform signing key, the key
that signs grant tokens. The `kid` in the protected header is published at
`/.well-known/jwks.json`; a relying party verifies with that JWK Set and MUST
reject a list whose signature does not verify (draft-ietf-oauth-status-list-21
§5.1; Bitstring Status List §3.2 `STATUS_VERIFICATION_ERROR`).

### Freshness and caching

| | Normal | Cascade window |
|---|---|---|
| Token Status List `ttl` (seconds, §5.1) | 600 | 60 |
| Bitstring Status List `ttl` (milliseconds, §2.2) | 600000 | 60000 |
| `Cache-Control` | `public, max-age=600` | `public, max-age=60` |

Both formats state the same interval in their own units. Bitstring Status
List v1.0 §2.2 defines `credentialSubject.ttl` as an OPTIONAL "time to live"
in milliseconds before a refresh SHOULD be attempted, with no default and no
minimum or maximum, so the 60-second cascade ttl is expressed there exactly as
60000.

A cascade window is the hour after any acceptance change (an entry becomes
SUSPENDED, INVALID or VALID again) or a registry-wide suspension such as an
accredited issuer's. While any cascade window is open, every list is
published with the short ttl.

`exp` is one hour after `iat`. `iat` is aligned to five-minute intervals and
is never earlier than the last change the list reflects, so every instance
publishes the same claims for the same list version. Each response carries a
weak `ETag` over the protected header and claims; `If-None-Match` with that
tag is answered `304 Not Modified` until the list changes or is re-signed.
Because `iat` moves every five minutes, so does the tag: a relying party that
revalidates an unchanged list after that interval receives a fresh `200`.

A relying party SHOULD re-fetch a list `ttl` after fetching it and MUST NOT
rely on it after `exp` (§13.7). If it cannot obtain a list that is fresh by
those rules, it denies with `status_stale`; it never treats a list it could
not fetch, verify or decode as saying the attestation is accepted.

### Allocation

An entry's index is drawn uniformly at random with a cryptographic random
number generator (Bitstring Status List §2.1: indexes SHOULD be assigned
randomly). The store's primary key makes a second allocation of the same
`(list, idx)` impossible, however many registrations run at once
(draft-ietf-oauth-status-list-21 §13.3). A list takes new entries until it is
three quarters allocated; the next list then takes over. Allocating does not
change the published list, since a new entry is VALID like an unused index.

The auth service exposes this to the code that registers attestations:

| Call | Effect |
|---|---|
| `allocateAcceptanceEntry(tx?)` | Returns `{ uri, idx }` for a new VALID entry. |
| `setAcceptance(uri, idx, status, tx?)` | Sets `valid`, `suspended` or `invalid`. Refuses an INVALID entry with `attestation_not_accepted` and an unknown list or index with `attestation_not_registered`. Opens a cascade window. |
| `noteRegistryCascade(tx?)` | Opens a cascade window without changing an entry. |

Each takes the caller's transaction, so an attestation and its entry are
recorded together or not at all. Allocation increments a per-list counter
whose row stays locked until the caller's transaction ends, so callers
allocate as late in their transaction as they can.
