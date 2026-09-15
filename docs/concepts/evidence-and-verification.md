---
title: "Evidence and Verification"
sidebarTitle: "Evidence and Verification"
description: "A per-case evidence package - grants, tool calls, upstream records, policy scores, human decisions - in a hash chain the auth service anchors and signs, verifiable without trusting the system that produced it."
---

## Why a package

An agent that works a regulated case - onboarding a business, dispositioning
a screening hit - leaves its trail across several systems: the grant that
authorised it, the provider calls it made, the policy that scored the result,
the person who approved the decision. An auditor asking "why was this
business referred, and who approved the decline?" should not have to query
all of them, or trust any of them.

An **evidence package** is one JSON document per case that answers those
questions on its own:

| The auditor asks | The package holds |
|---|---|
| Under what authority did the agent act? | The grant chain, root to leaf, with purpose, tools and caps. |
| What did it look at? | Every tool call: provider, tool, keyed digests of input and output, and a reference to each upstream record returned. |
| What was it running? | Model, prompt, policy and schema versions. |
| Why this recommendation? | Policy score, tier and fired rules; every input with the records it came from, or marked unsourced; the records each memo section cites; screening dispositions. |
| Who decided, and how carefully? | Every decision from the decision-grant store: approver, authentication method, dwell time, the action and its four-eyes pairing. |
| Was anything stopped or withdrawn? | Revocations, and voids of records made in error. |
| Who said so, and when? | For every entry, whether the platform or the tenant asserted it, and when the service recorded it. |
| Was any of it edited? | A hash chain whose root the auth service records in its audit chain and signs. |

The format is specified in `spec/evidence-package.md`, with a JSON Schema in
`spec/evidence-package-1.0.schema.json`.

## How tamper evidence works

1. **Canonical bytes.** A package is only valid as its own RFC 8785 canonical
   JSON, so every byte matters.
2. **A hash chain.** Each entry carries the hash of the entry before it and of
   itself. Change an entry and verification names that entry and shows the
   expected and actual hash.
3. **An anchor.** On export the auth service writes the package root into the
   tenant's audit chain as a platform-only entry and embeds that entry in the
   package. Tenants cannot write such entries through `POST /v1/audit/log`.
4. **A signature.** The service signs the root and the anchor with its
   platform key, so anyone with the service JWKS can check the package came
   from the service.

## What verification proves

| You verify with | The result says | It proves |
|---|---|---|
| the root only | `anchor: internal-consistency-only` | Nothing changed since someone computed that root. |
| the root and an anchor hash from the audit log | `anchor: pinned` | The package matches that audit entry. |
| the root and the service JWKS | `signature: verified`, `anchor: covered by the service signature` | The auth service exported and recorded this package. **Use this when the package crosses an organisational boundary.** |

Entries marked tenant-asserted are statements the tenant's platform made to
the service when they were recorded; the service's signature proves it
received them then, not that they are true. Grants, decisions, consumptions
and revocations come from the service's own records.

## Privacy by default

A default package does not let a reader recover or confirm who was involved,
what the case is about, which provider records were fetched or what the tool
inputs were, and two packages cannot be joined. Five classes are keyed per
case with HMAC unless disclosed:

- `principal` and `approver` identifiers, and the case `subject`: pseudonyms
  (`pz:...`);
- upstream `record` identifiers: pseudonyms, stable within the case so
  citations still line up;
- tool input and output `content` digests: keyed digests (`hmac-sha256:...`),
  so equal inputs in two cases do not match.

A decision grant's own `action_hash` is an unkeyed hash over the clear
subject; putting it next to a pseudonymised subject would let anyone confirm a
guess, so such packages carry a keyed `action_ref` instead. Memos, rationales
and rule reasons appear only as digests.

Disclosure (for example `"disclose": ["record"]` so an auditor can look up the
provider records) is allowed only for developers an operator lists in
`EVIDENCE_DISCLOSURE_DEVELOPER_IDS`. The case owner, holding the tenant key,
can always recompute a keyed value to confirm it.

## Verifying a package

Get the root and anchor from somewhere other than the package - the export
response headers you stored, or the tenant audit log
(`GET /v1/audit/entries?action=evidence.package_exported`) - and the service
JWKS from `/.well-known/jwks.json`. Then:

```bash
grantex evidence verify package.json --root sha256:fbc98bfa7f0c59cd400504ec838b159ba20fbbca31a64c3e50e7a848463deade --jwks jwks.json
```

(`grantex-evidence verify ...` with the Python SDK.) It exits 0 only if every
check passes and prints the trust basis:

```text
verified: 18 entries, root sha256:fbc98bfa...
  root:      matches --root
  anchor:    covered by the verified service signature
  signature: verified (kid evidence-example-es256)
  unsourced policy inputs: 1
  entries recorded late:   1
  tenant-asserted entries: 12
```

On any break it prints the failing link and exits 1 (usage errors, such as a
missing `--root`, exit 2):

```text
FAILED entry_hash_mismatch: entry 13 content does not match its hash
  entry:    13
  field:    entries[13].hash
  expected: sha256:23c2...
  actual:   sha256:1017...
```

In code:

```python
import json
from pathlib import Path

from grantex.evidence import upstream_records_for, verify_package

data = Path("spec/examples/evidence/evidence-package.json").read_bytes()
root = "sha256:fbc98bfa7f0c59cd400504ec838b159ba20fbbca31a64c3e50e7a848463deade"
anchor = "8f6af1cdf6fc68b4acdaef31e3bcf5b4ef0a4c41ebba6f7c559852df4b0ad04f"

result = verify_package(data, expected_root=root, expected_anchor_hash=anchor)
assert result.ok and result.anchor_status == "pinned", (result.code, result.field_path)

# With record identifiers disclosed, every upstream record behind the recommendation, from the package alone.
disclosed = Path("spec/examples/evidence/evidence-package-disclosed.json").read_bytes()
assert verify_package(disclosed, expected_root="sha256:b79d4c3bd0633b77615abe1153e5d982da63ee6afa07e16ddd6c75c5222d5a99").ok
for record in upstream_records_for(json.loads(disclosed), "rec_0001"):
    print(record["provider"], record["tool"], record["record_id"], record["retrieved_at"])
```

```typescript
import { readFileSync } from 'node:fs';
import { evidence } from '@grantex/sdk';

const result = evidence.verifyPackage(readFileSync('package.json'), {
  expectedRoot: 'sha256:fbc98bfa7f0c59cd400504ec838b159ba20fbbca31a64c3e50e7a848463deade',
  jwks: JSON.parse(readFileSync('jwks.json', 'utf8')),
  requireSignature: true,
});
if (!result.ok) throw new Error(`${result.code} at ${result.fieldPath}`);
```

## Producing evidence

A platform records evidence as the case runs with
`POST /v1/evidence/cases/{caseId}/records`: run context, tool calls with their
upstream record identifiers, policy evaluations, dispositions and
recommendations. Each record is checked when it is written - including its
references to earlier records and its grant - so an accepted case can always
be exported. Records are idempotent on their own ids, and mistakes are voided
with `POST /v1/evidence/cases/{caseId}/void`, never deleted. Decisions come
from the auth service's decision grants. When the case is decided,
`POST /v1/evidence/cases/{caseId}/export` returns the package. Everything is
behind the `EVIDENCE_EXPORT_ENABLED` flag, off by default.

## What it does not prove

The package proves what was recorded, by whom and when, and that nothing
changed since. It does not prove the platform recorded every call it made;
that rests on recording at the enforcement point and reconciling with the
audit log. Keyed values are not anonymous to whoever holds the tenant key.
