---
title: "Decision Grants"
sidebarTitle: "Decision Grants"
description: "Require a named person's cryptographic approval, bound to one exact action, before an agent can decide, file, close or pay."
---

## Why a second credential

A grant lets an agent call tools. Some tools *decide*: approve a customer,
decline an application, delete a monitoring enrolment, release a payout. For
those, "the agent had permission" is not an acceptable answer. The PRD's rule
is that no agent ever approves, declines, closes or files anything.

A prompt that says "never approve without a human" is not a control, and
neither is a button in a console that an API call can bypass. A **decision
grant** makes the human decision a precondition the tool call cannot
proceed without: a token only a named, step-up authenticated person can mint,
bound to one exact action on one case, usable once.

## Declaring that a tool needs a decision

In the tool manifest (schema 0.6):

```json
{
  "connector": "acme_kyb",
  "tools": {
    "monitor_delete": {"permission": "delete", "requires_decision": true},
    "case_decision":  {"permission": "write", "requires_decision": true, "four_eyes_on": ["decline"]}
  }
}
```

`requires_decision` is not allowed on a `read` tool. `four_eyes_on` lists the
decisions that need two approvers.

## What a decision grant approves

Not the bytes of a tool call, but its **semantic action**:

```json
{"case_id": "case_8841", "action": "case_decision", "decision": "approve", "subject": "gb:00000001"}
```

plus an optional `amount`. The token carries the action and its RFC 8785
hash. When the agent later calls `case_decision`, the enforcer derives the
action from the call's arguments and compares hashes. The agent may re-plan
its payload, add a timestamp or reorder fields; the decision still holds. It
may not change the case, the decision, the subject or the amount; any of those
is `action_mismatch` or `wrong_case`.

## The flow

1. **The workflow reaches a decision.** The platform creates a decision
   request with the action, the connector, the case version, and references to
   the memo and policy score. For a decision listed in `four_eyes_on` it passes
   `fourEyesOn`, so the request needs two approvals.
2. **The approver steps up once.** They sign in through the organisation's
   OIDC identity provider with a strong method (for example a passkey). The
   platform exchanges that ID token for an approver session. Step-up is
   checked from `acr` / `amr` and `auth_time`, and lasts for a configured
   window (one hour by default).
3. **One click per decision.** The approval screen shows the memo, the policy
   score and the exact action. The approver clicks approve; the platform sends
   the action hash it displayed and the dwell time (render to click). The auth
   service refuses if the hash is not the request's, so what was shown is what
   gets signed, and mints the decision grant.
4. **The call carries the grant.** The agent's tool call goes through
   `enforce()` (or an MCP server) with the decision grant. It is verified
   offline and then **consumed** at the auth service. Only then does the call
   proceed.
5. **Everything is in the audit chain.** Approver identity, identity provider,
   authentication method, dwell time, the semantic action and its hash, and the
   consumption.

Tiered friction is deliberate: a passkey prompt for every action produces
exactly the rubber-stamping this feature exists to prevent, so strong
authentication happens once per session and each decision is a deliberate,
recorded click.

## The four-eyes model

For a decision listed in `four_eyes_on`, two different people must approve.

- The first approval mints a grant marked `four_eyes: {approvals_required: 2, position: 1}`.
  On its own it is not enough: presenting it alone is `four_eyes_incomplete`.
- The second approval is minted only after the first, by a **different
  approver**, and names the first (`first_jti`, `first_sub`). The same
  identity approving twice is refused (`same_approver`), and the auth service
  also refuses the same email under another identity.
- The call presents both grants. Both are consumed together, or neither is.
- Four eyes is enforced three times: when minting, in offline verification (a
  grant that says two approvals are needed is never accepted alone, whatever
  the manifest says), and when consuming.

Four eyes compares identities at the identity provider. It cannot tell that
two accounts belong to one person; keep one approver identity per person.

## Validity

A decision grant is valid until the first of:

- it is **consumed** (single use);
- the **case changes**: the platform registers a new case version, for
  example a hash of the evidence behind the decision, and unconsumed grants
  for the old version are revoked;
- **24 hours** pass (absolute ceiling);
- the request is **cancelled**.

Binding to the case rather than a short timer means a decision survives slow,
asynchronous provider calls, and dies as soon as the facts it was based on
change.

## Enforcing

Python:

```python
from grantex import Grantex, ToolManifest

grantex = Grantex(api_key=API_KEY)
grantex.load_manifest(ToolManifest.from_file("acme_kyb.json"))

result = grantex.enforce(
    grant_token,
    "acme_kyb",
    "case_decision",
    decision_grants=[decision_grant],      # two for a four-eyes decision
    arguments=tool_call_arguments,         # the action is derived from these
    case_version=current_case_version,     # from your case state, not from the agent
)
if not result.allowed:
    # result.reason_code: "decision_required" or "decision_invalid"
    # result.sub_reason: e.g. "action_mismatch", "consumed", "case_changed"
    raise PermissionError(result.reason)
```

TypeScript:

```ts
const result = await grantex.enforce({
  grantToken,
  connector: 'acme_kyb',
  tool: 'case_decision',
  decisionGrants: [decisionGrant],
  arguments: toolCallArguments,
  caseVersion: currentCaseVersion,
});
```

MCP servers use `grantexDecisionVerifier` from `@grantex/mcp-auth`
(see [mcp-auth](/mcp-auth)); clients send the grant in the
`grantex-decision-grant` header and receive a `decision_required` challenge
without one.

### Refusals

| Result | Sub-reason | Meaning |
|---|---|---|
| `decision_required` | | No decision grant was presented. |
| `decision_invalid` | `action_mismatch` | Approves another action or connector. |
| | `wrong_case` | Approves an action on another case. |
| | `case_changed` | The case changed since the approval. |
| | `expired` | Past its expiry. |
| | `consumed` | Already used. |
| | `same_approver` | Four eyes with one approver, or one grant twice. |
| | `four_eyes_incomplete` | Needs a second approval. |
| | `revoked`, `unknown_grant`, `malformed` | Cancelled, unknown to the issuer, or unreadable. |
| | `consume_unavailable` | The auth service could not confirm consumption. The call is refused. |

### Rolling out: `decisions.required`

`enforce()` fails closed by default (`decisions_mode="enforce"`). A platform
that rolls decision grants out per tenant maps its `decisions.required` flag
to the mode: on means `enforce`; off means `warn`, where the call is allowed,
valid grants are still consumed, and the denial that would have happened is
reported in `result.would_deny` for logging and metrics. There is no mode that
skips the check silently.

## Operating

- Enable the endpoints on the auth service with `DECISION_GRANTS_ENABLED=true`
  and configure step-up with `DECISION_STEP_UP_AMR` / `DECISION_STEP_UP_ACR`
  and `DECISION_STEP_UP_MAX_AGE_SECONDS`.
- Metrics: `grantex_decision_grants_minted_total`,
  `grantex_decision_grants_consumed_total`,
  `grantex_decision_grants_rejected_total{stage,reason}` and the
  `grantex_decision_dwell_seconds` histogram. Alert when dwell time collapses
  towards zero.
- The auth service's approval page (`/decisions/{id}`) is intentionally
  minimal; an approvals console is the main surface.

## What this does and does not protect against

Decision grants stop an agent, a prompt injection or a re-planned payload from
performing a decision nobody approved; stop replay of a decision (used, other
case, changed case, expired, other tenant); stop an approval surface from
signing an action other than the one it showed; and stop one identity from
satisfying four eyes.

They do not protect against a compromised platform showing a real approver a
misleading action, a compromised identity provider or approver account, one
person holding two identities, rubber-stamping (dwell time makes it visible,
not impossible), tools that perform actions without calling `enforce()`, or a
compromised auth service. When the auth service is unreachable, decisions
cannot be consumed and calls are refused.

The full profile, including the token claims, is the
[decision grant specification](https://github.com/mishrasanjeev/grantex/blob/main/spec/decision-grant.md).
