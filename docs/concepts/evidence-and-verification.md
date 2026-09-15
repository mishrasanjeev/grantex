---
title: "Evidence and Verification"
sidebarTitle: "Evidence and Verification"
description: "A per-case evidence package - grants, tool calls, upstream records, policy scores, human decisions - in a hash chain an auditor can verify without trusting the system that produced it."
---

## Why a package

An agent that works a regulated case - onboarding a business, dispositioning
a screening hit - leaves its trail across several systems: the grant that
authorised it, the provider calls it made, the policy that scored the result,
the person who approved the decision. An auditor asking "why was this
business referred, and who approved the decline?" should not have to query
all of them, and should not have to trust any of them.

An **evidence package** is one JSON document per case that answers those
questions on its own:

| The auditor asks | The package holds |
|---|---|
| Under what authority did the agent act? | The grant chain, root to leaf, with purpose, tools and caps. |
| What did it look at? | Every tool call: provider, tool, hashes of input and output, and the identifiers of each upstream record returned. |
| What was it running? | Model, prompt, policy and schema versions. |
| Why this recommendation? | The policy score, tier and fired rules, each input with the records it came from, and the records each memo section cites. |
| Who decided, and how carefully? | Every decision: approver, authentication method, dwell time and the exact semantic action (decision grant `jti` and `action_hash`). |
| Was anything stopped? | Revocations. |
| Was any of it edited? | A hash chain whose root was recorded in the auth service audit chain when the package was exported. |

The format is specified in `spec/evidence-package.md`, with a JSON Schema in
`spec/evidence-package-1.0.schema.json`.

## How tamper evidence works

Three layers, each closing a gap in the one before:

1. **Canonical bytes.** A package is only valid as its own RFC 8785 canonical
   JSON. There is exactly one way to write a given package, so every byte
   matters: an extra space, a reordered member or `1.0` instead of `1` fails.
2. **A hash chain.** Each entry carries the hash of the entry before it and a
   hash of itself. Change an entry and verification names that entry and shows
   the expected and actual hash. Recompute that entry's hash too and the next
   entry's link breaks.
3. **A root held elsewhere.** The chain ends in a root that covers the whole
   package. When the auth service exports a package it writes the root into the
   tenant's audit hash chain - the same chain behind `GET /v1/audit/entries`
   and signed audit checkpoints - and embeds that audit entry in the package as
   its **anchor**. A forger who recomputes every hash produces a different
   root, and the auditor's copy of the root does not match.

Optionally the package is **signed**: a detached ES256 or RS256 JWS over the
root, verifiable against the auth service JWKS without contacting it.

## Privacy by default

Packages carry no raw personal data beyond what the case owner chose. Three
identifier classes can point at people - the grant `principal`, the decision
`approver` and the case `subject` - and each is replaced by a **pseudonym**
unless disclosed. Pseudonyms are keyed HMACs, stable within a case (the
auditor can still see that two approvers were different people) and different
across cases (packages cannot be joined on them). Tool inputs and outputs, the
memo and free-text reasons appear only as hashes.

To disclose a class, list it: `"disclose": ["approver"]` on export, or
`disclosed` in the SDK builders. Disclosing `subject` also lets any verifier
recompute each decision's `action_hash`.

## Verifying a package

Get the root from somewhere other than the package - the tenant audit log
(`GET /v1/audit/entries?action=evidence.package_exported`), a signed audit
checkpoint, or the `Grantex-Evidence-Root` header recorded at export - then:

```bash
grantex evidence verify package.json --root sha256:e2f5dbf9add538342f753afe20c9ee4b90b63e8a6eb78740d95590022680765c
```

It exits 0 and prints `verified` only if every check passes. Otherwise it
prints the failing link and exits 1, for example:

```text
FAILED entry_hash_mismatch: entry 10 content does not match its hash
  entry:    10
  field:    entries[10].hash
  expected: sha256:9a3fbf81…
  actual:   sha256:1017aa91…
```

Pin the anchor with `--anchor <audit-entry-hash>` and check a signature with
`--jwks jwks.json`. A signed package without `--jwks` fails with
`signature_unverified` unless you pass `--skip-signature`.

In code:

```python
from pathlib import Path

from grantex.evidence import upstream_records_for, verify_package

data = Path("spec/examples/evidence/evidence-package.json").read_bytes()
root = "sha256:e2f5dbf9add538342f753afe20c9ee4b90b63e8a6eb78740d95590022680765c"

result = verify_package(data, expected_root=root, require_anchor=True)
assert result.ok, (result.code, result.field_path, result.expected, result.actual)

# Every upstream record behind the recommendation, from the package alone.
import json

for record in upstream_records_for(json.loads(data), "rec_0001"):
    print(record["provider"], record["tool"], record["record_id"], record["retrieved_at"])
```

```typescript
import { readFileSync } from 'node:fs';
import { evidence } from '@grantex/sdk';

const data = readFileSync('spec/examples/evidence/evidence-package.json');
const result = evidence.verifyPackage(data, {
  expectedRoot: 'sha256:e2f5dbf9add538342f753afe20c9ee4b90b63e8a6eb78740d95590022680765c',
  requireAnchor: true,
});
if (!result.ok) throw new Error(`${result.code} at ${result.fieldPath}`);
```

The Python and TypeScript verifiers apply the same checks in the same order
and report identical results for every shared test case.

## Producing evidence

A platform records evidence as the case runs - run context, each tool call
with the upstream record identifiers, policy evaluations, recommendations -
with `POST /v1/evidence/cases/{caseId}/records`. Decision grants minted by the
auth service are included automatically. When the case is decided,
`POST /v1/evidence/cases/{caseId}/export` returns the package. Both are behind
the `EVIDENCE_EXPORT_ENABLED` flag, off by default.

## What it does not prove

The package proves that its contents are unchanged since export and that the
root was recorded in the audit chain at that time. It does not prove the
platform recorded every call it made; that rests on recording evidence at the
enforcement point (the tool gateway) and on reconciling the package with the
audit log. It does not make pseudonyms anonymous to whoever holds the tenant
key.
