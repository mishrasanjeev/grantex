# Registry federation

## Attestation acceptance status lists

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

The routes need no authentication, are rate-limited per client address (300
requests a minute on each route), and allow reads from any browser origin
(§8.1). A list id that is not one of the registry's is a `404`. A store that
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
