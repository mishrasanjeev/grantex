# Canonicalisation and the decision action hash

Status: draft for Grantex 0.6.

Grantex hashes structured data in two places where two parties must compute
the same bytes independently: the semantic action a decision grant approves
(PRD G-3), and later the evidence package. Both use the JSON Canonicalization
Scheme, [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) (JCS).

## JCS profile

Implementations: `grantex.canonical` (Python SDK), `canonical.ts`
(TypeScript SDK) and the auth service. They follow RFC 8785 exactly:

- Object members are sorted by the UTF-16 code units of their names
  (a name starting with U+1F600, UTF-16 `D83D DE00`, sorts before one starting
  with U+FB33, although U+1F600 is the larger code point). Array order is kept.
- No whitespace between tokens.
- Strings are escaped as ECMAScript `JSON.stringify` escapes them: `\b`,
  `\t`, `\n`, `\f`, `\r`, `\"` and `\\` as two-character escapes, other
  characters below U+0020 as `\u00xx` with lower-case hex, everything else
  (including U+007F, U+2028 and non-ASCII text) as UTF-8. `/` is not escaped.
- Numbers are IEEE-754 doubles written as ECMAScript `Number.prototype.toString`
  writes them: `1.0` is `1`, `1E3` is `1000`, `1e21` is `1e+21`, `0.000001` is
  `0.000001`, `1e-7` is `1e-7`, `-0` is `0`.
- The output is UTF-8. No Unicode normalisation is applied.

The input must be I-JSON (RFC 7493). A value without one canonical form is
refused, never coerced:

| Input | Result |
|---|---|
| `NaN`, `Infinity`, a number literal that overflows a double (`1e400`) | refused |
| A string or member name containing an unpaired surrogate (`"\ud800"`) | refused |
| A value that is not null, boolean, number, string, array or plain object (a `Date`, a `Map`, `undefined`, a sparse array, a bigint, bytes) | refused |
| Nesting deeper than 64 arrays or objects | refused |
| Python only: an integer whose decimal digits are not the canonical form of the nearest double (`2**53 + 1`) | refused |

The last row is one-sided because a JavaScript number has already been rounded
to a double by the time it reaches the canonicaliser. Producers that need
integers beyond 2^53 or exact decimals send them as strings.

Duplicate member names cannot be represented once JSON is parsed into a
dictionary or object. Canonicalise values that come from a parser you trust to
refuse duplicates, or from your own data structures.

### Test vectors

`spec/examples/canonicalization/` holds:

- `rfc8785/`: the input, output and hexadecimal output files of the RFC 8785
  reference implementation's test data (see the README there for provenance
  and licence). Each implementation must reproduce every output byte for byte.
- `es6-numbers.json`: the generator inputs and SHA-256 checksums of the
  reference ES6 number test. Implementations generate the first 100,000
  doubles, serialise them and compare checksums at 1,000, 10,000 and 100,000
  lines.
- `parity.json`: further cases (UTF-16 member ordering, escapes, number
  spellings) and inputs that must be refused, shared by every implementation.

## Decision action hash

A decision grant is bound to the semantic action a person approved, not to
the arguments of a tool call. The action is a JSON object with exactly these
members:

| Member | Type | Required | Rule |
|---|---|---|---|
| `case_id` | string | yes | 1-256 code points, no control characters (U+0000-U+001F, U+007F-U+009F), no unpaired surrogates. |
| `action` | string | yes | The manifest tool that carries out the decision: `^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$`. |
| `decision` | string | yes | `^[a-z][a-z0-9_]{0,63}$`, the names `four_eyes_on` uses (`approve`, `decline`). |
| `subject` | string | yes | What the decision is about, 1-512 code points, same character rules as `case_id`. |
| `amount` | number or string | no | A finite number, or a canonical decimal string `^-?(0\|[1-9][0-9]*)(\.[0-9]*[1-9])?$` other than `-0`, at most 64 characters. Omit when not applicable; `null` is refused. |

Any other member is refused. Strings are compared exactly: no trimming, case
folding or normalisation. `5` and `"5"` are different amounts; `5` and `5.0`
are the same.

```
action_hash = "sha256:" || base64url( SHA-256( UTF-8( JCS(action) ) ) )
```

`base64url` is RFC 4648 section 5 without padding, so the hash is always
`sha256:` followed by 43 characters.

Example (from `spec/examples/decision-grant/action-hash.json`):

```json
{"case_id": "case_8841", "action": "case_decision", "decision": "approve", "subject": "gb:00000001"}
```

canonicalises to

```
{"action":"case_decision","case_id":"case_8841","decision":"approve","subject":"gb:00000001"}
```

and hashes to `sha256:LNavJV0rVgyvR30A6d607Hw1lZFbHGxLk4GkLAAZAOA`.

### Deriving the action from a tool call

The enforcing side derives the action from the call it is about to authorise:
`action` is the tool name, and `case_id`, `decision`, `subject` and, when
present and not null, `amount` are read from the call's arguments. Every other
argument is ignored. So a re-planned payload, a new timestamp, a trace id or a
reordered object produce the same hash, while a different case, tool,
decision, subject or amount produce a different one. The shared fixture lists
equivalent payloads that must hash identically, and both SDKs run property
tests over generated payloads in both directions.

### Errors

Validation errors carry a code and the field:

| Code | Meaning |
|---|---|
| `not_an_object` | The action (or the tool arguments) is not a JSON object. |
| `unknown_field` | A member other than the five above. |
| `missing_field` | `case_id`, `action`, `decision` or `subject` is absent. |
| `invalid_type` | A member has the wrong JSON type, or `amount` is `null`. |
| `invalid_value` | A member breaks its rule. |

### APIs

| | Python (`grantex.decisions`) | TypeScript (`@grantex/sdk`) |
|---|---|---|
| Validate an action object | `DecisionAction.from_dict(obj)` | `parseDecisionAction(obj)` |
| Action from a tool call | `DecisionAction.from_tool_call(tool, arguments)` | `decisionActionFromToolCall(tool, args)` |
| Canonical JSON | `action.canonical_json()` | `canonicalActionJson(action)` |
| Hash | `action.action_hash()`, `compute_action_hash(obj)` | `computeActionHash(action)` |
| Shape check | `is_action_hash(value)` | `isActionHash(value)` |
| JCS | `grantex.canonical.canonicalize(value)` | `canonicalize(value)` |
