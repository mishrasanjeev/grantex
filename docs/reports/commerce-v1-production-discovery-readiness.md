# Commerce V1 Production Discovery Readiness

- Assessment date: 2026-05-17T14:58:09+05:30
- Scope: read-only unauthenticated production discovery posture
- Grantex main commit: `950f9c8203c3c2fe196c96ae67f5ac921efe6496`
- Production changes made: none
- Production Commerce V1 enabled by this task: false
- Live payments enabled by this task: false
- Live Plural enabled by this task: false
- Authenticated production tokens used: false
- Raw payloads recorded: false
- Secret values recorded: false

## Endpoint Results

| Host | Endpoint | HTTP | Latency ms | Status | Redacted body hash | Discovery assertion |
| --- | --- | ---: | ---: | --- | --- | --- |
| `api.grantex.dev` | `/health` | 200 | 589 | public | `415f850cc422` | Health endpoint is publicly reachable. |
| `api.grantex.dev` | `/.well-known/jwks.json` | 200 | 353 | public | `36afa7179160` | JWKS is publicly reachable and contains public key material only. |
| `api.grantex.dev` | `/.well-known/grantex-commerce` | 503 | 313 | disabled |  | Commerce discovery fails closed while production Commerce V1 is not enabled. |
| `grantex.dev` | `/.well-known/grantex-commerce` | 404 | 147 | absent |  | Static-site commerce discovery is not published. |
| `grantex.dev` | `/commerce-playground.html` | 200 | 330 | public playground | `a248cd5e3de6` | Playground is public, but it is not production commerce discovery enablement. |

## Readiness Assessment

- Current production Commerce V1 discovery status: disabled/unavailable.
- `api.grantex.dev/.well-known/grantex-commerce` returns 503, consistent with the documented `COMMERCE_V1_ENABLED` fail-closed guard.
- `grantex.dev/.well-known/grantex-commerce` returns 404, so the static site does not currently publish commerce discovery.
- Production Commerce V1 enablement would be required before the API well-known commerce discovery endpoint can be eligible for read-only production publication.
- Production JWKS is safe to reference as public verification metadata. It is not a secret and no private key material was observed or recorded.
- No direct Stripe, Plural, Pine, provider credential, bearer token, passport/JWT, DB/Redis URL, private key, or raw payload material was recorded in this evidence.
- Playground source validation records visible blocking language for live payment mode and Plural provider configuration. The playground should not be treated as production commerce readiness or live-payment approval.
- Playground source validation also asserts no UCP, ACP, AP2, MPP, A2A, or certification claim is present on the commerce playground page.

## Recommendation

Keep Grantex production Commerce V1 discovery disabled. A later read-only production discovery proposal can be considered only after explicit human approval for:

- production Commerce V1 read-only discovery flag scope;
- exact public discovery payload review;
- legal and product signoff on production discovery wording;
- provider/live-payment/live-Plural non-enablement confirmation;
- rollback plan for returning discovery to disabled;
- post-enable unauthenticated secret scan of the public discovery payload.
