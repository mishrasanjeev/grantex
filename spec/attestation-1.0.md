# Registry attestations 1.0

Status: draft, Agent Trust Registry Phase 1 (PRD §5 Attestation, §5.1, §5.2,
§7 Attestation, §8.3, Appendix A). Implemented by the auth service
(`apps/auth-service`: `src/lib/registry/attestation-jws.ts`,
`src/lib/registry/attestations.ts`, `src/lib/registry/trust-level.ts`,
`src/lib/registry/issuer-fetcher.ts`, `src/routes/registry-attestations.ts`,
migration `124_registry_attestations.sql`).

An **attestation** is an accredited issuer's signed statement about one agent
or one agent provider: that the provider is a registered legal entity, that an
agent is who it says it is, and so on, one trust mark type per attestation.
The issuer posts it to the registry; the registry checks it, keeps it, publishes
whether it accepts it, and computes each agent's trust level from the
attestations it holds.

Keywords MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

Normative references:

- RFC 7515 (JWS) §4.1.9 (`typ`), §7.1 (compact serialization); RFC 7518 §3.4
  (ES256); RFC 8037 §3.1 (EdDSA); RFC 7638 (JWK Thumbprint); RFC 7519 §10.3.1
  (`application/jwt`).
- draft-ietf-oauth-status-list-21 (Token Status List): §5.1 (the Status List
  Token), §6.2 (the `status` claim), §7.1 (status values), §8.2 (media type),
  §8.2 (response and redirects), §8.3 (validation), §13.7 (`ttl` and `exp`).
- OpenID Federation 1.0 §1.2 (Entity Identifier), for `iss`.
- [`registry-federation.md`](registry-federation.md) (accredited issuers, trust
  marks, the registry's acceptance lists) and
  [`agent-passport-1.0.md`](agent-passport-1.0.md) §6 (the hash rule).

## 1. Format

An attestation is a JWS in the compact serialization (RFC 7515 §7.1): three
base64url parts separated by dots. The JSON serialization is not accepted. It
is posted as the whole request body, with the media type `application/jwt` or
`application/grantex-attestation+jwt`, at most 16 KiB.

| Header | Rule |
|---|---|
| `typ` | Exactly `grantex-attestation+jwt` (RFC 7515 §4.1.9, the media type `application/grantex-attestation+jwt` without its `application/` prefix, as §4.1.9 recommends). Compared as an exact string: stricter than §4.1.9, under which media types are case-insensitive and the prefixed form is equivalent, so one value has one spelling and the check is a byte comparison. |
| `alg` | `ES256` (RFC 7518 §3.4) is REQUIRED. `EdDSA` (RFC 8037 §3.1) is accepted only when the registry sets `REGISTRY_ATTESTATION_EDDSA_ENABLED=true`; it is off by default. Every other value, `none` included, is refused. |
| `kid` | REQUIRED, 1 to 128 characters. Names a key in the issuer's JWK Set as the registry records it. |
| `jku`, `jwk`, `x5u`, `x5c` | MUST NOT be present. The issuer's keys come only from the registry's record (owner decision 7); the registry never fetches a key from a URL in the token. |
| `crit` | MUST NOT be present. |

<!-- example: attestation-header -->
```json
{
  "typ": "grantex-attestation+jwt",
  "alg": "ES256",
  "kid": "issuer-2026-01"
}
```

## 2. Payload (PRD Appendix A)

The payload is a JSON object with exactly these members. A member not listed
is refused (`unknown_member`): an issuer cannot add a claim the registry would
silently ignore.

| Member | Type | Rule |
|---|---|---|
| `iss` | string | REQUIRED. The issuer's `entity_id`, an `https` URL, exactly as the registry records it. |
| `id` | string | REQUIRED. The attestation's id, minted by the issuer: 1 to 128 characters from `A-Z a-z 0-9 . _ : ~ -`. Unique per issuer: `(iss, id)` names one attestation. |
| `sub` | string | REQUIRED. A DID: the agent's (`agents.did`) for an `agent.*` type, the provider's organization DID for a `provider.*` type. |
| `type` | string | REQUIRED. One trust mark type of the taxonomy (§4). |
| `iat` | integer | REQUIRED. Seconds since the epoch. |
| `exp` | integer | REQUIRED. Seconds since the epoch; after `iat`. |
| `key_thumbprint` | string | REQUIRED for an `agent.*` type, and MUST NOT be present for a `provider.*` type. The RFC 7638 SHA-256 thumbprint, base64url (43 characters), of the agent key the attestation is bound to. |
| `external_credential_id` | string | REQUIRED. 1 to 256 characters, no control characters. The issuer's own identifier of the credential or case the attestation rests on. |
| `external_credential_hash` | string | REQUIRED. The hash rule (§3). |
| `level` | string | REQUIRED. 1 to 128 characters, no control characters. The issuer's assurance level in its own words; the registry stores it verbatim and never interprets it. |
| `declared_limits` | object | OPTIONAL. The limits the issuer checked the agent declares, at most 8 KiB as JSON. The registry compares successive values (§8, `declared_limits_changed`) but does not interpret the members. |
| `status` | object | REQUIRED. `{"status_list": {"uri": <https URL>, "idx": <non-negative integer>}}`, a Token Status List reference (draft-ietf-oauth-status-list-21 §6.2) into the issuer's own list, under its `status_list_base` (§5 step 10). |

An agent attestation for `shopper-01` (Nimbus Shopper 2.4):

<!-- example: attestation-payload -->
```json
{
  "iss": "https://issuer.example",
  "id": "att-2026-000123",
  "sub": "did:grantex:ag_01J8Z3K4M5N6P7Q8R9S0T1V2W3",
  "type": "urn:grantex:tm:agent.identity",
  "iat": 1790596800,
  "exp": 1822132800,
  "key_thumbprint": "NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs",
  "external_credential_id": "case-000123",
  "external_credential_hash": "sha-256:OiVR9AjgZRd6DJ8n_6dpLox_0KzFKt7gZ9MHpgHXOKQ",
  "level": "substantial",
  "declared_limits": { "max_amount": "250.00", "currency": "EUR" },
  "status": { "status_list": { "uri": "https://issuer.example/status/1", "idx": 4211 } }
}
```

A provider attestation for `provider.example` has no `key_thumbprint`:

<!-- example: provider-attestation-payload -->
```json
{
  "iss": "https://issuer.example",
  "id": "att-2026-000124",
  "sub": "did:web:provider.example",
  "type": "urn:grantex:tm:provider.entity",
  "iat": 1790596800,
  "exp": 1822132800,
  "external_credential_id": "case-000124",
  "external_credential_hash": "sha-256:OiVR9AjgZRd6DJ8n_6dpLox_0KzFKt7gZ9MHpgHXOKQ",
  "level": "registered-entity",
  "status": { "status_list": { "uri": "https://issuer.example/status/1", "idx": 4212 } }
}
```

## 3. Hash rule

```
external_credential_hash = "sha-256:" + base64url(SHA-256(<the external credential's bytes>))
```

`sha-256:` in lower case, then the 43-character base64url encoding of the
32-byte digest, without padding (`^sha-256:[A-Za-z0-9_-]{43}$`). For an Agent
Passport the input is the issuer-signed JWT, never its disclosures
([`agent-passport-1.0.md`](agent-passport-1.0.md) §6). The registry holds only
the hash, so it checks the format, not the digest: a value of any other form is
refused with `attestation_hash_mismatch`.

## 4. Taxonomy

The `type` is one of the five trust mark types of
[`registry-federation.md`](registry-federation.md) §4, and the issuer MUST be
accredited for it. The prefix decides the subject:

| Type | Subject (`sub`) | Key |
|---|---|---|
| `urn:grantex:tm:provider.entity` | provider | none |
| `urn:grantex:tm:provider.ownership` | provider | none |
| `urn:grantex:tm:provider.screening` | provider | none |
| `urn:grantex:tm:agent.identity` | agent | `key_thumbprint` |
| `urn:grantex:tm:agent.security` | agent | `key_thumbprint` |

## 5. Posting an attestation

`POST /v1/registry/attestations` with the compact JWS as the body. The route
has no API key: the issuer's signature, checked against the registry's record
of the issuer, is the authentication. It is limited to 30 requests a minute per
client address.

The registry checks, in this order, and stops at the first refusal. Each
refusal answers with a code, a reason and an HTTP status (§9):

| Step | Check | Refusal |
|---|---|---|
| 1 | A compact JWS with a JSON object header and payload. | `attestation_malformed` |
| 2 | The header (§1). | `attestation_malformed` (`wrong_typ`, `alg_not_allowed`, `kid_missing`, `header_key_not_allowed`, `crit_not_supported`) |
| 3 | `iss` and `type` read; the issuer accredited for `type` now ([`registry-federation.md`](registry-federation.md) §5). | `issuer_not_accredited`, `issuer_suspended`, `trust_mark_missing` |
| 4 | The signature verifies with the issuer's key for `kid`, from the registry's record; a revoked kid has no key. | `passport_invalid_signature` |
| 5 | Every payload member (§2). | `attestation_malformed` (`bad_claim`, `unknown_member`) |
| 6 | `sub` is a registered agent (`agent.*`) or provider (`provider.*`). | `attestation_mismatch` (`subject_not_registered`) |
| 7 | Possession before attestation: `key_thumbprint` is a key in that agent's history, `active` or `pending`, with its possession proven ([`agent-keys.md`](agent-keys.md)); a `rotated` key only inside its overlap. A key the agent does not hold, including one another agent holds, reads as unproven. | `key_unproven`; compromised or rotated past its overlap: `key_not_active` |
| 8 | The hash rule (§3). | `attestation_hash_mismatch` |
| 9 | `exp` after `iat`, `iat` at most 60 seconds ahead of the registry's clock, `exp` in the future. | `passport_expired` (`exp_not_after_iat`, `not_yet_valid`, `expired`) |
| 10 | The issuer's status list (§6). | `status_stale`; an entry that is not VALID: `passport_revoked` |
| 11 | No other attestation with the same `(iss, id)`. | Other bytes: `attestation_conflict` (`409`). |

Before step 2, a body whose bytes equal, character for character, the JWS
already stored for the payload's `(iss, id)` is answered `200` with the
existing record, as it is now, without running the steps again: those bytes
were verified when they were first accepted. An issuer retrying after a
timeout therefore gets the same answer even while its status list is briefly
unreachable. Any other body runs every step.

On success the registry, in one transaction: stores the JWS exactly as
received with the time it was received; allocates an entry on its own
acceptance list, VALID ([`registry-federation.md`](registry-federation.md),
"Attestation acceptance status lists"); appends
`grantex.registry.attestation_accepted` to the registry audit chain; and
recomputes the provider's stored level (§8). The answer is `201` with the
record, including `acceptance.status_list` (`uri`, `idx`), the entry a relying
party checks for the registry's acceptance. The JWS itself is never returned
or logged.

## 6. The issuer's status list

The attestation's `status.status_list.uri` MUST sit under the issuer's
`status_list_base` (owner decision 8): canonical, without query or fragment,
and strictly longer than the base. Otherwise the registry refuses with
`status_stale`, reason `status_list_not_under_base`, without fetching it.

The registry then fetches the list and applies draft-ietf-oauth-status-list-21
§8.3:

- The fetch is `GET` with `Accept: application/statuslist+jwt`, `https` only,
  to a public address only, within 5 seconds and 1 MiB. The answer MUST be
  `200` with the media type `application/statuslist+jwt` (§8.2).
- Redirects are not followed. §8.2 says a client SHOULD follow one; the
  registry does not, because a redirect could lead outside `status_list_base`.
  An issuer that moves its lists puts the new URI in new attestations.
- The token's header has `typ` `statuslist+jwt` (§5.1), `alg` as for the
  attestation and a `kid`, and it verifies with a key of the **same** issuer's
  recorded set.
- Its `sub` equals the URI (§8.3), `iat` is an integer not in the future,
  and it is fresh: before its `exp`, or, without `exp`, before `iat` + `ttl`
  (§13.7). A list with neither cannot be shown fresh and is refused.
- The entry at `idx` (§4.1, §8.3) is VALID (0x00, §7.1).

Any failure to fetch, verify or read the entry is `status_stale`, never an
accepted attestation. An entry that is INVALID (0x01), SUSPENDED (0x02) or any
other value is `passport_revoked`, with reason `invalid`, `suspended` or
`not_valid`.

The registry records, in `issuer_status`, what the list said when it last read
it (`valid`, `revoked` for INVALID or any other value, or `suspended`), and in
`issuer_status_fresh_until` how long that read may be relied on: the earliest
of the token's `exp`, the time of reading plus its `ttl` (§5.1, §13.7) and the
time of reading plus one day (`ISSUER_STATUS_MAX_FRESHNESS_SECONDS`). A read
past that time no longer counts (§8).

The auth service rereads the lists itself: every minute it takes up to 100
accepted, unexpired attestations that are not revoked and whose read goes
stale within two minutes, least recently tried first, and reads each list
again (`recheckIssuerStatus`), recording the new status and freshness and
auditing a change of status as `grantex.registry.attestation_issuer_status_changed`.
A reread that cannot read the list records only the attempt
(`issuer_status_checked_at`) and leaves the status and its freshness as they
were, so the attestation stops counting when the old read runs out: an
unreachable issuer lowers the level, never keeps it. A revoked entry is not
reread.

## 7. Withdrawal and refresh

| Route | Effect |
|---|---|
| `DELETE /v1/registry/attestations/{id}` | The record becomes `withdrawn` and its acceptance entry INVALID, which is final. Withdrawing a withdrawn attestation answers the record again; a superseded one is `attestation_not_accepted`. |
| `POST /v1/registry/attestations/{id}/refresh` | The body is a new attestation from the same issuer, for the same `sub` and `type`, with a new `id` and a new `external_credential_id`. It is checked exactly as §5; the old record becomes `superseded` (`superseded_by` names the new one, whose `supersedes` names the old) and its acceptance entry INVALID, in the same transaction as the new record and its VALID entry. |

`{id}` is the registry's id (`ratt_...`) from the answer to the post. Both
routes take one of two credentials in `Authorization`, and are limited to 30
requests a minute per client address:

- **The issuer's signed request**, `Authorization: GrantexIssuer <compact JWS>`.
  This is the normal path: whoever made the attestation takes it back or
  renews it, with the key it signed it with.
- **The registry operator key**, `Authorization: Bearer <key>` with a key from
  `REGISTRY_OPERATOR_API_KEYS`. It covers what the issuer cannot do itself, for
  example when the issuer has been withdrawn and has no keys left.

The signed request is a compact JWS with:

| Header | Rule |
|---|---|
| `typ` | Exactly `grantex-attestation-request+jwt`. |
| `alg`, `kid`, `jku`, `jwk`, `x5u`, `x5c`, `crit` | As §1. |

<!-- example: request-header -->
```json
{
  "typ": "grantex-attestation-request+jwt",
  "alg": "ES256",
  "kid": "issuer-2026-01"
}
```

| Member | Rule |
|---|---|
| `iss` | The issuer's `entity_id`. Its key for `kid` verifies the request. |
| `aud` | The registry's issuer identifier (its `JWT_ISSUER`). Another value is `audience_mismatch`. |
| `id` | The attestation's `id` as the issuer minted it. With `iss`, it MUST name the attestation in the path, or the request is `attestation_mismatch`. |
| `action` | `withdraw` or `refresh`, matching the route. |
| `iat` | Integer seconds; at most 300 seconds old and 30 seconds ahead of the registry's clock (`request_signature_stale`). |
| `nonce` | 16 to 128 base64url characters. The registry records `(iss, nonce)` in the same transaction as the change, so a request is used once; a second use is `request_signature_invalid`, reason `replay`. |

No other member is accepted. A suspended issuer can still withdraw its own
attestations; a revoked kid cannot sign a request.

<!-- example: request-payload -->
```json
{
  "iss": "https://issuer.example",
  "aud": "https://registry.example",
  "id": "att-2026-000123",
  "action": "withdraw",
  "iat": 1790600400,
  "nonce": "8m3Qf0bJ4wX2yK7pL9sT1v"
}
```

## 8. Computed trust level and flags (PRD §5.1)

The registry computes an agent's level when asked, from its records at that
time (`computeAgentTrust(agentDid | keyThumbprint)`, which returns the level,
the flags, the issuers, the types and the registry ids of the counted
attestations, the declared limits of the newest counted agent attestation
that has them, and `stale_attestation_ids`: the accepted attestations that do
not count only because the registry's read of the issuer's list is no longer
fresh).

An attestation **counts** when all of these hold: its record is `accepted`;
the issuer's list last read VALID and that read is still fresh (§6); the
registry's acceptance entry is VALID;
it has not expired; its issuer is accredited for its type and not suspended;
the issuer is independent of the provider, meaning the host of its
`entity_id` is neither the provider's domain nor a subdomain of it and its DID
is not the provider's; and, for an agent attestation, the key it names is
still usable in the agent's history (§5 step 7).

| Level | When |
|---|---|
| `basic` | Self-registered: none of the below. |
| `verified` | The provider's domain is DNS-verified. |
| `attested` | A counted `agent.identity` attestation of the agent and a counted `provider.entity` attestation of its provider. |
| `attested_verified` | Both of the above. |

The agent's provider is the one provider record of the agent's developer; an
agent whose developer has no provider record, or more than one, is never more
than `basic`. A **suspension anywhere in the chain** makes the level `basic`
for policy: the agent (any status other than `active`), its provider (a
suspension in effect), an accepted attestation of either (the issuer's list or
the registry's acceptance entry says SUSPENDED) or the issuer of one.

The provider record stores a snapshot of the provider's own level
(`computed_trust_level`: `attested` there means a counted `provider.entity`
attestation). Its attested half is kept in its own column
(`computed_attested`), which the registry rewrites whenever one of the
provider's attestations changes; a trigger combines it with DNS verification
and the provider's suspension, so lifting a suspension restores the level. It
does not follow an attestation expiring, a stale issuer status or an issuer
suspension until the next change. It is for display and search; a policy
decision uses the computed value. The older free-text `trust_level` keeps its
values and its meaning.

Flags come from this set only, in this order:

| Flag | Set when |
|---|---|
| `key_compromised` | An accepted attestation of the agent is bound to a key reported compromised. |
| `attestation_expiring` | A counted attestation expires within 30 days (`ATTESTATION_EXPIRING_WINDOW_SECONDS`), time enough to renew it with a refresh before the level drops. |
| `issuer_suspended` | The issuer of an accepted attestation of the agent or its provider is suspended now. |
| `declared_limits_changed` | For some type, the newest accepted attestation of the agent declares other `declared_limits` than the one before it. |
| `provider_screening_hit` | Never set. |
| `ownership_unresolved` | Never set. |
| `security_review_failed` | Never set. |

The last three have no source: the payload (§2) has no member an issuer could
report them with, and the registry does not infer them from `level`. They are
in the set so relying parties can match on them when a later version defines
their source.

## 9. Refusal codes

| Code | HTTP | Meaning |
|---|---|---|
| `attestation_malformed` | 400 | Not an attestation of this profile (§1, §2). Specific to this profile, like `passport_malformed`. |
| `attestation_hash_mismatch` | 400 | `external_credential_hash` does not follow the hash rule. |
| `passport_invalid_signature` | 401 | No current key of the issuer verifies the attestation. |
| `request_signature_invalid`, `request_signature_stale`, `audience_mismatch` | 401 | The withdrawal or refresh credential (§7). |
| `issuer_not_accredited`, `issuer_suspended`, `trust_mark_missing` | 403 | The issuer may not attest this type now. |
| `attestation_not_registered` | 404 | No attestation with that registry id. |
| `attestation_conflict` | 409 | The issuer already registered other bytes under this `id`. Specific to this profile. |
| `attestation_not_accepted` | 409 | The attestation is no longer accepted (withdrawn or superseded). |
| `attestation_mismatch`, `key_unproven`, `key_not_active`, `passport_expired`, `passport_revoked` | 422 | See §5 and §7. |
| `status_stale` | 503 | The issuer's status list could not be used (§6). |

A body that is not `application/jwt` or `application/grantex-attestation+jwt`
is `415`.

## 10. Development: issuer origin map

CI and local development have no network, so the registry cannot fetch
`https://mock-issuer.example/status/...`. `REGISTRY_DEV_ISSUER_ORIGIN_MAP`
rewrites an issuer origin to a loopback HTTP server for the connection only:

```
REGISTRY_DEV_ISSUER_ORIGIN_MAP=https://mock-issuer.example=http://127.0.0.1:56901
```

A comma-separated list of `https-origin=loopback-origin` pairs; the target
must be `127.0.0.1`, `localhost` or `[::1]`. The URIs in attestations stay
`https://`, and the list's `sub` is compared with them. The service refuses to
start with the map set unless `NODE_ENV` is `development` or `test`, and the
fetcher refuses it again at fetch time, so it can never take effect in
production.
