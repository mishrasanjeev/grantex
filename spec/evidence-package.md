# Evidence package 1.0

Status: draft for Grantex 0.6 (PRD G-5). Normative structure:
[`evidence-package-1.0.schema.json`](evidence-package-1.0.schema.json) (JSON
Schema 2020-12, `$id` `https://grantex.dev/spec/evidence-package-1.0.schema.json`).
Examples and shared test cases: [`examples/evidence/`](examples/evidence/).

An evidence package is one JSON document per case that lets someone who was
not there establish, without access to the systems that produced it:

- which grants an agent acted under, root to leaf, with purposes and caps;
- every tool call, with keyed digests of its input and output, the provider
  and references to the upstream records it returned;
- the model, prompt, policy and schema versions in use;
- each policy evaluation with its score, tier, fired rules and cited (or
  explicitly unsourced) inputs;
- each recommendation and screening disposition with the evidence it cites;
- every human decision with approver, authentication method, dwell time and
  the semantic action approved;
- revocations;
- who asserted each entry (the platform or the tenant), when the recording
  service received it, and that nothing was edited afterwards.

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## Contents

1. [Document](#document)
2. [Identifiers and privacy](#identifiers-and-privacy)
3. [Entries](#entries)
4. [Canonical form](#canonical-form)
5. [Hash chain](#hash-chain)
6. [Anchor](#anchor)
7. [Signature](#signature)
8. [Trust](#trust)
9. [Verification](#verification)
10. [Producing evidence through the auth service](#producing-evidence-through-the-auth-service)
11. [Tooling](#tooling)
12. [Security considerations](#security-considerations)

## Document

A package is a JSON object with exactly these members:

| Member | Required | Covered by the root | Content |
|---|---|---|---|
| `format` | yes | yes | `"grantex-evidence-package"` |
| `version` | yes | yes | `"1.0"` |
| `case` | yes | yes | The case the package is about. |
| `privacy` | yes | yes | Which classes of value appear in the clear. |
| `entries` | yes | yes | The evidence, as a hash-chained array (at least one entry). |
| `chain` | yes | yes | Chain summary and the package root. |
| `anchor` | no | no, it records the root | The platform audit entry that recorded the root. |
| `signature` | no | no, it signs the root and anchor | Detached JWS by the auth service. |

Unknown members are refused everywhere except inside `ext` objects and inside
`authorization_details` items (copied from issued grants, where RFC 9396
allows further members). The full example is
[`examples/evidence/evidence-package.json`](examples/evidence/evidence-package.json).

### `case`

| Member | Required | Type | Meaning |
|---|---|---|---|
| `case_id` | yes | token | The case identifier (for decision grants, the action's `case_id`). |
| `tenant_id` | yes | token | The auth service developer (tenant) that owns the case. |
| `issuer` | yes | token | The auth service issuer URL. |
| `state` | yes | `open` \| `decided` \| `closed` | The auth service writes `decided` when the case has a decision consumption and `open` otherwise; callers cannot set it. |
| `exported_at` | yes | timestamp | When the package was assembled. |
| `subject` | no | identifier (`subject`) | What the case is about. When present, every decision's `action.subject` MUST equal it. |
| `ext` | no | extension object | See [Extensions](#extensions). |

### Common value types

| Type | Rule |
|---|---|
| token | 1-256 printable ASCII characters (U+0021-U+007E). Tokens (call, run, evaluation, grant, request ids) MUST NOT embed personal data; producers generate them. |
| text | String of 1-512 characters. |
| timestamp | UTC with exactly millisecond precision, `YYYY-MM-DDTHH:MM:SS.sssZ`, naming a real calendar instant (`2026-02-30...` is refused). |
| digest | `sha256:` followed by 64 lower-case hex digits (of RFC 8785 JSON, unless stated). |
| uint | Integer 0 to 2^53 - 1. |
| identifier | String of 1-256 characters, subject to [privacy](#identifiers-and-privacy). |
| scalar | String (at most 256 characters), number, boolean or null. |

String lengths are counted in Unicode code points.

### Extensions

`case.ext` and `entries[].ext` MAY carry members named `x-<org>.<name>`
(`^x-[a-z0-9-]+\.[A-Za-z0-9_.-]+$`), at most 64 per object, with any JSON
value. They are hashed like everything else and not interpreted. Producers
MUST NOT put personal data in extensions.

## Identifiers and privacy

By default nothing in a package lets a reader recover or confirm a person,
the case subject, a provider record or tool input, and nothing lets two
packages be joined. Five classes of value are keyed per case unless the case
owner discloses them:

| Class | Fields | Keyed form |
|---|---|---|
| `principal` | `grant.data.principal` | pseudonym |
| `approver` | `decision.data.approver` | pseudonym |
| `subject` | `case.subject`, `decision.data.action.subject`; decides between `action_hash` and `action_ref` | pseudonym |
| `record` | `tool_call.data.upstream_records[].record_id`, `record_id` and `excerpt_ref` of every evidence reference | pseudonym |
| `content` | `tool_call.data.input_hash`, `tool_call.data.output_hash` | keyed digest |

Other values are tokens, versions, public digests (prompts, policies, memo,
rationale and reason text, which are per-case documents) or enumerations.
Tool inputs and outputs, memos and free text never appear, only digests.

`privacy` has these members:

| Member | Required | Meaning |
|---|---|---|
| `scheme` | yes | `hmac-sha256-v1` (the default) or `none`. |
| `key_id` | with `hmac-sha256-v1` | Names the tenant key. The key is never in the package. |
| `disclosed` | yes | Classes that appear in the clear, sorted, no duplicates. |

With `scheme: none`, `disclosed` MUST list all five classes and `key_id` MUST
be absent; with `hmac-sha256-v1`, `key_id` MUST be present and at least one
class MUST be keyed.

### Key derivation

Every HMAC input is the RFC 8785 form of a JSON array, so no two inputs can
collide by concatenation:

```
case_key   = HMAC-SHA256(tenant_key, JCS(["grantex-evidence-case-v1", tenant_id, case_id]))
pseudonym  = "pz:" || base64url(HMAC-SHA256(case_key, JCS(["pseudonym-v1", class, value])))    ; 43 characters
content    = "hmac-sha256:" || hex(HMAC-SHA256(case_key, JCS(["content-v1", "sha256:<hex>"])))
action_ref = "ak:" || base64url(HMAC-SHA256(case_key, JCS(["action-v1", action_hash])))
```

`tenant_key` is at least 32 bytes; the auth service derives one per tenant
from `EVIDENCE_PSEUDONYMISATION_SECRET`. Keyed values are stable within a case
(an auditor can see that two approvers differ, or that one record was cited
twice) and unrelated across cases. Whoever holds the tenant key can recompute
them to confirm a value. Vectors:
[`examples/evidence/pseudonyms.json`](examples/evidence/pseudonyms.json).

### Decisions and the subject

A decision grant's `action_hash` is an unkeyed SHA-256 over the semantic
action, which contains the subject in the clear. Publishing it next to a
pseudonymised subject would let anyone confirm a guessed subject. Therefore:

- with `subject` disclosed, decisions and consumptions carry `action_hash`,
  and verifiers recompute it from `action`;
- otherwise they carry `action_ref` (the keyed form above) and MUST NOT carry
  `action_hash`; decisions are linked to each other and to consumptions by
  `action_ref`. The case owner can confirm an `action_ref` against the
  decision grant's `action_hash` with the tenant key.

### Opting out

Disclosure is an explicit decision by the case owner and by the operator: the
auth service refuses `disclose` unless the developer is listed in
`EVIDENCE_DISCLOSURE_DEVELOPER_IDS`. The SDK builders take
`disclosed=`/`disclosed:`.

## Entries

Each entry is an object:

| Member | Required | Meaning |
|---|---|---|
| `seq` | yes | Its index in `entries`. |
| `type` | yes | `grant`, `run_context`, `tool_call`, `policy_evaluation`, `recommendation`, `disposition`, `decision`, `decision_consumption`, `revocation` or `void`. |
| `at` | yes | When it happened, as the producer states it. |
| `source` | yes | Who asserted it and when it was recorded (below). |
| `data` | yes | Type-specific content (tables below); unknown members refused. |
| `ext` | no | Extensions. |
| `prev`, `hash` | yes | See [Hash chain](#hash-chain). |

### `source`

| Member | Required | Meaning |
|---|---|---|
| `authority` | yes | `platform`: produced by the auth service from its own records. `tenant`: asserted by the tenant's platform through the records endpoint. |
| `recorded_at` | yes | When the recording service accepted it (server time). |
| `audit_entry_id`, `audit_hash` | no | The audit entry that holds the record. |
| `late` | no | `true` when recorded after the case's decision was consumed or after its first export. |

`grant`, `decision`, `decision_consumption` and `revocation` entries MUST have
authority `platform`. Verifiers report how many entries are tenant-asserted.

### Order and time

The grant chain comes first, root to leaf. Every later entry has `recorded_at`
greater than or equal to the entry before it (the recording service's order,
not the producer's clock). For every entry, `at` MUST NOT be later than
`recorded_at` plus the maximum clock skew, 300,000 ms. After a
`decision_consumption`, every tenant-asserted entry MUST carry `late: true`.

References point to earlier entries (a run, a call, an evaluation, a decision,
the target of a void), except `decision_consumption.call_id`, which may point
to the call the consumption authorised. A void record MUST NOT be cited.

### `grant`

| Member | Required | Meaning |
|---|---|---|
| `grant_id` | yes | Grant identifier. |
| `parent_grant_id` | yes | The previous grant in the chain; `null` for the root. |
| `depth` | yes | Equal to the entry's position. |
| `agent_id`, `scopes` | yes | As issued. |
| `principal` | yes | identifier (`principal`). |
| `purpose` | yes | Grant purpose (PRD G-2) or `null`. |
| `authorization_details` | yes | As issued (`urn:grantex:tools:v1` items carry `connector`, `purpose`, `data_region`, `tools`, `caps`). |
| `issued_at`, `expires_at` | yes | `at` equals `issued_at`; `expires_at` not before it. |
| `revoked_at` | yes | Timestamp or `null`; set exactly when `status` is `revoked`. |
| `status` | yes | `active`, `revoked` or `expired` at export. |

A delegated grant MUST be issued within its parent's validity (plus skew).

### `run_context`

`{run_id, agent_id, model: {provider, name, version}, prompts: [{id, version, digest}], policies: [{id, version, digest}], schemas: [{id, version}]}`.

### `tool_call`

| Member | Required | Meaning |
|---|---|---|
| `call_id` | yes | Unique per package. |
| `grant_id` | yes | A grant in the chain. |
| `run_id` | no | An earlier run context. |
| `connector`, `tool`, `provider` | yes | For example `acme_kyb`, `verify_business`, `mock`. |
| `purpose` | yes | Or `null`. |
| `outcome` | yes | `allowed`, `denied` or `error`. |
| `denial` | exactly when denied | `{reason, sub_reason?}` using the denial taxonomy. |
| `input_hash` | yes | content digest of the canonical input. |
| `output_hash` | yes | content digest of the canonical output; `null` unless `allowed`. |
| `upstream_records` | yes | `[{record_id, record_type?, retrieved_at}]`; empty unless `allowed`. |
| `cost_units` | no | uint. |
| `started_at`, `completed_at?` | | `completed_at` not before `started_at`. |

An `allowed` call's `at` MUST fall within its grant's validity (issue to the
earlier of expiry and revocation, plus skew). Denied calls may come later:
they record, for example, the refusal after a revocation.

### Evidence references

`{call_id, provider, record_id, retrieved_at, field?, excerpt_ref?}`: the call
MUST be an earlier, non-void tool call with the same `provider` that returned
an upstream record with that `record_id` and `retrieved_at`.

### `policy_evaluation`

| Member | Required | Meaning |
|---|---|---|
| `evaluation_id` | yes | Unique per package. |
| `run_id` | no | An earlier run context. |
| `policy` | yes | `{id, version, digest}`. |
| `score`, `tier` | yes | Number; `low`, `medium`, `high` or `blocked`. |
| `fired_rules` | yes | `[{rule_id, tier, reason_code, reason_digest?}]` in firing order; free-text reasons appear only as a digest. |
| `inputs` | yes | `[{path, value, evidence: [reference], unsourced?}]`. Every input either cites at least one reference or is marked `unsourced: true`, never both. Verifiers report the number of unsourced inputs. |

### `recommendation`

`{recommendation_id, evaluation_ids: [..1-64], run_id?, outcome (approve | decline | refer | request_information), memo_digest, sections: [{section, status (complete | issues_found | not_available), evidence: [reference]}], missing_items?}`.
Every `evaluation_id` is an earlier non-void evaluation; every section that is
not `not_available` cites at least one reference.

### `disposition`

A screening-hit disposition (PRD US-3):
`{disposition_id, run_id?, hit: reference, comparisons: [{identifier (name | date_of_birth | nationality | address | associated_entities | registration_number), result (match | partial | mismatch | not_available), evidence: [reference]}], outcome (false_positive | true_match | inconclusive | escalate), confidence_band (low | medium | high), rationale_digest}`.

### `decision`

A human decision with the fields of the decision grant (PRD G-3):

| Member | Required | Meaning |
|---|---|---|
| `jti`, `issuer`, `request_id?` | | Unique `jti`. |
| `approver` | yes | identifier (`approver`). |
| `approver_auth` | yes | For example `sso+webauthn`. |
| `dwell_ms` | yes | uint. |
| `action` | yes | `{case_id, action, decision, subject, amount?}`; `case_id` equals `case.case_id`; `subject` equals `case.subject` when that is present. |
| `action_hash` \| `action_ref` | one | See [Decisions and the subject](#decisions-and-the-subject). |
| `approval_position`, `approvals_required` | yes | 1 or 2; position not above required. |
| `first_jti` | exactly for position 2 | An earlier, unconsumed position-1 decision with the same action, `approvals_required` 2 and a different `approver`. |
| `issued_at`, `expires_at` | yes | `expires_at` not before `issued_at`. |

### `decision_consumption`

`{jtis, action_hash | action_ref, consumed_at, call_id?}`. Every `jti` is an
earlier decision for the same action that has not been consumed; together
they present every required approval exactly once (positions 1..n where n is
`approvals_required`); `consumed_at` falls within each decision's validity.

### `revocation`

`{grant_id, revoked_at, reason?, trigger? (admin | api | cascade | event | expiry), event_id?, cascade?}`:
`grant_id` is in the chain and `revoked_at` equals that grant's `revoked_at`.

### `void`

`{target_type, target_id, reason_code, voided_at}`: withdraws an earlier
tenant record of that type and id (`run_context`, `tool_call`,
`policy_evaluation`, `recommendation`, `disposition`). Nothing is removed; the
record stays in the chain and can no longer be cited.

## Canonical form

Packages use RFC 8785 (JCS) as profiled in
[canonicalization.md](canonicalization.md), with the shared implementation
`grantex.canonical` / `canonical.ts`.

**A package is valid only as its own canonical form**: its bytes MUST equal the
UTF-8 JCS serialisation of the parsed package, optionally followed by one
line feed. A verifier therefore refuses a byte-order mark, whitespace, a
duplicate member, a number written any other way, `NaN` or `Infinity`, an
unpaired surrogate and nesting deeper than 64. Every byte is significant.

## Hash chain

`H(x)` is `"sha256:"` followed by the lower-case hex SHA-256 of the UTF-8 JCS of `x`.

```
chain.genesis   = H({case, format, privacy, version})
entries[0].prev = chain.genesis
entries[i].prev = entries[i-1].hash
entries[i].hash = H(entries[i] without "hash")       ; covers seq, type, at, source, data, ext, prev
chain.head      = entries[n-1].hash
chain.length    = n
chain.root      = H({alg: "sha256", canonicalization: "RFC8785", genesis, head, length})
```

## Anchor

When the auth service exports a package it appends a **platform** entry to the
tenant's audit hash chain and embeds it as `anchor`:

```json
{"type": "grantex-audit-entry",
 "audit_entry": {"id": "alog_...", "action": "evidence.package_exported", "status": "success",
   "developerId": "<case.tenant_id>", "agentId": "", "agentDid": "", "grantId": "", "principalId": "platform",
   "metadata": {"case_id": "...", "entry_count": 18, "format": "grantex-evidence-package",
                "grantex:platform": true, "package_root": "<chain.root>", "version": "1.0"},
   "timestamp": "...", "prevHash": "<previous audit hash or null>", "hash": "<audit hash>"}}
```

The empty agent, DID and grant, the `platform` principal and the
`grantex:platform` metadata member are required, and none of them can be
written by a tenant: `POST /v1/audit/log` requires non-empty agent, DID and
grant ids and refuses actions starting with `evidence.`, `decision.` or
`grantex.` and metadata members starting with `grantex:`. `hash` is the audit
hash, the lower-case hex SHA-256 of
`{"id":…,"agentId":…,"agentDid":…,"grantId":…,"principalId":…,"developerId":…,"action":…,"metadata":<JCS>,"timestamp":…,"prevHash":…,"status":…}`
with members in exactly that order, values in JCS form and no whitespace.

## Signature

A package MAY carry `signature: {alg, kid, jws}` (`ES256` or `RS256`), a
compact JWS with detached payload (`<header>..<signature>`):

- protected header exactly `{"alg": <alg>, "kid": <kid>, "typ": "grantex-evidence-package+jws"}`;
- payload the UTF-8 JCS of `{"anchor": <anchor audit hash or null>, "root": <chain.root>}`,
  so the signature covers both the package and the audit entry that recorded it;
- ES256 signatures are 64-byte `R || S`; base64url parts are unpadded and canonical.

A verifier selects the single JWKS key with that `kid`; `use`, if present
(including `null`), MUST be `sig`, and `alg`, if present, MUST match; RSA keys
are at least 2048 bits. The auth service signs with its active platform key,
published at `/.well-known/jwks.json`.

## Trust

What a successful verification proves depends on what the verifier was given:

| Inputs | `anchor_status` | Proves |
|---|---|---|
| `--root` only | `internal-consistency-only` (or `absent`) | The package is unchanged since someone computed that root. Anyone able to write the package could have computed it. |
| `--root` and `--anchor` from the tenant's audit log | `pinned` | The package matches a platform audit entry, as far as the source of that hash can be trusted. |
| `--root` and the service JWKS | `signed` | The auth service exported this package and recorded it in the audit chain. **Third parties need this.** |

Tenant-asserted entries (`source.authority: tenant`) are statements the
tenant's platform made to the service at `recorded_at`; the signature proves
the service received and chained them, not that they are true. Platform
entries (grants, decisions, consumptions, revocations) come from the service's
own records: decisions only from the decision-grant store, never from audit
entries a tenant could write.

## Verification

Inputs: the package bytes, the trusted root (required), and optionally a
trusted anchor hash, whether an anchor or signature is required, a JWKS and a
size limit (default 64 MiB). Steps run in order and stop at the first failure.

| # | Check | Code |
|---|---|---|
| 1 | A trusted root was given and is a digest | `missing_root` |
| 1 | A trusted anchor hash, if given, is 64 hex digits | `anchor_not_trusted` |
| 2 | Size within the limit | `too_large` |
| 3 | UTF-8, no BOM, valid JSON; no duplicate members | `malformed_json`, `duplicate_key` |
| 4 | Numbers and bytes in canonical form | `non_canonical_number`, `non_canonical_document` |
| 5 | `format`, `version` | `unsupported_format`, `unsupported_version` |
| 6 | Structure matches the schema, including calendar-valid timestamps | `schema_violation` |
| 7 | `privacy` consistent; undisclosed classes keyed; `action_hash`/`action_ref` as privacy requires | `privacy_violation` |
| 8 | `chain.genesis`; per entry `seq`, `prev`, `hash`; `head`, `length`, `root` | `genesis_mismatch`, `sequence_mismatch`, `link_mismatch`, `entry_hash_mismatch`, `head_mismatch`, `length_mismatch`, `root_mismatch` |
| 9 | Per entry, in order: authority of platform types | `authority_violation` |
| 9 | `at` not later than `recorded_at` + skew | `validity_violation` |
| 9 | Grant chain root to leaf; grant validity windows | `grant_chain_broken`, `validity_violation` |
| 9 | Recording order; late marking after consumption | `entries_out_of_order`, `validity_violation` |
| 9 | Unique ids; references resolve to earlier non-void entries and cited records exist | `duplicate_identifier`, `dangling_reference` |
| 9 | Tool-call outcome consistency; allowed calls within grant validity | `tool_call_inconsistent`, `validity_violation` |
| 9 | Inputs cite evidence or are unsourced; sections cite evidence | `schema_violation` |
| 9 | Decision for this case and subject; `action_hash` recomputes when disclosed | `case_mismatch`, `action_hash_mismatch` |
| 9 | Approval positions and pairing; consumption complete, once, within validity; revocation times | `decision_inconsistent`, `validity_violation` |
| 10 | `chain.root` equals the trusted root | `root_not_trusted` |
| 11 | Anchor present if required or pinned; audit hash recomputes; records this tenant, case, length, root and the platform marker; equals the pinned hash | `anchor_missing`, `anchor_hash_mismatch`, `anchor_mismatch`, `anchor_not_trusted` |
| 12 | Signature present if required; checked against a JWKS unless explicitly skipped; one key for the `kid`; valid over root and anchor | `signature_missing`, `signature_unverified`, `signature_key_unknown`, `signature_invalid` |

Within step 6 a verifier reports the first violation found by visiting, for
each object, unknown members, then missing required members, then
`maxProperties`, then present members (JCS member order), then `allOf`; for
arrays, size limits, items in order, `uniqueItems`; for a value, `type`,
`const`, `enum`, then string or number limits, `pattern` and `format`.
Within step 7 the visit order is: `privacy` consistency, `case.subject`, then
per entry the class fields in the order listed in `checks` of the reference
implementations (tool call: `input_hash`, `output_hash`, upstream record ids;
decision: `action.subject`, action key, `approver`; then evidence references,
`excerpt_ref` before `record_id`).

A failure reports `code`, `entry_index`, `field_path` (for example
`entries[13].hash`, `entries[10].data.inputs[1].evidence[0].record_id`),
`expected` and `actual`. A success reports `anchor_status`,
`signature_status`, `signature_kid`, `unsourced_inputs`, `late_entries` and
`tenant_asserted_entries`. Every case in
[`examples/evidence/invalid-cases.json`](examples/evidence/invalid-cases.json)
records the exact result every implementation must produce.

## Producing evidence through the auth service

Authenticated with the tenant's API key, scoped to that tenant, rate limited,
and enabled by `EVIDENCE_EXPORT_ENABLED` (off by default).

### Record evidence

`POST /v1/evidence/cases/{caseId}/records` with `{"records": [...]}`, 1-100 per
request, each `{type, at, data, ext?, agent_id?, agent_did?}`:

- `type` is `run_context`, `tool_call`, `policy_evaluation`, `recommendation`
  or `disposition`. Grants, decisions, consumptions and revocations come from
  the service's own records and cannot be submitted.
- Values are sent in the clear (`input_hash`/`output_hash` as plain `sha256:`
  digests); they are keyed on export.
- Everything is checked before anything is written: structure, record rules,
  `at` not in the future, references to runs, calls and evaluations already
  recorded on the case and not void, the grant belongs to the tenant and to
  the one delegation chain the case uses, and allowed calls fall within the
  grant's validity. A failure rejects the whole request with `400
  EVIDENCE_RECORD_INVALID`, `422 EVIDENCE_REFERENCE_INVALID`,
  `422 EVIDENCE_GRANT_CHAIN_AMBIGUOUS` or `422 EVIDENCE_OUTSIDE_GRANT_VALIDITY`
  and a `field_path`.
- **Idempotent** on the record's id (`run_id`, `call_id`, `evaluation_id`,
  `recommendation_id`, `disposition_id`): resending the same content returns
  the original entry with `duplicate: true` (`200`); different content returns
  `409 EVIDENCE_RECORD_CONFLICT`.
- Each record becomes a platform-authored audit entry `evidence.<type>` whose
  metadata is `{case_id, evidence: {type, at, data, ext?}, "grantex:platform": true, recorded_at}`,
  in server recording order, never stamped ahead of the clock.
- Response `201 {"case_id", "records": [{"audit_entry_id", "hash", "duplicate"}]}`.

### Void a record

`POST /v1/evidence/cases/{caseId}/void` with `{target_type, target_id, reason_code}`
appends a `void` entry. Voiding again for the same reason is a no-op;
another reason is `409`.

### Export a package

`POST /v1/evidence/cases/{caseId}/export` with `{"disclose": [...], "sign": false}`
(both optional; any other member is `400`). `disclose` needs the developer in
`EVIDENCE_DISCLOSURE_DEVELOPER_IDS` (`403 EVIDENCE_DISCLOSURE_NOT_PERMITTED`).

The service loads the case's records in recording order and re-verifies each
source audit entry: its hash, the platform marker, its record, and that it
links to an existing earlier audit entry. It adds the grant chain the case's
tool calls used, decisions and consumptions from the decision-grant store
(response header `Grantex-Evidence-Decisions: included` or `unavailable`),
and revocations of chain grants; marks tenant records made after a
consumption or the first export as late; derives the case state; builds,
anchors (subject to plan limits), optionally signs, verifies the final bytes
and returns `200` with `Grantex-Evidence-Root` and `Grantex-Evidence-Anchor`.

Errors: `404 EVIDENCE_CASE_NOT_FOUND`, `409 EVIDENCE_CHAIN_VERIFICATION_FAILED`
(a source entry does not match its hash or link, or the package does not
verify; `grantex_evidence_chain_verification_failures_total` increments and
the alert fires), `413 EVIDENCE_CASE_TOO_LARGE`, `402 PLAN_LIMIT_EXCEEDED`,
`422 EVIDENCE_INCOMPLETE | EVIDENCE_SOURCE_INVALID | EVIDENCE_GRANT_CHAIN_INVALID`,
`503 EVIDENCE_PSEUDONYMISATION_KEY_MISSING | EVIDENCE_SIGNING_UNAVAILABLE`.
Export of a decided case completes within five seconds at the 95th percentile
(`grantex_evidence_export_duration_seconds`).

## Tooling

- Python `grantex.evidence`: `build_package`, `verify_package`,
  `upstream_records_for`, `sign_root`, `pseudonymise`, `record_evidence`,
  `void_record`, `export_package`. Console script `grantex-evidence verify|export`.
- TypeScript `evidence` namespace of `@grantex/sdk` (also
  `@grantex/sdk/evidence`), and `grantex evidence verify|export` in `@grantex/cli`.
- `verify` exits 0 when every check passes, 1 on any failure (printing the
  failing link) and 2 on usage errors, including a missing or malformed `--root`.

## Versioning

`version` is `"1.0"`. A verifier refuses a version it does not implement.

## Security considerations

- **Trust comes from inputs obtained independently of the package**: the
  root, a pinned anchor hash, or best the service signature. See [Trust](#trust).
- **Completeness is not proven.** The package proves what was recorded and
  when; it cannot prove the platform recorded every call. Record at the
  enforcement point and reconcile with the audit log.
- **Keyed values are not anonymous** to whoever holds the tenant key; rotate by
  changing `EVIDENCE_PSEUDONYMISATION_KEY_ID` and the secret together.
- **Tokens and extensions** are not keyed; producers must keep personal data
  out of them.
- **Clock skew** is bounded (five minutes); ordering and lateness use server
  time.
- **ECDSA malleability** (`S` and `n - S`) changes signature bytes, never what
  is signed.
