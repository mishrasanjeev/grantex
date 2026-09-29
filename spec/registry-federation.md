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
ships, relying parties MUST use the public list of section 2.1, or the
signed registry manifest (see "Registry manifest" below), and MUST NOT
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

## Agent lookup

Status: draft. Implemented by the auth service (`apps/auth-service`,
`src/lib/registry/lookup.ts`, `src/routes/registry-lookup.ts`). No schema
change.

A relying party looks an agent up to learn its computed trust level and
flags (spec/attestation-1.0.md §8), who attests it, and whether the key that
signed a request is one the agent may use now. The lookup is minimised: what
anyone may read is the least a relying party needs to decide, and the rest is
for relying parties the registry can identify.

### Requests

| Request | Finds |
|---|---|
| `GET /v1/registry/agents/{agent_did}` | The agent with that DID. The DID is one path segment, percent-encoded. |
| `GET /v1/registry/agents?key_thumbprint={thumbprint}` | The agent holding that key anywhere in its history (spec/agent-keys.md §1): the RFC 7638 SHA-256 thumbprint, base64url, 43 characters. |
| `GET /v1/registry/agents?issuer={entity_id}&external_credential_id={id}&hash={hash}` | The agent an accredited issuer attested on that credential: `issuer` is the attestation's `iss`, `external_credential_id` and `hash` its `external_credential_id` and `external_credential_hash` (spec/attestation-1.0.md §2, §3). |

The query form takes `key_thumbprint` alone, or all three of `issuer`,
`external_credential_id` and `hash`. Any other combination, a parameter given
twice, an unknown parameter, a malformed thumbprint or a `hash` that does not
follow the hash rule is `400` before the registry reads anything, so a partial
credential never narrows a search.

The credential lookup MUST match on all three values at once. A mismatch on
any one of them is answered exactly as a credential the registry has never
seen: the same `404` body and no `ETag`. So is a credential that names a
provider rather than an agent, or one that names more than one agent (nothing
makes the three values unique across agents, so an issuer can attest two
agents under one credential; the lookup then names neither, with or without
a key). A caller
therefore learns nothing from a guess except that it was wrong, which resists
enumeration of the agents an issuer attested.

An unknown agent or thumbprint is `404` with code `NOT_FOUND`.

### What the answer carries

The level and flags are computed when asked, never read from a stored
snapshot (spec/attestation-1.0.md §8).

| Member | Public | Authenticated | Contents |
|---|---|---|---|
| `agent_did` | yes | yes | The agent's DID. |
| `level` | yes | yes | `basic`, `verified`, `attested` or `attested_verified`. |
| `flags` | yes | yes | From the enumerated set, in its order. |
| `issuers` | yes | yes | The `entity_id` of each issuer of a counted attestation. |
| `attestations[]` `type`, `issuer`, `expires_at` | yes | yes | Each counted attestation: its trust mark type, issuer and expiry (RFC 3339). |
| `attestations[]` `id` | no | yes | The registry's id of the attestation. |
| `attestations[]` `issuer_status_list` | no | yes | `{uri, idx}`: the entry in the issuer's own status list. |
| `attestations[]` `acceptance_status_list` | no | yes | `{uri, idx}`: the entry in the registry's acceptance list. |
| `keys[]` | yes | yes | Every key in the agent's history: `thumbprint`, `status` (`pending`, `active`, `rotated`, `compromised`) and `current`. |
| `key_thumbprint`, `key_status`, `key_current` | yes | yes | Thumbprint lookup only: the key asked about. |
| `cimd_uri` | yes | yes | The agent's client metadata document, or `null`. |
| `provider` | no | yes | `{did, name, legal_identifiers}` of the agent's provider, or `null` when the agent has none the registry can resolve. |

A key is **current** when it may sign now: it is `active`, or it is `rotated`
and its overlap has not ended (`valid_to` is later than now), and its
possession has been proven. A `pending` or `compromised` key, or a rotated key
past its overlap, is not current; a relying party that verified a request with
it denies with `key_not_active` (or `key_unproven` for a pending key).

The public answer never carries a provider's legal identifiers, its name, or
any status list index. The registry builds each answer member by member from
the table above; nothing else from its records can appear in it.

<!-- example: lookup-public -->
```json
{
  "agent_did": "did:grantex:ag_01J8Z3K4M5N6P7Q8R9S0T1V2W3",
  "level": "attested_verified",
  "flags": [],
  "issuers": ["https://issuer.example"],
  "attestations": [
    { "type": "urn:grantex:tm:agent.identity", "issuer": "https://issuer.example", "expires_at": "2027-09-28T12:00:00.000Z" },
    { "type": "urn:grantex:tm:provider.entity", "issuer": "https://issuer.example", "expires_at": "2027-09-28T12:00:00.000Z" }
  ],
  "keys": [
    { "thumbprint": "NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs", "status": "rotated", "current": true },
    { "thumbprint": "kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k", "status": "active", "current": true }
  ],
  "cimd_uri": "https://provider.example/agents/shopper-01/cimd.json",
  "key_thumbprint": "NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs",
  "key_status": "rotated",
  "key_current": true
}
```

The same agent, looked up by DID with a developer API key:

<!-- example: lookup-relying-party -->
```json
{
  "agent_did": "did:grantex:ag_01J8Z3K4M5N6P7Q8R9S0T1V2W3",
  "level": "attested_verified",
  "flags": [],
  "issuers": ["https://issuer.example"],
  "attestations": [
    {
      "type": "urn:grantex:tm:agent.identity",
      "issuer": "https://issuer.example",
      "expires_at": "2027-09-28T12:00:00.000Z",
      "id": "ratt_01J8Z3K4M5N6P7Q8R9S0T1V2W4",
      "issuer_status_list": { "uri": "https://issuer.example/status/1", "idx": 4211 },
      "acceptance_status_list": { "uri": "https://registry.example/status/attestations/racl_01J8Z3K4M5N6P7Q8R9S0T1V2W3", "idx": 77012 }
    }
  ],
  "keys": [
    { "thumbprint": "NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs", "status": "active", "current": true }
  ],
  "cimd_uri": "https://provider.example/agents/shopper-01/cimd.json",
  "provider": {
    "did": "did:web:provider.example",
    "name": "Provider Example Ltd",
    "legal_identifiers": [{ "scheme": "lei", "value": "5299000EXAMPLE000042" }]
  }
}
```

### Authentication

An **authenticated relying party** is, in Phase 1, a request carrying a valid
developer API key (`Authorization: Bearer <key>`), checked exactly as every
other `/v1` route checks it. A key that is sent and is not valid is `401`;
it is never answered as if no key had been sent. A dedicated relying-party
credential, separate from a developer's key, is a later refinement.

The lookup reads the whole registry, not the caller's own agents: a relying
party looks up agents that other developers registered.

### Availability, limits and caching

| `REGISTRY_PUBLIC_ENDPOINTS_ENABLED` | Without a key | With a key |
|---|---|---|
| unset or anything but `true` (default) | `401` | the authenticated answer |
| `true` | the public answer | the authenticated answer |

Each route is limited to 120 requests a minute per client address. An
authenticated request also draws on its developer's plan budget, which is the
per-API-key limit.

A found agent carries a strong `ETag` over the body (RFC 9110 §8.8.3);
`If-None-Match` with it is answered `304` (RFC 9110 §13.1.2). Every answer
lists `Authorization` in `Vary` (RFC 9110 §12.5.5), added to any field names
already there: a request with an `Origin` also gets `Origin` from the CORS
handling, so the answer is `Vary: Origin, Authorization` and a shared cache
keeps the reflected `Access-Control-Allow-Origin` per origin. A public answer carries
`Cache-Control: public, max-age=60`, the shortest ttl the registry's
acceptance lists use, so a cached level is never older than a relying party
checking those lists could see; an authenticated answer carries
`Cache-Control: private, no-cache` (RFC 9111 §5.2.2.4, §5.2.2.7). A store that
cannot be read is a `5xx`.

## Registry manifest

Status: draft. Implemented by the auth service (`apps/auth-service`,
`src/lib/registry/manifest.ts`, `src/routes/registry-lookup.ts`).

`GET /.well-known/agent-registry.json` serves one signed, compact statement
of what a relying party needs to verify Agent Passports and attestations
offline: the accredited issuers and their keys, the trust mark taxonomy, the
registry's acceptance lists and where to look agents up. In Phase 1 a relying
party without OpenID Federation support uses it instead of resolving a trust
chain. It is served only while `REGISTRY_PUBLIC_ENDPOINTS_ENABLED=true`;
otherwise the path does not exist (`404`).

### Format

The response body is a JWS in the compact serialization (RFC 7515 §7.1),
served as `application/grantex-registry-manifest+jwt`. The path ends in
`.json` for discovery; the body is not JSON. OpenID Federation 1.0 serves its
Entity Configuration in the same way, as a typed JWT from a well-known path.

| Header | Rule |
|---|---|
| `typ` | Exactly `grantex-registry-manifest+jwt`: the media type without its `application/` prefix, as RFC 7515 §4.1.9 recommends, so the manifest is explicitly typed (RFC 8725 §3.11) and cannot be taken for any other JWT the platform key signs. Compared as an exact string. |
| `alg` | The platform signing key's algorithm, `RS256` or `ES256`. |
| `kid` | The platform signing key, resolvable from `/.well-known/jwks.json`. |

`jku`, `jwk`, `x5u`, `x5c` and `crit` are never present, and a relying party
MUST refuse a manifest that carries one.

<!-- example: manifest-header -->
```json
{
  "alg": "RS256",
  "kid": "grantex-RS256-0123456789abcdef",
  "typ": "grantex-registry-manifest+jwt"
}
```

| Claim | Contents |
|---|---|
| `iss` | The registry's issuer identifier (`JWT_ISSUER`). |
| `iat` | When it was signed: the start of the current five-minute interval, or the latest change it reflects if that is later. |
| `exp` | `iat` + 3600. |
| `issuers` | Every accredited issuer, whatever its status, ordered by `entity_id` (byte order), each as the public issuer list shows it (section 2.1 of the issuer document above): `entity_id`, `trust_marks`, `status` in effect when the manifest is built (so a suspended issuer is listed, with `suspended`, and keeps its keys), `status_list_base`, and `jwks` without any revoked kid (and no keys for a withdrawn issuer). The manifest is not limited to one page of issuers. |
| `trust_mark_types` | The trust mark taxonomy (section 4 above). |
| `acceptance_status_lists` | Every acceptance list of the registry, in both forms: `token_status_list` (the list URI, the Token Status List) and `bitstring_status_list` with its `revocation` and `suspension` credentials. |
| `endpoints` | `agent_by_did`, `agent_by_key_thumbprint`, `agent_by_credential` (lookup URL templates, RFC 6570 level 1, §1.2: substitute each `{name}` percent-encoded), `issuers` (the public issuer list), `acceptance_status_list` (a template over the list id) and `jwks_uri`. |

<!-- example: manifest-payload -->
```json
{
  "iss": "https://registry.example",
  "iat": 1790596800,
  "exp": 1790600400,
  "issuers": [
    {
      "entity_id": "https://issuer.example",
      "trust_marks": ["urn:grantex:tm:agent.identity", "urn:grantex:tm:provider.entity"],
      "status": "active",
      "status_list_base": "https://issuer.example/status/",
      "jwks": {
        "keys": [
          {
            "kty": "EC",
            "crv": "P-256",
            "x": "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU",
            "y": "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0",
            "kid": "issuer-2026-01",
            "alg": "ES256",
            "use": "sig"
          }
        ]
      }
    },
    {
      "entity_id": "https://mock-issuer.example",
      "trust_marks": ["urn:grantex:tm:agent.identity"],
      "status": "suspended",
      "status_list_base": "https://mock-issuer.example/status/",
      "jwks": {
        "keys": [
          {
            "kty": "EC",
            "crv": "P-256",
            "x": "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU",
            "y": "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0",
            "kid": "mock-2026-01",
            "alg": "ES256",
            "use": "sig"
          }
        ]
      }
    }
  ],
  "trust_mark_types": [
    "urn:grantex:tm:provider.entity",
    "urn:grantex:tm:provider.ownership",
    "urn:grantex:tm:provider.screening",
    "urn:grantex:tm:agent.identity",
    "urn:grantex:tm:agent.security"
  ],
  "acceptance_status_lists": [
    {
      "token_status_list": "https://registry.example/status/attestations/racl_01J8Z3K4M5N6P7Q8R9S0T1V2W3",
      "bitstring_status_list": {
        "revocation": "https://registry.example/status/attestations/racl_01J8Z3K4M5N6P7Q8R9S0T1V2W3/bitstring",
        "suspension": "https://registry.example/status/attestations/racl_01J8Z3K4M5N6P7Q8R9S0T1V2W3/bitstring/suspension"
      }
    }
  ],
  "endpoints": {
    "agent_by_did": "https://registry.example/v1/registry/agents/{agent_did}",
    "agent_by_key_thumbprint": "https://registry.example/v1/registry/agents?key_thumbprint={key_thumbprint}",
    "agent_by_credential": "https://registry.example/v1/registry/agents?issuer={issuer}&external_credential_id={external_credential_id}&hash={hash}",
    "issuers": "https://registry.example/v1/registry/issuers",
    "acceptance_status_list": "https://registry.example/status/attestations/{list}",
    "jwks_uri": "https://registry.example/.well-known/jwks.json"
  }
}
```

### Verification

A relying party (and the auth service's own `verifyRegistryManifest`) accepts
a manifest only when all of these hold, and otherwise refuses with the
Appendix C code shown:

| Check | Refusal |
|---|---|
| It is a compact JWS whose header has exactly the `typ` above, an `alg` of `RS256` or `ES256`, a `kid`, and none of `jku`, `jwk`, `x5u`, `x5c`, `crit`. | `passport_invalid_signature` |
| The key for `kid` is in the registry's JWK Set, fetched from `jwks_uri` (never from the manifest), and the signature verifies with it under that algorithm only (RFC 8725 §3.1). | `passport_invalid_signature` |
| The payload has every claim above, and `iss` is the registry the relying party trusts. The relying party names that registry itself; a verifier with no expected issuer configured refuses every manifest rather than skipping the check. | `passport_invalid_signature` |
| `exp - iat` is positive and at most 3600; `iat` is not more than 60 seconds in the future. | `status_stale` |
| Now is before `exp`, and not more than 3600 seconds after `iat` (the manifest is stale after one hour). | `status_stale` |

A relying party that holds no manifest passing these checks cannot establish
that an issuer is accredited, and refuses the passport or attestation that
depends on it; it never falls back to an expired manifest.

### Caching

The same registry state gives the same manifest on every instance within an
interval. The response carries a weak `ETag` over the protected header and
claims (RFC 9110 §8.8.1); `If-None-Match` with it is answered `304` while
nothing has changed and the manifest has not been re-signed. It carries
`Cache-Control: public, max-age=N`, where N is at most 300 and never past
`exp`, and `Access-Control-Allow-Origin: *`. The route is limited to 60
requests a minute per client address. A store that cannot be read is a
`5xx`: the registry never serves an older manifest in its place.

## Status reconciliation

Status: draft. Implemented by the auth service (`apps/auth-service`,
`src/lib/registry/status-reconciliation.ts`,
`src/workers/registryStatusReconciliation.ts`). No schema change. Off unless
`REGISTRY_STATUS_RECONCILIATION_ENABLED` is exactly `true`.

The registry reads every accredited issuer's Token Status Lists that its
accepted attestations point into, treats an entry that changed as an event,
keeps its own acceptance entries in line with what it read, and brings every
grant bound to an Agent Passport (`spec/passport-binding.md`) in line with its
acceptance entry. The revocation feed then carries the change to relying
parties that hold a token for the grant.

### Polling

A list is read when it is due:

- one tick before the registry's last read of it goes stale. A read stays
  fresh until the earliest of the list's `exp`, the time of reading plus its
  `ttl`, and a day (draft-ietf-oauth-status-list-21 §5.1 and §13.7), so a
  list is polled at its `ttl`;
- and never sooner than `REGISTRY_STATUS_POLL_MIN_INTERVAL_MS` after the last
  attempt, successful or not.

A tick is a quarter of the minimum interval, and never shorter than 250 ms.
The list is fetched once for every attestation that points into it, however
many there are; at most 200 lists are read in one run, eight at a time. The
fetch, the checks on the token and the fail-closed rules are those of
`spec/attestation-1.0.md` section 10. Only one instance reconciles at a time:
it holds a Postgres session advisory lock for the run, and the others skip it.
Each instance starts after a random delay of up to one minimum interval.
Only lists of an issuer that is active now are read (a suspension scheduled
for later has not taken effect yet). A withdrawn issuer's lists are not read
because the registry no longer holds keys to verify them; a suspended issuer's
are not read so that nothing on them is acted on while it is suspended, which
is what an operator suspends an issuer for when it publishes a wrong list. The
issuer's attestations are suspended instead (below), and statuses recorded
before the suspension stay as they were.

A list is fetched outside any transaction, so an operator may suspend or
withdraw its issuer, or revoke the key it was signed with, while the fetch is
in flight. The read is recorded in one transaction that takes the registry
chain's lock and then the issuer's row (`FOR SHARE`), the order the operator's
`PATCH` takes them in (`FOR UPDATE`), and checks again that the issuer is
active and that the `kid` the list was verified with is one of its keys and
not revoked. If either no longer holds, the read is discarded whole: no
status, no freshness and no attempt time is written, and it is counted as a
failed poll with reason `issuer_changed`. A suspension therefore never lets a
read that started before it land after it.

An entry that changed is recorded as the attestation's `issuer_status`
(`valid`, `suspended`, or `revoked` for INVALID and any value the registry
does not know) and audited on the registry chain
(`grantex.registry.attestation_issuer_status_changed`). An attestation whose
issuer status is `revoked` is not read again: INVALID is final (§7.1).

A list that cannot be fetched, verified or decoded changes nothing but the
time of the attempt. The recorded status is not replaced by a guess and its
freshness is not extended, so once it runs out the attestation stops counting
toward a trust level, and the code exchange and every refresh of a bound grant
refuse with `status_stale` until a read succeeds.

### The registry's decision

For each accepted, unexpired attestation, the registry's acceptance entry
(see "Attestation acceptance status lists") is set as follows, first match
wins:

<!-- decision-table -->
| Issuer's list says | Read | Issuer | Acceptance entry | Cause |
|---|---|---|---|---|
| revoked | any | any | INVALID | `issuer_status` |
| any | any | suspended (from `suspended_effective_from`) or withdrawn | SUSPENDED | `issuer` |
| suspended | any | active | SUSPENDED | `issuer_status` |
| valid | fresh | active | VALID | `issuer_status` |
| valid | stale | active | unchanged | none |

A read is fresh until its `issuer_status_fresh_until`. An INVALID entry is
final. A withdrawn issuer's attestations are suspended rather than ended
because an operator can reinstate an issuer; they return to VALID with it,
but only on a fresh read: a read that has run out is no evidence that the
passport is still valid, so an entry that is SUSPENDED stays SUSPENDED, and
its grants stay suspended, until the issuer's list has been read again (a
reinstated issuer's lists are due at once, so that is the next tick if the
list can be read). An entry that is VALID on a read that has run out stays
VALID; the issuance and refresh checks refuse with `status_stale` on their
own. Each change goes through `setAcceptance`, so it opens the
acceptance lists' cascade window (60 s `ttl` for an hour), and is audited as
`grantex.registry.attestation_acceptance_changed` with `from`, `to` and
`cause`. The registry sets SUSPENDED only through this decision, so an entry
the decision no longer calls for returns to VALID.

An attestation signed with an issuer key that has been revoked
(`revoke_kids` in `PATCH /v1/registry/issuers/{id}`) is withdrawn: its record
becomes `withdrawn`, its acceptance entry INVALID, audited as
`grantex.registry.attestation_withdrawn` with `requestedBy`
`registry:key_revoked` and the `kid`. The signing key is the `kid` in the
protected header of the attestation's JWS, which the registry stores byte for
byte. The operator's `PATCH` checks every accepted attestation of the issuer.
The loop checks every accepted attestation of every issuer with a revoked
kid, however long ago the kid was revoked, so a kid revoked while
reconciliation was off, or whose cascade at the `PATCH` kept failing, is
acted on once the loop runs. It reads at most four pages of 500 attestations
a run, in primary-key order, and carries its place to the next run until it
has been through them all; withdrawn attestations drop out of the scan.
Retiring a key that signed attestations still in use is a `jwks` replacement
that keeps the old key, not a revocation.

### The cascade to bound grants

Every grant bound to a passport follows the acceptance entry in its binding
(`grant_passport_bindings`):

<!-- cascade-table -->
| Acceptance entry | Bound grant | What happens |
|---|---|---|
| INVALID | active or suspended | revoked, with every grant delegated beneath it |
| SUSPENDED | active | suspended, with every grant delegated beneath it; the suspension is recorded with cause `registry` |
| VALID | suspended by the registry | resumed, with the grants the same suspension suspended |

This includes an INVALID entry the registry set for another reason: a
withdrawn attestation, and one superseded by a refresh (whose passport the
refresh replaced). Revocation and suspension are those of the event bridge
and the emergency stop: the grants change status in one transaction per
developer, each gets an entry on its developer's audit chain
(`grantex.grant.revoked` or `grantex.grant.suspended`, `cause` `registry`,
evidence `trigger` `event`, or `cascade` below the root), the `grant.revoked`
or `grant.suspended` webhook is sent, and the revocation feed carries the
change. A grant suspended for any other reason is never resumed by the
registry, and a resume is refused while an ancestor grant is not active. A
revoked grant stays revoked when its passport is later reinstated: the agent
asks for a new grant.

An operator's `PATCH /v1/registry/issuers/{id}` (a suspension, a
reinstatement, a withdrawal or a revoked kid) runs the decision and the
cascade for that issuer before it answers. A reinstatement returns to VALID
at the `PATCH` only the entries whose last read is still fresh; the others
return at the first fresh read of their list. If that fails, the change itself is
still committed, the failure is logged and counted, and the loop completes it
at its next tick; the issuance and refresh checks refuse on the committed
change either way. The loop repeats the decision and the cascade for every
issuer on every tick, which also applies a suspension scheduled for later
once it takes effect. Every step acts on what the tables say, not on the
change that led there, so a run that stops half way is completed by the next
and work done twice changes nothing.

### Timing

With a list `ttl` of `T` seconds and a tick of `t`, an issuer's flip reaches
the acceptance list and the bound grant within `T + t` plus the run itself,
and the revocation feed as soon as the cascade commits (PRD §9). The mock
issuer and CI use `T` = 1 s and a 1 s minimum interval (owner decision 5);
the integration tests measure the time from the issuer's flip to the
revocation feed entry and require it to be at most 2 s. In production the
minimum interval is at least 30 s and each list is polled at its own `ttl`.

### Metrics and alerts

<!-- metrics-table -->
| Metric | Labels | Meaning |
|---|---|---|
| `grantex_registry_status_list_polls_total` | `outcome` | Lists read (`ok`) or not readable (`failed`). |
| `grantex_registry_status_list_poll_failures_total` | `reason` | Why: `unreachable`, `http_status`, `content_type`, `too_large`, `dev_map_refused`, `invalid`, `not_under_base`, `issuer_unknown`, `issuer_changed`, `error`. |
| `grantex_registry_status_flips_total` | `to` | Recorded issuer statuses that changed. |
| `grantex_registry_acceptance_changes_total` | `to`, `cause` | Acceptance entries changed. |
| `grantex_registry_cascade_grants_total` | `action` | Grants `revoked`, `suspended` or `resumed`. |
| `grantex_registry_status_reconcile_runs_total` | `outcome` | Runs: `complete`, `skipped_locked`, `failed`, `disabled`. |
| `grantex_registry_status_reconcile_failures_total` | `step` | Steps that failed: `poll`, `decide`, `cascade`. |
| `grantex_registry_status_poll_lag_seconds` | none | How late the most overdue list was at the start of the latest run. |
| `grantex_registry_status_lists_stale` | none | Lists whose last good read has run out. |

No label names an issuer, a list, an attestation or a grant. An instance that
does not hold the lock reports 0 on both gauges, so `max()` over instances is
the reconciling instance's value. `deploy/prometheus/registry-status-alerts.yml`
alerts when a list has stayed unreadable past its staleness, when polls keep
failing, when polls lag, when many entries flip at once, and when
reconciliation runs fail. What to do is in
`docs/runbooks/status-list-incident.md`.

### Configuration

<!-- config-table -->
| Variable | Default | Meaning |
|---|---|---|
| `REGISTRY_STATUS_RECONCILIATION_ENABLED` | `false` | `true` (exactly) runs the reconciliation, and the cascade on `PATCH /v1/registry/issuers/{id}`. Otherwise the per-attestation recheck worker keeps the recorded statuses fresh as before, and nothing is cascaded. Needs `DATABASE_POOL_MAX` of at least 2: a run holds one connection for its advisory lock and works through another, so with `true` and a pool of 1 the service refuses to start. |
| `REGISTRY_STATUS_POLL_MIN_INTERVAL_MS` | `30000` | The minimum interval between two reads of one list. At least 30000; at least 1000 when `NODE_ENV` is `development` or `test` (the mock issuer and CI only); at most 86400000. Anything else stops the service from starting. |
