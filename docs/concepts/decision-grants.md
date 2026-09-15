---
title: "Decision Grants"
sidebarTitle: "Decision Grants"
description: "Require a named person's approval, bound to one exact action and made outside the platform's reach, before an agent can decide, file, close or pay."
---

## Why a second credential

A grant lets an agent call tools. Some tools *decide*: approve a customer,
decline an application, delete a monitoring enrolment, release a payout. For
those, "the agent had permission" is not an acceptable answer.

A prompt that says "never approve without a human" is not a control, and
neither is a button in a console that an API call can bypass. A **decision
grant** is a token that only a named, step-up authenticated person can cause
to be minted, bound to one exact action on one case, and usable once. The
platform that runs the agent cannot mint one: it has no API for approving,
for signing an approver in, or for choosing which identity provider approvers
use.

## Declaring that a tool needs a decision

In the tool manifest (schema 0.6):

```json
{
  "connector": "acme_kyb",
  "tools": {
    "monitor_delete": {"permission": "delete", "requires_decision": true},
    "case_decision":  {"permission": "write", "requires_decision": true, "four_eyes_on": ["decline"]},
    "payout_release": {"permission": "write", "requires_decision": true, "decision_fields": ["currency"]}
  }
}
```

`requires_decision` is not allowed on a `read` tool. `four_eyes_on` lists the
decisions that need two approvers. `decision_fields` lists arguments, beyond
the core action, that the decision must also bind.

A grant can also require decisions: a tool listed in the grant token's
`urn:grantex:decision:v1` entry needs a decision grant even when the manifest
does not declare `requires_decision`, and a decision in either `four_eyes_on`
list needs two approvers.

## What a decision grant approves

Not the bytes of a tool call, but its **semantic action**:

```json
{"case_id": "case_8841", "action": "case_decision", "decision": "approve", "subject": "gb:00000001"}
```

plus `amount` when there is one and the declared `decision_fields` (for
example `"extra": {"currency": "GBP"}`). The token carries the action and its
RFC 8785 hash. When the agent calls the tool, the enforcer derives the action
from the call's arguments and compares hashes. The agent may re-plan its
payload, add a timestamp or reorder fields and the decision still holds; it
may not change the case, the decision, the subject, the amount or a declared
field.

Anything else the call means is **not** approved. If a tool's effect depends
on an argument that is not bound, declare it in `decision_fields`.

## Who can approve, and how

1. **The service administrator** allow-lists, per developer, the OpenID
   Connect identity providers whose users may approve. The developer API key
   cannot do this.
2. **The platform** creates a decision request with its API key: the action,
   the connector, the case version, the memo text and the policy score the
   approver must review, and the manifest's `four_eyes_on`. The response
   contains `approvalPage`, a link to the auth service.
3. **The approver** opens that page in their browser and signs in with an
   allow-listed identity provider, with a strong method (for example a
   passkey). The auth service runs the sign-in itself (authorization code with
   PKCE, state and nonce) and checks step-up from `acr` / `amr` and
   `auth_time`. The session lives in an HttpOnly cookie on the auth service
   and lasts for a configured window (one hour by default); no API ever
   returns it.
4. **One click per decision.** The page shows the memo, the policy score and
   the exact action. The approver clicks approve; the auth service measures
   how long the decision was on screen, refuses approvals faster than a
   minimum, and mints the decision grant.
5. **The platform** reads the minted grant with `GET /v1/decisions/requests/{id}`
   and passes it with the tool call. `enforce()` (or an MCP server) verifies it
   and **consumes** it at the auth service; only then does the call proceed.
6. **Everything is in the audit chain**: who configured the identity provider,
   each sign-in, the approval (approver, identity provider, authentication
   method, dwell time, action, memo and policy score hashes), consumption and
   every refusal.

Strong authentication happens once per session and each decision is a
deliberate, recorded click: a passkey prompt for every action produces exactly
the rubber-stamping this feature exists to prevent.

Asking for a four-eyes decline from a platform:

<!-- snippet: packages/sdk-ts/tests/docs/examples/decision-request.ts -->
```ts
import type { Grantex } from '@grantex/sdk';

/** Asks for a four-eyes decline and returns the page to send approvers to. */
export async function requestDecline(
  grantex: Grantex,
  caseId: string,
  caseVersion: string,
  memo: string,
  policyScore: Record<string, unknown>,
): Promise<string> {
  const request = await grantex.decisions.createRequest({
    action: { case_id: caseId, action: 'case_decision', decision: 'decline', subject: 'gb:00000001' },
    connector: 'acme_kyb',
    caseVersion,
    fourEyesOn: ['decline'], // the manifest's four_eyes_on for this tool
    memo: { content: memo }, // shown to the approver and bound into the grant by hash
    policyScore: { content: policyScore },
  });
  // Approvers sign in on this page and approve there; the platform cannot approve.
  return String(request['approvalPage']);
}
```

## The four-eyes model

For a decision listed in `four_eyes_on`, two different people must approve.

- The first approval mints a grant marked `four_eyes: {approvals_required: 2, position: 1}`.
  Presented alone it is refused (`four_eyes_incomplete`).
- The second approval is minted only after the first, by a **different
  approver**, and names the first (`first_jti`, `first_sub`). Approvers are
  identified by identity provider and subject; the auth service also refuses a
  second approver with the same verified email (`same_approver`).
- The call presents both grants. Both are consumed together, or neither is.
- Four eyes is enforced when approving, in offline verification (a grant that
  says two approvals are needed is never accepted alone, whatever the manifest
  says) and when consuming.

Four eyes compares identities. It cannot tell that two accounts without a
shared verified email belong to one person; configure identity providers to
require verified emails where that matters.

## Validity

A decision grant is valid until the first of:

- it is **consumed**: one grant authorises one call;
- the **case changes**: the platform registers a new case version (for example
  a hash of the evidence behind the decision) and unconsumed grants for the old
  version are revoked;
- **24 hours** pass, or its request expires;
- the request is **cancelled**.

Consumption spends the grant even if the response is lost or the tool call
fails afterwards; a person then has to approve again. Make the tool call
idempotent per decision request.

## Enforcing

Python:

<!-- snippet: packages/sdk-py/tests/docs_examples/decision_enforce.py -->
```python
from typing import Any, Dict, List

from grantex import Grantex


def call_case_decision(
    grantex: Grantex,
    grant_token: str,
    decision_grants: List[str],
    tool_call_arguments: Dict[str, Any],
    current_case_version: str,
) -> None:
    """Calls a tool that needs a decision, with the decision grants a person approved."""
    result = grantex.enforce(
        grant_token,
        "acme_kyb",
        "case_decision",
        decision_grants=decision_grants,  # two for a decision listed in four_eyes_on
        arguments=tool_call_arguments,  # the approved action is derived from these
        case_version=current_case_version,  # from your own case state, never from the agent
    )
    if not result.allowed:
        # reason_code is decision_required or decision_invalid; sub_reason says why
        raise PermissionError(f"{result.reason_code}/{result.sub_reason}: {result.reason}")
    # The grants are now spent: result.decision.jtis
```

TypeScript:

<!-- snippet: packages/sdk-ts/tests/docs/examples/decision-enforce.ts -->
```ts
import type { Grantex } from '@grantex/sdk';

/** Calls a tool that needs a decision, with the decision grants a person approved. */
export async function callCaseDecision(
  grantex: Grantex,
  grantToken: string,
  decisionGrants: string[],
  toolCallArguments: Record<string, unknown>,
  currentCaseVersion: string,
): Promise<void> {
  const result = await grantex.enforce({
    grantToken,
    connector: 'acme_kyb',
    tool: 'case_decision',
    decisionGrants, // two for a decision listed in four_eyes_on
    arguments: toolCallArguments, // the approved action is derived from these
    caseVersion: currentCaseVersion, // from your own case state, never from the agent
  });
  if (!result.allowed) {
    // reasonCode is decision_required or decision_invalid; subReason says why
    throw new Error(`${result.reasonCode ?? 'denied'}/${result.subReason ?? ''}: ${result.reason}`);
  }
  // The grants are now spent: result.decision?.jtis
}
```

`wrap_tool` / `wrapTool` and `enforceMiddleware` accept the decision grants
and case version too. MCP servers use `grantexDecisionVerifier` from
`@grantex/mcp-auth` (see [mcp-auth](/mcp-auth)); clients send grants in the
`grantex-decision-grant` header and receive a `decision_required` challenge
without one.

### Refusals

| Result | Sub-reason | Meaning |
|---|---|---|
| `decision_required` | | No decision grant was presented. |
| `decision_invalid` | `action_mismatch` | Approves another action, field value or connector. |
| | `wrong_case` | Approves an action on another case. |
| | `case_changed` | The case changed since the approval. |
| | `expired` | Past its expiry. |
| | `consumed` | Already used. |
| | `same_approver` | Four eyes with one approver, or one grant twice. |
| | `four_eyes_incomplete` | Needs a second approval. |
| | `revoked`, `unknown_grant`, `malformed` | Cancelled, unknown to the issuer, or unreadable. |
| | `consume_unavailable` | The auth service could not confirm consumption. The call is refused. |

### Rolling out: `decisions.required`

`enforce()` denies by default (`decisions_mode="enforce"`). A platform rolling
decision grants out per tenant maps its `decisions.required` flag to the mode:
on means `enforce`; off means `warn`. **`warn` is not a control**: it does not
deny a call to a decision tool that lacks a valid decision grant; it lets the
call through and reports the denial that would have happened in
`result.would_deny`, so you can measure the effect before turning enforcement
on. Valid grants presented in warn mode are still consumed.

## Operating

- The auth service's decision endpoints and pages are off until
  `DECISION_GRANTS_ENABLED=true`. `PUBLIC_BASE_URL` must be https and
  `VAULT_ENCRYPTION_KEY` set. Configure step-up with `DECISION_STEP_UP_AMR` /
  `DECISION_STEP_UP_ACR` and `DECISION_STEP_UP_MAX_AGE_SECONDS`, and the
  minimum dwell time with `DECISION_MIN_DWELL_MS`.
- Register `https://<auth service>/decisions/callback` as the redirect URI of
  each approver identity provider.
- Metrics: `grantex_decision_grants_minted_total`,
  `grantex_decision_grants_consumed_total`,
  `grantex_decision_grants_rejected_total{stage,reason}` and the
  `grantex_decision_dwell_seconds` histogram. Alert when dwell time collapses
  towards the minimum.

## What this does and does not protect against

Decision grants stop the platform, an agent, a prompt injection or a
re-planned payload from producing or using an approval nobody gave; stop
replay (used, other case, changed case, expired, other tenant); stop an
approval being submitted from another site or with a forged dwell time; bind
what the approver was shown; and stop one identity from satisfying four eyes.

They do not protect against a compromised service administrator or identity
provider, one person holding two identities without a shared verified email,
misleading memo content written by the platform, rubber-stamping (made visible,
not impossible), script injection on the auth service's own origin, arguments
the manifest leaves out of `decision_fields`, tools that act without calling
`enforce()`, or a compromised auth service. When the auth service is
unreachable, decisions cannot be consumed and calls are refused.

The full profile, including every claim and the threat model, is the
[decision grant specification](https://github.com/mishrasanjeev/grantex/blob/main/spec/decision-grant.md).
