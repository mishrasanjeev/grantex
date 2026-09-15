# Evidence package 1.0

Status: draft for Grantex 0.6 (PRD G-5). Normative structure:
[`evidence-package-1.0.schema.json`](evidence-package-1.0.schema.json) (JSON
Schema 2020-12, `$id` `https://grantex.dev/spec/evidence-package-1.0.schema.json`).
Examples and shared test cases: [`examples/evidence/`](examples/evidence/).

An evidence package is one JSON document per case that lets someone who was
not there establish, without access to the systems that produced it:

- which grants an agent acted under, root to leaf, with purposes and caps;
- every tool call, with hashes of its input and output, the provider and the
  identifiers of the upstream records it returned;
- the model, prompt, policy and schema versions in use;
- each policy evaluation with its score, tier, fired rules and cited inputs;
- each recommendation with the evidence cited by every section;
- every human decision with approver, authentication method, dwell time and
  the exact semantic action approved;
- revocations;
- that none of the above was edited afterwards: a hash chain whose root is
  recorded in the auth service's audit hash chain, optionally signed.

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## Contents

1. [Document](#document)
2. [Identifiers and privacy](#identifiers-and-privacy)
3. [Entries](#entries)
4. [Canonical form](#canonical-form)
5. [Hash chain](#hash-chain)
6. [Anchor](#anchor)
7. [Signature](#signature)
8. [Verification](#verification)
9. [Producing evidence through the auth service](#producing-evidence-through-the-auth-service)
10. [Tooling](#tooling)
11. [Security considerations](#security-considerations)

## Document

A package is a JSON object with exactly these members:

| Member | Required | Covered by the root | Content |
|---|---|---|---|
| `format` | yes | yes | `"grantex-evidence-package"` |
| `version` | yes | yes | `"1.0"` |
| `case` | yes | yes | The case the package is about. |
| `privacy` | yes | yes | How identifiers appear. |
| `entries` | yes | yes | The evidence, as a hash-chained array (at least one entry). |
| `chain` | yes | yes | Chain summary and the package root. |
| `anchor` | no | no, it records the root | The audit-chain entry that recorded the root. |
| `signature` | no | no, it signs the root | Detached JWS over the root. |

Unknown members are refused everywhere except inside `ext` objects and inside
`authorization_details` items (which are copied from issued grants, where RFC
9396 allows further members).

A trimmed example (the full package is
[`examples/evidence/evidence-package.json`](examples/evidence/evidence-package.json); it is shown
here indented, but a package is only valid in its canonical form):

```json
{
  "anchor": {"audit_entry": {"action": "evidence.package_exported", "agentDid": "", "agentId": "",
    "developerId": "dev_demo_0001", "grantId": "", "hash": "538b08d7…", "id": "alog_demo_0099",
    "metadata": {"case_id": "case_demo_0001", "entry_count": 15, "format": "grantex-evidence-package",
      "package_root": "sha256:e2f5dbf9…", "version": "1.0"},
    "prevHash": "…", "principalId": "platform", "status": "success", "timestamp": "2026-09-14T10:30:00.123Z"},
    "type": "grantex-audit-entry"},
  "case": {"case_id": "case_demo_0001", "exported_at": "2026-09-14T10:30:00.000Z",
    "issuer": "https://auth.example.com", "state": "decided", "subject": "pz:…", "tenant_id": "dev_demo_0001"},
  "chain": {"alg": "sha256", "canonicalization": "RFC8785", "genesis": "sha256:…",
    "head": "sha256:…", "length": 15, "root": "sha256:e2f5dbf9…"},
  "entries": [
    {"at": "2026-09-14T09:00:00.000Z", "data": {"grant_id": "grnt_demo_root", "…": "…"},
     "hash": "sha256:…", "prev": "sha256:<genesis>", "seq": 0, "type": "grant"},
    "…"
  ],
  "format": "grantex-evidence-package",
  "privacy": {"disclosed": [], "key_id": "example-key-1", "scheme": "hmac-sha256-v1"},
  "version": "1.0"
}
```

### `case`

| Member | Required | Type | Meaning |
|---|---|---|---|
| `case_id` | yes | token | The case identifier used by the platform (for decision grants, the `case_id` of the semantic action). |
| `tenant_id` | yes | token | The auth service developer (tenant) that owns the case. |
| `issuer` | yes | token | The auth service issuer URL. |
| `state` | yes | `open` \| `decided` \| `closed` | Case state at export. |
| `exported_at` | yes | timestamp | When the package was assembled. |
| `subject` | no | identifier (`subject`) | What the case is about (for example `gb:00000001`). |
| `ext` | no | extension object | See [Extensions](#extensions). |

### Common value types

| Type | Rule |
|---|---|
| token | String of 1-256 printable ASCII characters (U+0021-U+007E), no spaces. |
| text | String of 1-512 characters. |
| timestamp | UTC with exactly millisecond precision: `YYYY-MM-DDTHH:MM:SS.sssZ` (the form `Date.prototype.toISOString` writes). Compared as strings. |
| digest | `sha256:` followed by 64 lower-case hex digits. |
| uint | Integer 0 to 2^53 - 1. |
| identifier | String of 1-256 characters, subject to [privacy](#identifiers-and-privacy). |
| scalar | String (at most 256 characters), number, boolean or null. |

String lengths are counted in Unicode code points.

### Extensions

`case.ext` and `entries[].ext` MAY carry extension members named
`x-<org>.<name>` (`^x-[a-z0-9-]+\.[A-Za-z0-9_.-]+$`), at most 64 per object,
with any JSON value. Extensions are hashed like everything else. Verifiers
do not interpret them. Producers MUST NOT put personal data in extensions
unless the case owner has configured it.

## Identifiers and privacy

Packages contain no raw personal data beyond what the case owner configured.
Three classes of identifier can refer to people or to the case subject:

| Class | Fields |
|---|---|
| `principal` | `entries[type=grant].data.principal` |
| `approver` | `entries[type=decision].data.approver` |
| `subject` | `case.subject`, `entries[type=decision].data.action.subject` |

Every other field is either not personal (grant, call, record, policy and
agent identifiers, hashes, versions) or is a hash. Tool inputs and outputs
appear only as hashes; free text (memos, override reasons, excerpts) appears
only as a digest or a reference.

`privacy` has these members:

| Member | Required | Meaning |
|---|---|---|
| `scheme` | yes | `hmac-sha256-v1` (pseudonymised, the default) or `none`. |
| `key_id` | with `hmac-sha256-v1` | Names the tenant key used. The key is never in the package. |
| `disclosed` | yes | The identifier classes that appear in the clear, sorted, no duplicates. |

Rules: with `scheme: none`, `disclosed` MUST be all three classes and `key_id`
MUST be absent; with `hmac-sha256-v1`, `key_id` MUST be present and at least
one class MUST be pseudonymised. Every identifier of a class not in
`disclosed` MUST be a pseudonym.

### Pseudonyms

```
case_key  = HMAC-SHA256(tenant_key, UTF-8("grantex-evidence-v1:" || tenant_id || ":" || case_id))
pseudonym = "pz:" || base64url(HMAC-SHA256(case_key, UTF-8(class || ":" || value)))   ; unpadded, 43 characters
```

`tenant_key` is a secret of at least 32 bytes held by the case owner (the auth
service derives one per tenant). The same identifier in the same case always
has the same pseudonym, so an auditor can see that two decisions had
different approvers or that the approver of one case was the same person
throughout; pseudonyms of one person differ between cases, so packages cannot
be joined on them. The case owner, holding the key, can recompute a pseudonym
to confirm who it refers to. Vectors:
[`examples/evidence/pseudonyms.json`](examples/evidence/pseudonyms.json).

### Opting out

The case owner discloses classes by listing them. The auth service export
takes `disclose` (for example `["approver"]`); the SDK builders take
`PrivacySettings(disclosed=...)` / `{ disclosed: [...] }`. Disclosing
`subject` lets a verifier recompute each decision's `action_hash` from the
action (see [decision](#decision)); with `subject` pseudonymised the
`action_hash` is still the one the decision grant carried, but only the case
owner can recompute it.

## Entries

Each entry is an object:

| Member | Required | Meaning |
|---|---|---|
| `seq` | yes | Its index in `entries`. |
| `type` | yes | One of the types below. |
| `at` | yes | When it happened (timestamp). |
| `data` | yes | Type-specific content (tables below), unknown members refused. |
| `source` | no | `{audit_entry_id, audit_hash}`: the auth-service audit entry it was assembled from. |
| `ext` | no | Extensions. |
| `prev` | yes | Hash of the previous entry, or `chain.genesis` for entry 0. |
| `hash` | yes | Hash of this entry without `hash`. |

Order: the grant chain comes first, root to leaf (entry 0 is the root grant);
every later entry has `at` greater than or equal to the entry before it. A
reference to another entry (a call, a run, an evaluation, a decision) MUST
point to an earlier entry, except `decision_consumption.call_id`, which may
point to the call that the consumption authorised.

### `grant`

| Member | Required | Meaning |
|---|---|---|
| `grant_id` | yes | Grant identifier. |
| `parent_grant_id` | yes | The previous grant in the chain; `null` for the root. |
| `depth` | yes | 0 for the root, equal to the entry's position. |
| `agent_id` | yes | The agent the grant was issued to. |
| `principal` | yes | identifier (`principal`). |
| `purpose` | yes | Grant purpose (PRD G-2) or `null`. |
| `scopes` | yes | Scopes granted. |
| `authorization_details` | yes | As issued (RFC 9396 / Appendix A of the PRD): items with `type`; for `urn:grantex:tools:v1`, `connector`, `purpose`, `data_region`, `tools` and `caps` (tool or `cost_units` to a map of limit name to uint). |
| `issued_at`, `expires_at` | yes | Timestamps. `at` equals `issued_at`. |
| `status` | yes | `active`, `revoked` or `expired` at export. |

### `run_context`

| Member | Required | Meaning |
|---|---|---|
| `run_id` | yes | Unique per package. |
| `agent_id` | yes | The agent that ran. |
| `model` | yes | `{provider, name, version}`. |
| `prompts` | yes | `[{id, version, digest}]`. |
| `policies` | yes | `[{id, version, digest}]`. |
| `schemas` | yes | `[{id, version}]`. |

### `tool_call`

| Member | Required | Meaning |
|---|---|---|
| `call_id` | yes | Unique per package. |
| `grant_id` | yes | A grant in the chain. |
| `run_id` | no | An earlier `run_context`. |
| `connector`, `tool`, `provider` | yes | For example `acme_kyb`, `verify_business`, `mock`. |
| `purpose` | yes | Purpose the call was made for, or `null`. |
| `outcome` | yes | `allowed`, `denied` or `error`. |
| `denial` | if denied | `{reason, sub_reason?}` using the denial taxonomy (`decision_required`, `cap_exceeded`, ...). Absent otherwise. |
| `input_hash` | yes | digest of the canonical tool input. |
| `output_hash` | yes | digest of the canonical output; `null` unless `allowed`. |
| `upstream_records` | yes | `[{record_id, record_type?, retrieved_at}]`; empty unless `allowed`. |
| `cost_units` | no | uint. |
| `started_at` | yes | Timestamp. |
| `completed_at` | no | Not before `started_at`. |

### Evidence references

Policy inputs and recommendation sections cite records with
`{call_id, provider, record_id, retrieved_at, field?, excerpt_ref?}`. The
`call_id` MUST be an earlier `tool_call` with the same `provider` that
returned an upstream record with that `record_id` and `retrieved_at`.

### `policy_evaluation`

| Member | Required | Meaning |
|---|---|---|
| `evaluation_id` | yes | Unique per package. |
| `run_id` | no | An earlier `run_context`. |
| `policy` | yes | `{id, version, digest}`. |
| `score` | yes | Number. |
| `tier` | yes | `low`, `medium`, `high`, `blocked`. |
| `fired_rules` | yes | `[{rule_id, tier, reason}]` in firing order. |
| `inputs` | yes | `[{path, value, evidence: [reference]}]`: every evidence field the policy read, its scalar value, and the records it came from. |

### `recommendation`

| Member | Required | Meaning |
|---|---|---|
| `recommendation_id` | yes | Unique per package. |
| `evaluation_id` | yes | An earlier `policy_evaluation`. |
| `outcome` | yes | `approve`, `decline`, `refer` or `request_information`. |
| `memo_digest` | yes | digest of the canonical memo. |
| `sections` | yes | `[{section, status, evidence: [reference]}]`; `status` is `complete`, `issues_found` or `not_available`; every section that is not `not_available` MUST cite at least one reference. |
| `missing_items` | no | Tokens. |

### `decision`

A human decision, with the fields of the decision grant (PRD G-3).

| Member | Required | Meaning |
|---|---|---|
| `jti` | yes | Decision grant identifier, unique per package. |
| `issuer` | yes | Decision grant `iss`. |
| `request_id` | no | The decision request. |
| `approver` | yes | identifier (`approver`): the grant's `sub`. |
| `approver_auth` | yes | Authentication method, for example `sso+webauthn`. |
| `dwell_ms` | yes | uint: time from render to submit. |
| `action` | yes | `{case_id, action, decision, subject, amount?}`; `case_id` MUST equal `case.case_id`; `subject` is an identifier (`subject`). |
| `action_hash` | yes | `sha256:` + base64url(SHA-256(JCS(action))), computed over the action with the clear subject ([canonicalization.md](canonicalization.md)). |
| `approval_position` | yes | 1 or 2. |
| `approvals_required` | yes | 1 or 2 (2 for four-eyes). |
| `first_jti` | for position 2 | An earlier decision with the same `action_hash`, `approvals_required` 2 and a different `approver`. |
| `issued_at`, `expires_at` | yes | `expires_at` not before `issued_at`. |

### `decision_consumption`

`{jtis: [jti, jti?], action_hash, consumed_at, call_id?}`: each `jti` is an
earlier decision with this `action_hash`.

### `revocation`

`{grant_id, revoked_at, reason?, trigger?, event_id?, cascade?}` where
`grant_id` is in the chain and `trigger` is `admin`, `api`, `cascade`, `event`
or `expiry`.

## Canonical form

Packages use the JSON Canonicalization Scheme, RFC 8785, as profiled in
[canonicalization.md](canonicalization.md): members sorted by UTF-16 code
units, no whitespace, ECMAScript string escaping and number formatting, UTF-8.

**A package is valid only as its own canonical form.** The bytes of a package
MUST equal the UTF-8 JCS serialisation of the parsed package, optionally
followed by one line feed (U+000A). Consequently a verifier refuses a
byte-order mark, whitespace, a duplicate member, a number written any other
way (`61250.0`, `6.125e4`, an integer beyond 2^53 that does not survive
conversion to a double), `NaN` or `Infinity`, an unpaired surrogate, and
nesting deeper than 64 levels. This makes every byte significant: changing any
byte either breaks the JSON, breaks canonical form, or changes a value that is
hashed.

To read a package comfortably, pretty-print a copy; verify the original.

The SDKs use one implementation for decision action hashes and evidence
packages: `grantex.canonical` (Python) and `canonical.ts` (TypeScript), tested
against the vectors in [`examples/canonicalization/`](examples/canonicalization/).

## Hash chain

`H(x)` is `"sha256:"` followed by the lower-case hex SHA-256 of the UTF-8 JCS
of the JSON value `x`.

```
chain.genesis   = H({case, format, privacy, version})
entries[0].prev = chain.genesis
entries[i].prev = entries[i-1].hash                       (i > 0)
entries[i].hash = H(entries[i] without the "hash" member)  (so it covers seq, type, at, data, source, ext and prev)
chain.head      = entries[n-1].hash
chain.length    = n
chain.root      = H({alg: "sha256", canonicalization: "RFC8785", genesis, head, length})
```

The root covers everything in the package except `anchor` and `signature`,
which are about the root. Per-entry links let a verifier say exactly which
entry was changed; the root lets anyone holding it detect any change at all,
including a forger who recomputed every hash.

## Anchor

A root on its own proves only internal consistency; its value comes from
obtaining it from somewhere the package author cannot rewrite. When the auth
service exports a package it appends an entry to the tenant's existing audit
hash chain (the one behind `GET /v1/audit/entries` and signed
`POST /v1/audit/checkpoints`), and embeds that entry as `anchor`:

```json
{"type": "grantex-audit-entry",
 "audit_entry": {"id": "alog_…", "action": "evidence.package_exported", "status": "success",
   "developerId": "<case.tenant_id>", "agentId": "", "agentDid": "", "grantId": "", "principalId": "platform",
   "metadata": {"case_id": "<case.case_id>", "entry_count": <chain.length>, "format": "grantex-evidence-package",
                "package_root": "<chain.root>", "version": "1.0"},
   "timestamp": "…", "prevHash": "<previous audit entry hash or null>", "hash": "<audit hash>"}}
```

`hash` is the auth service audit hash: lower-case hex SHA-256 of

```
{"id":…,"agentId":…,"agentDid":…,"grantId":…,"principalId":…,"developerId":…,"action":…,"metadata":<JCS>,"timestamp":…,"prevHash":…,"status":…}
```

with members in exactly that order, each value in JCS form, no whitespace.
A verifier recomputes it and checks that the metadata records this package.

**Where the trusted root comes from.** An auditor obtains the root (and, if
wanted, the anchor hash) independently of the package: from the tenant's audit
log (`GET /v1/audit/entries?action=evidence.package_exported` or
`GET /v1/audit/{id}`), from a signed audit checkpoint whose chain includes the
anchor entry, or from the export response headers recorded at the time.

## Signature

A package MAY carry `signature: {alg, kid, jws}` where `alg` is `ES256` or
`RS256` and `jws` is a compact JWS with detached payload (RFC 7515 appendix F),
`<header>..<signature>`:

- protected header exactly `{"alg": <alg>, "kid": <kid>, "typ": "grantex-evidence-root+jws"}`;
- payload the ASCII bytes of `chain.root`;
- signing input `BASE64URL(header) || "." || BASE64URL(chain.root)`;
- ES256 signatures are the 64-byte `R || S` form.

Base64url parts MUST be unpadded and canonical (re-encoding the decoded bytes
gives the same text), so no two spellings of one signature exist. A verifier
selects the single key with the matching `kid` from a JWKS; `use`, if present,
MUST be `sig` and `alg`, if present, MUST match; RSA keys MUST be at least
2048 bits. The auth service signs with its current signing key, published at
`/.well-known/jwks.json`.

## Verification

Inputs: the package bytes; the **trusted root** (required); optionally a
trusted anchor hash, whether an anchor or signature is required, a JWKS, and
a size limit (default 64 MiB). A verifier MUST perform the steps below in
order and stop at the first failure, reporting its code. Codes are stable
identifiers.

| # | Check | Code |
|---|---|---|
| 1 | A trusted root was given and is a digest | `missing_root` |
| 1 | A trusted anchor hash, if given, is 64 lower-case hex digits | `anchor_not_trusted` |
| 2 | Size within the limit | `too_large` |
| 3 | UTF-8, no byte-order mark, valid JSON | `malformed_json` |
| 3 | No object has two members with the same name | `duplicate_key` |
| 4 | Every number has an exact double form and is written canonically | `non_canonical_number` |
| 4 | Bytes equal the canonical form (plus at most one line feed) | `non_canonical_document` |
| 5 | `format` is `grantex-evidence-package` | `unsupported_format` |
| 5 | `version` is supported | `unsupported_version` |
| 6 | Structure matches the schema | `schema_violation` |
| 7 | `privacy` is consistent; identifiers are pseudonyms unless disclosed | `privacy_violation` |
| 8 | `chain.genesis` | `genesis_mismatch` |
| 8 | For each entry in order: `seq`, then `prev`, then `hash` | `sequence_mismatch`, `link_mismatch`, `entry_hash_mismatch` |
| 8 | `chain.head`, `chain.length`, `chain.root` | `head_mismatch`, `length_mismatch`, `root_mismatch` |
| 9 | For each entry in order: grant chain root to leaf | `grant_chain_broken` |
| 9 | Time order after the grant chain | `entries_out_of_order` |
| 9 | Unique `grant_id`, `run_id`, `call_id`, `evaluation_id`, `recommendation_id`, `jti` | `duplicate_identifier` |
| 9 | References resolve to earlier entries and cited records exist | `dangling_reference` |
| 9 | Tool-call outcome consistent with denial, output and records | `tool_call_inconsistent` |
| 9 | A cited section is not empty | `schema_violation` |
| 9 | Decision action is for this case | `case_mismatch` |
| 9 | With `subject` disclosed, `action_hash` recomputes | `action_hash_mismatch` |
| 9 | Approval positions, `first_jti` pairing, expiry, consumption | `decision_inconsistent` |
| 10 | `chain.root` equals the trusted root | `root_not_trusted` |
| 11 | Anchor present if required or pinned | `anchor_missing` |
| 11 | Anchor audit hash recomputes | `anchor_hash_mismatch` |
| 11 | Anchor records this tenant, case, length and root | `anchor_mismatch` |
| 11 | Anchor hash equals the trusted anchor hash, if given | `anchor_not_trusted` |
| 12 | Signature present if required | `signature_missing` |
| 12 | A signed package is checked against a JWKS unless the caller explicitly accepts it unchecked | `signature_unverified` |
| 12 | Exactly one key with the `kid` | `signature_key_unknown` |
| 12 | Header, key and signature valid | `signature_invalid` |

Within step 6, a verifier reports the first violation found by visiting, for
each object, unknown members, then missing required members, then
`maxProperties`, then present members (each in JCS member order), then the
`allOf` conditions; for arrays, size limits, items in order, then
`uniqueItems`; for any value, `type`, `const`, `enum`, then string or number
limits and `pattern`. The Python and TypeScript verifiers interpret the
published schema directly with exactly these keywords.

A failed verification reports the **exact failing link** where one exists:

| Field | Meaning |
|---|---|
| `code` | The code above. |
| `entry_index` | The entry involved, if any. |
| `field_path` | Path of the failing member, for example `entries[10].hash`, `entries[7].data.inputs[1].evidence[0].record_id`, `chain.root`. Member names that are not simple identifiers are written `["name"]`. |
| `expected` | What the check required (a recomputed hash, the previous entry's hash, the trusted root, ...). |
| `actual` | What the package contains. |

For an entry changed in place the result is `entry_hash_mismatch` at that
entry, with `expected` the recomputed hash and `actual` the stored one; if the
forger also recomputed that entry's hash, `link_mismatch` at the next entry; if
they recomputed the whole chain, `root_not_trusted`.

Every case in
[`examples/evidence/invalid-cases.json`](examples/evidence/invalid-cases.json)
records the exact result (code, index, path, expected, actual) every
implementation must produce.

## Producing evidence through the auth service

Platforms (for example AgenticOrg) record evidence as it happens; the auth
service assembles, anchors and optionally signs the package. All endpoints are
authenticated with the tenant's API key, scoped to that tenant, rate limited,
and enabled by the `EVIDENCE_EXPORT_ENABLED` flag (off by default).

### Record evidence

`POST /v1/evidence/cases/{caseId}/records`

```json
{"records": [
  {"type": "tool_call", "at": "2026-09-14T09:05:03.000Z",
   "agent_id": "ag_demo_underwriter", "agent_did": "did:grantex:ag_demo_underwriter",
   "data": {"call_id": "call_0002", "grant_id": "grnt_demo_leaf", "connector": "acme_kyb",
            "tool": "verify_business", "provider": "mock", "purpose": "aml.cdd.onboarding",
            "outcome": "allowed", "input_hash": "sha256:…", "output_hash": "sha256:…",
            "upstream_records": [{"record_id": "mock:verification:v-0001", "record_type": "business_verification",
                                  "retrieved_at": "2026-09-14T09:05:03.000Z"}],
            "cost_units": 5, "run_id": "run_demo_0001", "started_at": "2026-09-14T09:05:03.000Z"}}
]}
```

- 1-100 records per request; `type` is `run_context`, `tool_call`,
  `policy_evaluation`, `recommendation`, `decision`, `decision_consumption` or
  `revocation` (grants come from the auth service itself); `data` follows the
  tables above with identifiers in the clear (they are pseudonymised on export);
  `agent_id`, `agent_did` and `ext` are optional.
- Each record is validated against the schema and appended to the tenant audit
  chain as action `evidence.<type>` with metadata
  `{"case_id": …, "evidence": {"type", "at", "data", "ext"?}}`. An invalid
  record rejects the whole request with `400 EVIDENCE_RECORD_INVALID` and the
  `field_path`.
- Response `201 {"case_id", "records": [{"audit_entry_id", "hash"}]}`.

Decision grants minted by the auth service (PRD G-3) are picked up without a
record: `decision.approved` audit entries become `decision` entries (approver
`sub`, `approver_auth`, `dwell_ms`, `action`, `action_hash`, positions,
`first_jti`, expiry; never approver e-mail or name) and `decision.consumed`
entries become `decision_consumption` entries.

### Export a package

`POST /v1/evidence/cases/{caseId}/export`

```json
{"disclose": [], "sign": false, "state": "decided"}
```

All members are optional: `disclose` (identifier classes to show in the clear,
default none), `sign` (default false), `state` (default `decided` if a decision
was consumed, otherwise `open`).

The service loads the case's evidence entries and decision-grant entries,
re-verifies each source audit entry's own hash (content tampering in the
database fails the export), builds the grant chain from the grant the tool
calls used up to its root, adds revocations recorded on those grants, orders
entries, pseudonymises, builds and verifies the package, appends the
`evidence.package_exported` anchor entry, attaches the anchor (and signature)
and returns:

- `200` with the canonical package bytes, `Content-Type: application/json`,
  headers `Grantex-Evidence-Root: sha256:…` and `Grantex-Evidence-Anchor: <hex>`;
- `404 EVIDENCE_CASE_NOT_FOUND` when the tenant has no evidence for the case;
- `422 EVIDENCE_GRANT_CHAIN_AMBIGUOUS` when tool calls used grants that are not
  on one chain, `422 EVIDENCE_INCOMPLETE` when the case has no tool call that
  names a grant;
- `409 EVIDENCE_CHAIN_VERIFICATION_FAILED` when a source audit entry does not
  match its hash or the assembled package fails verification (the metric
  `grantex_evidence_chain_verification_failures_total` is incremented and an
  alert fires);
- `503 EVIDENCE_PSEUDONYMISATION_KEY_MISSING` when pseudonymisation is needed
  and no key is configured;
- `403 FEATURE_DISABLED`, `401`, `429` as usual.

Export of a decided case completes within five seconds at the 95th
percentile (histogram `grantex_evidence_export_duration_seconds`).

## Tooling

- Python: `grantex.evidence` - `build_package`, `verify_package`,
  `upstream_records_for`, `sign_root`, `pseudonymise`, `canonicalize`.
- TypeScript: `evidence` namespace of `@grantex/sdk` (also
  `@grantex/sdk/evidence`) - `buildPackage`, `verifyPackage`,
  `upstreamRecordsFor`, `signRoot`, `pseudonymise`, `canonicalize`.
- CLI: `grantex evidence verify package.json --root <root>` exits 0 only when
  verification succeeds and otherwise prints the failing link and exits 1;
  `grantex evidence export <caseId>` calls the export endpoint.

## Versioning

`version` is `"1.0"`. A verifier refuses any version it does not implement
(`unsupported_version`); there is no "best effort" reading of a newer
package. Additive changes produce a new minor version with a new schema file;
verifiers list the versions they support.

## Security considerations

- **Trust comes from the root, not the package.** A verifier given the root
  from the package itself proves nothing beyond internal consistency. The CLI
  and libraries require the root as a separate input.
- **What the chain does not prove.** It proves the package is unchanged since
  export and that its root was recorded in the audit chain at export time. It
  does not prove that the platform recorded every tool call: completeness
  rests on the platform recording evidence through the gateway that enforces
  grants, and on comparing the package with the audit log.
- **Pseudonymisation is not anonymisation.** The case owner can re-identify
  pseudonyms; the tenant key must be protected like any other credential and
  rotated by changing `key_id`. Low-entropy identifiers could be guessed by
  someone holding the key, never without it.
- **Hashes of inputs and outputs** reveal equality: an auditor with a candidate
  input can confirm it. Producers SHOULD include a per-call nonce in hashed
  inputs when that matters.
- **Signatures** are optional because the anchor already binds the root to the
  audit chain; a signature lets a package be checked without access to the
  auth service. ECDSA signatures are malleable (`S` and `n - S`); that changes
  the signature bytes, never what is signed.
