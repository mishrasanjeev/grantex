---
title: "Migrating to Grantex 0.6"
description: "Every change from Grantex 0.5 to 0.6 that can break an integration — manifests, purpose-bound grants, caps, ES256 signing and standard token claims — and what to do about each."
---

# Migrating from 0.5 to 0.6

Grantex 0.6 adds purpose-bound grants, spend caps, ES256 signing and an OAuth
profile for grant tokens. Most of it is additive: an integration that does not
use the new features keeps working. This guide lists **every** change that
can alter the behaviour of an existing deployment, SDK integration or
resource server, grouped by feature. The [CHANGELOG](../CHANGELOG.md) has the
full list of additions.

**No step in this guide invalidates an outstanding token.** Upgrading keeps
every token issued before 0.6 verifying, in the auth service and in the SDK
verifiers, and every key change below publishes the new key before it signs
and keeps the old key published until the tokens it signed have expired.

Package version numbers are set when the release is cut. "0.5" and "0.6" here
mean the Grantex protocol, auth service and SDK behaviour before and after these
changes.

## At a glance

| Area | Change | Who must act |
|---|---|---|
| Manifests | Object-form tool declarations are validated strictly | Anyone adopting object-form tools |
| Manifests | Duplicate keys in manifest files are rejected | Anyone with a hand-edited manifest file |
| Manifests | `cost_units` is a reserved tool name | Manifests with a tool named `cost_units` |
| `enforce()` | Declarations it cannot satisfy deny (purpose, decision, caps) | Anyone adopting 0.6 declarations |
| `enforce()` | Malformed `authorization_details` denies every call | Clients that push custom `authorization_details` |
| Authorization | `purpose` is validated (`INVALID_PURPOSE`) | Callers that send `purpose` |
| Caps | Tools and grants with caps need a caps meter | Anyone adopting caps |
| Caps | Grant caps with wildcard or unknown keys deny | Issuers of custom caps |
| Signing | Signing keys are validated at start | Deployments with a weak or malformed key |
| Signing | Key ids are thumbprints; the RSA key is also published under its old `grantex-YYYY-MM` kids | Resource servers that pin a `kid` or cache the JWK Set by size |
| Signing | Verifiers select keys by exact `kid` and key type | Custom JWK Sets with mislabelled keys |
| Signing | Tokens may be ES256 | Resource servers that pin RS256 |
| Signing | Env keys are imported when switching to the postgres key store | Operators adopting `SIGNING_KEY_STORE=postgres` |
| Claims | Standard claims added; legacy aliases flagged | Resource servers that read `agt`, `dev`, `grnt`, `scp` |
| Claims | Delegated `act` claims are nested | Code that reads `act` on delegated tokens |
| Claims | Disagreeing claims and aliases are refused on 0.6 tokens | Custom token issuers |
| Claims | Null or mistyped claims are refused by the SDK verifiers | Custom token issuers |
| Claims | New scopes cannot contain whitespace; existing such grants lose `scope` in their tokens | Grants with such scopes, standard-only readers |
| TypeScript | `GrantTokenPayload.agt` / `dev` / `scp` are optional | TypeScript code that reads the raw payload type |
| Database | Migrations `095`, `096`, `098` | Self-hosted auth service (applied automatically) |

## Upgrade order

1. **Upgrade verifiers first.** Update the SDKs (or your own verifier) on every
   resource server so it accepts RS256 **and** ES256 and reads the standard
   claims. 0.6 SDKs read both claim forms.
2. **Upgrade the auth service.** Migrations apply on start. Defaults keep RS256
   signing and keep issuing the legacy claim aliases, so 0.5 verifiers keep
   working.
3. **Adopt the new features** (purposes, object-form manifests, caps) one at a
   time. Each denies calls it cannot evaluate.
4. **Before 0.7**, move every resource server to the standard claims (0.6
   SDKs already read them). Then set `GRANT_TOKEN_LEGACY_CLAIMS=false` (the 0.7
   default). This changes only tokens issued from then on; tokens already
   issued keep their aliases until they expire. Switch to ES256, if you want
   it, only after step 1 is complete everywhere, following the rotation steps
   below.

---

## Tool manifest schema 0.6

Reference: [`spec/manifest-0.6.md`](../spec/manifest-0.6.md) and
[`spec/manifest-0.6.schema.json`](../spec/manifest-0.6.schema.json).

**Unchanged:** a manifest whose tools are all permission strings
(`"get_case": "read"`) loads and enforces exactly as in 0.5.

**Strict validation of object-form manifests.** A manifest that declares
`$schema` or uses the object form for any tool is validated against the 0.6
schema. Loading raises `ManifestValidationError` (a `ValueError` in Python)
for:

- an unknown key at any level;
- `requires_decision: true` on a `read` tool;
- `four_eyes_on` without `requires_decision`;
- empty `caps`, `cost_units`, `allowed_purposes` or `four_eyes_on`;
- a malformed purpose pattern, cap, unit or decision name.

*Action:* validate new manifests against the schema in CI before deploying
them.

**Strings-only manifests with unknown top-level keys** still load, with a
deprecation warning. A future minor release will reject them. *Action:*
remove the extra keys.

**Behaviour change — duplicate keys.** `from_file` / `fromFile` and
`load_manifests_from_dir` / `loadManifestsFromDir` reject a JSON or YAML
manifest that repeats a key inside one object (`duplicate key "<key>" in
manifest file`). 0.5 silently kept the last value, which could drop a
`requires_decision`. *Action:* load your manifest files once with the 0.6 SDK
and fix any duplicate it reports.

**Behaviour change — reserved tool name.** `cost_units` can no longer be a
tool name, in either manifest form, because grant caps use it for the
cost-unit budget. *Action:* rename such a tool and the scopes and tools lists
that name it.

**`enforce()` fails closed on declarations.** In 0.6:

- A tool that declares `allowed_purposes` is denied (`purpose_not_allowed`)
  unless the grant carries a matching purpose.
- A tool with `requires_decision` always returns `decision_required`, because
  decision grants are not accepted yet.
- A tool with `caps` or `cost_units` is denied with `cap_exceeded` /
  `meter_unavailable` unless the client has a caps meter.

Adding one of these declarations to an existing tool therefore changes what
`enforce()` allows. *Action:* add declarations only together with the grants,
decision flow or meter that satisfy them.

**Additive:** denied results carry `reason_code` / `reasonCode`, `sub_reason`
/ `subReason` and `details`. `reason` is unchanged.

## Purpose-bound grants

Reference: [Purpose-bound grants](concepts/purpose-bound-grants.md).

**Unchanged:** requests without `purpose` issue the same grants as before, and
tools without `allowed_purposes` ignore purpose entirely.

**`purpose` is validated.** `POST /v1/authorize` (and `AuthorizeParams.purpose`
in the SDKs) rejects with `400 INVALID_PURPOSE`:

- a purpose outside the vocabulary (`aml.cdd.onboarding`, `aml.cdd.ongoing`,
  `aml.screening`, `procurement.vendor_onboarding`, `payments.payout`) that is
  not a private `x-<org>.<term>`;
- a purpose sent without any `tool:<connector>:<permission>` scope.

*Action:* send vocabulary terms or register a private namespace.

**Tokens carry `authorization_details`.** A purpose-bound grant's tokens carry
one `urn:grantex:tools:v1` entry per connector. The purpose is kept on refresh
and inherited by delegated grants.

**Behaviour change — malformed `authorization_details` denies every call.**
`enforce()` denies every call on a token whose `authorization_details` it
cannot read unambiguously (`token_invalid` / `malformed_authorization_details`):

- a claim that is not an array;
- an entry without a string `type`;
- a tools entry with an unknown key or a wrong type;
- two entries for one connector.

0.5 ignored the claim. The OAuth agent-grants flow copies client-pushed
entries into tokens unchecked (FINDINGS G-4). *Action:* make sure clients that
push `authorization_details` send well-formed entries.

**Behaviour change — the tools list is enforced.** When a tools entry has
`tools`, a tool not listed is denied (`tool_not_granted` /
`not_in_authorization_details`), even if a scope covers it.

**Database:** migration `095_purpose_bound_grants.sql` adds nullable `purpose`
columns to `auth_requests`, `grants` and `audit_entries`.

## Spend caps

Reference: [Caps and metering](concepts/caps-and-metering.md).

**Unchanged:** tools and grants without `caps` or `cost_units` are not metered.

**Caps need a meter.** A call to a tool or grant that declares caps is denied
with `cap_exceeded` / `meter_unavailable` when the client has no meter, or its
backend is unreachable. *Action:* configure `Grantex(caps_meter=...)` /
`new Grantex({ capsMeter })` with the Redis or Postgres backend before
declaring caps.

- **Redis** needs 6.0 or later and `maxmemory-policy noeviction`.
- **Postgres** needs the tables from `SCHEMA_SQL` / `CAPS_SCHEMA_SQL` or
  `ensure_schema()` / `ensureSchema()`, and a periodic `prune()`.
- There is no automatic failover between backends.

**Behaviour change — grant caps are validated.** Caps in a grant's tools entry
must be keyed by an exact tool name or `cost_units`. Any of the following
denies every call on the connector (`token_invalid` /
`malformed_authorization_details`) instead of being ignored:

- a wildcard key such as `screen_*`;
- an unknown window;
- a count outside 0–2147483647.

**Semantics to know:**

- A cap of `0` disables a tool.
- A per-case cap needs `case_id` / `caseId` (`case_required`).
- Units are reserved as the last check and are **not** refunded when the
  provider call fails. Use `refund_unsent()` / `refundUnsent()` only when the
  call was never sent.
- A tool with `cost_units` but no budget on the grant is allowed when a meter
  is configured.

For a gradual rollout, use `caps_mode="warn"` / `capsMode: 'warn'` to report
`would_deny` / `wouldDeny` without denying.

## ES256 signing

Reference: [`SPEC.md`](../SPEC.md) §6.1 and §14, and
[self-hosting Section 7](self-hosting.md).

**Unchanged:** `JWT_SIGNING_ALG` defaults to `RS256`, and the same
`RSA_PRIVATE_KEY` keeps signing.

**Behaviour change — key ids and the `kid` strictness they required.** A 0.5
auth service published its RSA key under `grantex-YYYY-MM`, the month the
process started, and verified its own tokens without looking at `kid`. 0.6
verifies by `kid` and key type everywhere, which on its own would have broken
tokens across a month boundary or across instances started in different
months. 0.6 therefore:

- names each key by its RFC 7638 thumbprint (`grantex-rs256-…`,
  `grantex-es256-…`), the same on every instance;
- verifies an RS256 token whose `kid` is any `grantex-YYYY-MM`, or that has no
  `kid`, with the *legacy key* — `RSA_PRIVATE_KEY`, or the key named by
  `JWT_LEGACY_KID_KEY`;
- also publishes the legacy key under `grantex-YYYY-MM` for the current month
  and the previous `JWT_LEGACY_KID_MONTHS - 1` months (default 13 in total),
  so SDK verifiers that select keys by `kid` find it;
- keeps signing under the legacy `kid` for
  `SIGNING_KEY_ACTIVATION_DELAY_SECONDS` (default 900) after start, so
  resource servers holding a JWK Set fetched from a 0.5 instance keep
  accepting new tokens until they refresh it.

The JWK Set is therefore larger (one entry per alias). *Action:* none for most
deployments. Raise `JWT_LEGACY_KID_MONTHS` if you issued grants that live longer
than a year before upgrading. Do not remove the RSA key while pre-0.6 tokens are
valid, and set `JWT_LEGACY_KID_KEY` to its thumbprint `kid` if it stops being
`RSA_PRIVATE_KEY`. There is deliberately no setting to rename a key's `kid`:
changing a published `kid` would invalidate the tokens signed under it.

**Resource servers must accept ES256 before an issuer switches.** A deployment
may now set `JWT_SIGNING_ALG=ES256`. It then signs grant tokens, OAuth access
tokens, verifiable credentials, SD-JWTs, agent passports, principal sessions
and wallet authorizations with an EC P-256 key.

The 0.6 SDK verifiers accept both algorithms. A verifier that pins RS256 —
your own code, or the Grantex CLI, gemma, mpp and conformance packages
(FINDINGS G-8) — rejects those tokens. *Action:* allow exactly
`['RS256', 'ES256']`, and select the JWK Set key by `kid`.

**Behaviour change — SDK verifiers match key type to algorithm.** Python,
TypeScript and Go verifiers reject:

- an RS256 token whose `kid` names an EC key, and the reverse;
- a key published with a different `alg`;
- a key whose `use` is not `sig`;
- an ES256 key not on P-256;
- `alg: none` and HS256 (as before).

A JWK Set with mislabelled keys, which 0.5 might have accepted for RS256, is
now refused. *Action:* publish keys with correct `kty`, `crv`, `alg` and `use`.
The new `algorithms` / `Algorithms` option can narrow the list, never widen it.

**Behaviour change — signing keys are validated at start.** The auth service
refuses to start with:

- an RSA key shorter than 2048 bits;
- an `EC_PRIVATE_KEY` that is not P-256;
- a key in the wrong setting (for example an RSA key in `EC_PRIVATE_KEY`);
- a `JWT_VERIFICATION_PUBLIC_KEYS` entry with private members, an unsupported
  `alg`, a legacy `grantex-YYYY-MM` kid, or a `kid` used by a different key;
- a `JWT_LEGACY_KID_KEY` that names no configured RSA key;
- with the postgres key store, a `SIGNING_KEY_RETIRED_GRACE_SECONDS` shorter
  than `MAX_GRANT_LIFETIME_SECONDS` (a warning when the latter is unset).

In production it also refuses to start when SSO state has no persistent key:
`SSO_STATE_SECRET` is unset and there is no `RSA_PRIVATE_KEY`, `EC_PRIVATE_KEY`
or `VAULT_ENCRYPTION_KEY` to derive one from. Deployments with
`RSA_PRIVATE_KEY` derive the same key as in 0.5.

`RSA_PRIVATE_KEY` must be PKCS#8 (`-----BEGIN PRIVATE KEY-----`), as before.

**Rotating keys without invalidating tokens** (details in
[self-hosting Section 7](self-hosting.md)):

- **Env key store.**
  1. Publish the new public key in `JWT_VERIFICATION_PUBLIC_KEYS`, or set the
     other algorithm's private key setting, and wait at least
     `SIGNING_KEY_ACTIVATION_DELAY_SECONDS`.
  2. Switch the private key, keeping the old public key in
     `JWT_VERIFICATION_PUBLIC_KEYS` (and `JWT_LEGACY_KID_KEY` for the old RSA
     key).
  3. Remove the old key only after its tokens have expired.

  The same key listed twice is one key, so an RSA-to-RSA rotation in one month
  raises no duplicate `kid`.
- **Postgres key store.** `node dist/cli/rotate-signing-key.js [--alg ES256]`
  publishes a pending key that signs only after
  `SIGNING_KEY_ACTIVATION_DELAY_SECONDS`. The previous key is then retired,
  its private key erased, and it stays published for
  `SIGNING_KEY_RETIRED_GRACE_SECONDS`. The legacy key stays published for the
  alias window.

**Switching from the env store to the postgres store** (migration
`096_platform_signing_keys.sql`). Set `SIGNING_KEY_STORE=postgres` and keep the
key settings for the first start:

- The env signing key becomes the stored active key, with the same `kid`.
- The other env keys are stored as retired public keys.
- The RSA key keeps its legacy kid marker.

Nothing changes for verifiers. Remove the private key settings once the table
holds the keys. Stored private keys are encrypted with `VAULT_ENCRYPTION_KEY`
and bound to their `kid`. Erasing a retired key does not remove copies in dead
tuples, WAL, replicas or backups; see self-hosting Section 7.

The DID document lists every platform signing key.

## Standard grant token claims

Reference: [`spec/grant-token-0.6.md`](../spec/grant-token-0.6.md) and
[`SPEC.md`](../SPEC.md) §6.

Grant tokens now validate with a stock OAuth or JOSE library using only
standard semantics. Each 0.5 claim maps to a standard claim:

| 0.5 claim | 0.6 standard claim |
|---|---|
| `agt` | `urn:grantex:grant.agent_did` |
| `dev` | `urn:grantex:grant.developer_id` |
| `grnt` | `urn:grantex:grant.grant_id` |
| `scp` (array) | `scope` (space-delimited string) |
| `parentAgt` | `act.sub` |
| `parentGrnt` | `urn:grantex:grant.parent_grant_id` |
| `delegationDepth` | `urn:grantex:grant.delegation_depth` |
| `bdg` | `authorization_details` entry `urn:grantex:params:oauth:authorization-details:budget` |
| — | `client_id`, `cnf.jkt`, `act`, `authorization_details` |

**The compatibility flag.**

- **0.6:** `GRANT_TOKEN_LEGACY_CLAIMS` defaults to `true`. The auth service
  issues the 0.5 aliases next to the standard claims, with identical values,
  so a 0.5 verifier keeps working.
- **0.7:** the default becomes `false`, and tokens carry only the standard
  claims.
- A later release removes the flag.

The SDK verifiers have a matching option that defaults to reading aliases in
0.6 and stops in 0.7:

| SDK | Option | Deprecation warning |
|---|---|---|
| Python | `VerifyGrantTokenOptions(legacy_claims=True)`, `Grantex(legacy_claims=...)` | `LegacyClaimsWarning` (a `FutureWarning`) |
| TypeScript | `verifyGrantToken(token, { legacyClaims: true })`, `new Grantex({ legacyClaims })` | `DeprecationWarning`, code `GRANTEX_LEGACY_CLAIM`, once per alias |
| Go | `VerifyOptions{StandardClaimsOnly: false}` | `OnLegacyClaim`, or a log line once per alias |

The verifiers read the standard claim first and fall back to an alias only
when the token lacks the standard claim — in practice, tokens issued by a 0.5
auth service. They warn for each alias used and list the aliases in
`legacy_claims_used` / `legacyClaimsUsed` / `LegacyClaimsUsed`. With the
option off, aliases are ignored and `typ` must be `at+jwt`.

*Action for resource servers using the SDKs:*

1. Upgrade.
2. Watch for the deprecation warning. It means a token came from an issuer
   that is not yet on 0.6.
3. Set `legacy_claims=False` / `legacyClaims: false` /
   `StandardClaimsOnly: true` only when no warning has appeared for longer than
   your longest grant lifetime (so no pre-0.6 token can still be presented),
   and no grant with a whitespace scope remains (below). Until then keep the
   default: it accepts both forms.

*Action for resource servers with their own verifier:* read the standard
claims. With `jose`:

```ts
const { payload } = await jwtVerify(token, jwks, {
  issuer, audience, algorithms: ['RS256', 'ES256'], typ: 'at+jwt',
  requiredClaims: ['iss', 'sub', 'aud', 'exp', 'iat', 'jti', 'client_id', 'scope'],
});
const scopes = (payload.scope as string).split(' ');
const grant = payload['urn:grantex:grant'] as { grant_id: string; agent_did: string };
```

With PyJWT:

```python
if jwt.get_unverified_header(token).get("typ") != "at+jwt":
    raise jwt.InvalidTokenError("typ must be at+jwt")
payload = jwt.decode(token, key, algorithms=["RS256", "ES256"], issuer=issuer, audience=audience,
                     options={"require": ["iss", "sub", "aud", "exp", "iat", "jti"]})
scopes = payload["scope"].split(" ")
grant_id = payload["urn:grantex:grant"]["grant_id"]
```

These mirror `packages/sdk-ts/tests/standard-claims.test.ts` and
`packages/sdk-py/tests/test_standard_claims.py`, which validate tokens issued by
the auth service (`spec/examples/grant-token-0.6.issued.json`). A custom
verifier that must accept pre-0.6 tokens during the transition reads `scp`
when the token has no `urn:grantex:grant`. Integrations in this repository
that still read the aliases directly are listed in FINDINGS G-12.

*Action for operators:* keep the default. Setting
`GRANT_TOKEN_LEGACY_CLAIMS=false` affects only tokens issued afterwards; tokens
already issued keep their aliases until they expire, and 0.6 verifiers read
both forms. Set it only once every resource server reads the standard claims,
because a verifier that reads only the aliases cannot use the new tokens. The
auth service logs a deprecation notice at start while it is `true`.

**Proof of possession.** `cnf.jkt` is carried as before, and the SDK verifiers
return it without enforcing it. To enforce it, verify the DPoP proof yourself
and pass its key thumbprint as `proof_jkt` / `proofJkt` / `ProofJKT`; add
`require_proof_of_possession` / `requireProofOfPossession` /
`RequireProofOfPossession` to fail closed when none is passed.

**Behaviour change — nested `act` on delegation.** A delegated token's `act`
now nests the parent token's `act` (RFC 8693). A second-level delegation
carries `{"sub": <parent agent>, "act": {"sub": <grandparent agent>}}`, where
0.5 carried only the parent. The chain is stored on the grant (migration
`098_grant_actor_chain.sql`), so refreshed tokens keep it. Grants delegated
before the migration refresh with the parent agent only, as before. `act.sub`
is the delegating agent, not the current actor as in the usual RFC 8693
reading; the current actor is `client_id`. *Action:* read `act.sub` for the
delegating agent; walk nested `act` for earlier ones.

**Behaviour change — disagreeing claims are refused.** The auth service
(`invalid_claims`) and the SDK verifiers refuse a 0.6 token (one with
`urn:grantex:grant`) where:

- a standard claim and its alias disagree, for example `scope` and `scp`;
- `act` has no string `sub` or is nested more than 10 deep;
- `urn:grantex:grant` is not an object.

Tokens issued by the auth service never disagree. A token issued before 0.6
has no `urn:grantex:grant`; its `scope` was a join of `scp` that is lossy for
scopes containing whitespace, so its `scp` is read and the two are not
compared. Outstanding pre-0.6 tokens therefore keep verifying.

**Behaviour change — null and mistyped claims.** The SDK verifiers refuse a
token where any of these is present with a `null` value, where 0.5 treated
null as absent:

- `urn:grantex:grant` or any of its members;
- `scope`, `scp`, `act`, `cnf`, `client_id`, `aud` or `authorization_details`;
- a legacy alias.

They also refuse a `client_id` that is not a non-empty string, an `aud` that is
not a string or an array of strings, and an `authorization_details` that is not
an array. Tokens issued by the auth service never contain such values.

**Behaviour change — whitespace in scopes.**

- **New grants.** `POST /v1/authorize` refuses a scope containing whitespace
  with `400 INVALID_SCOPE`. *Action:* use scope names without spaces.
- **Existing grants.** Grants created earlier with such a scope keep working:
  token exchange, refresh and delegation still issue tokens, and outstanding
  tokens verify. Because `scope` is space-delimited and cannot hold such a
  scope, these tokens omit `scope` and always carry `scp`, whatever
  `GRANT_TOKEN_LEGACY_CLAIMS` says. A verifier reading standard claims only
  (`legacy_claims=False`, and the 0.7 default) refuses them rather than read a
  different scope set. *Action:* re-issue such grants with space-free scopes
  before switching verifiers to standard-only.
- **Other entry points.** Agent registration and consent bundles still accept
  such scopes (FINDINGS G-11).

**Behaviour change — decision references.** `enforce()` returns
`decision_required` for a tool listed in the grant's `urn:grantex:decision:v1`
entry, even when the manifest does not declare `requires_decision`. A
malformed decision entry denies every call on the token. A delegated grant
keeps the decision entries of the connectors it keeps.

**TypeScript type change.** In `GrantTokenPayload`, `agt`, `dev` and `scp` are
optional and marked deprecated. `scope`, `aud`, `cnf`, `act` and
`urn:grantex:grant` are added. Code that relied on `agt` being a `string` needs
a check, or better, should read `VerifiedGrant`, which is unchanged apart from
new optional fields (`act`, `cnf`, `audience`, `legacyClaimsUsed`; Go also
`AuthorizationDetails`).

---

## Database migrations

All three are additive and apply automatically on start. (`097` is used by the
decision-grant work, not by these changes.)

| Migration | Change |
|---|---|
| `095_purpose_bound_grants.sql` | Nullable `purpose` on `auth_requests`, `grants`, `audit_entries` |
| `096_platform_signing_keys.sql` | `platform_signing_keys` table (used only with `SIGNING_KEY_STORE=postgres`) |
| `098_grant_actor_chain.sql` | Nullable `actor_chain` on `grants` |

## New settings

| Setting | Default | Purpose |
|---|---|---|
| `JWT_SIGNING_ALG` | `RS256` | `RS256` or `ES256` |
| `EC_PRIVATE_KEY` | — | PKCS#8 EC P-256 key for ES256 |
| `JWT_VERIFICATION_PUBLIC_KEYS` | — | JWK Set of public keys published for verification only (a key about to sign, or one that no longer signs) |
| `JWT_LEGACY_KID_KEY` | the `RSA_PRIVATE_KEY` key | Thumbprint `kid` of the RSA key that signed pre-0.6 tokens |
| `JWT_LEGACY_KID_MONTHS` | `13` | Months of `grantex-YYYY-MM` aliases published for that key |
| `SIGNING_KEY_STORE` | `env` | `env` or `postgres` |
| `SIGNING_KEY_ACTIVATION_DELAY_SECONDS` | `900` | How long a new key is published before it signs |
| `SIGNING_KEY_RETIRED_GRACE_SECONDS` | `2592000` | How long a retired stored key stays published |
| `MAX_GRANT_LIFETIME_SECONDS` | — | Longest grant lifetime accepted; the postgres-store grace must cover it |
| `GRANT_TOKEN_LEGACY_CLAIMS` | `true` (0.6), `false` (0.7) | Issue the legacy claim aliases |

## Checklist

- [ ] Every resource server verifies with a 0.6 SDK or allows `RS256` and `ES256` with `kid`-based key selection.
- [ ] Manifest files load with the 0.6 SDK: no duplicate keys, no tool named `cost_units`.
- [ ] Object-form declarations are paired with purposes on grants, a caps meter, or an accepted `decision_required`.
- [ ] Clients that push `authorization_details` send well-formed entries.
- [ ] The auth service starts with the configured signing keys; the RSA key that signed pre-0.6 tokens stays configured (or is named by `JWT_LEGACY_KID_KEY`) until those tokens expire.
- [ ] Key rotations publish the new key first and keep the old key until its tokens expire.
- [ ] No grant with a whitespace scope remains before verifiers read standard claims only.
- [ ] No deprecation warning for legacy claims appears on any resource server.
- [ ] Custom verifiers read `scope`, `client_id`, `act` and `urn:grantex:grant`.
- [ ] `GRANT_TOKEN_LEGACY_CLAIMS=false` is planned before 0.7, after every resource server reads the standard claims.
