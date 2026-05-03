# Grantex Commerce V1 Build Spec

## 1. Purpose

This is the first shippable implementation slice for Grantex Commerce.

The master PRD (`GRANTEX_COMMERCE_PRD.md`) describes the long-term platform. This V1 spec defines what engineering should build first so the product is real, focused, and pilot-production-grade in a narrow lane.

V1 objective:

> Prove that an AI agent can initiate a commerce checkout through a payment provider only when Grantex can verify user consent, scope, merchant policy, revocation status, and audit evidence.

V1 positioning:

> Authorization-as-a-service for agent-initiated commerce actions.

V1 should not attempt to become a full merchant commerce platform.

## 2. Brutal Scope Boundary

V1 includes:

- Commerce Passport.
- Commerce Agent identity and registration.
- Consent request and approval.
- Passport issuance, verification, and revocation.
- Basic merchant registration.
- One launch category preset: `electronics_appliances`.
- One payment provider adapter: Plural sandbox, with live behind feature flag.
- One protocol/tool surface: Grantex native REST API plus MCP.
- Basic policy engine.
- Append-only audit ledger.
- One AgenticOrg agent: Sales Agent.
- Minimal merchant dashboard.
- OpenAPI docs and sandbox playground.
- Metering events for future billing.

V1 excludes:

- Pine POS bridge.
- UCP full implementation.
- ACP full implementation.
- A2A handoff.
- Multi-category launch.
- Full catalog/PIM system.
- Full inventory hub.
- Full pricing/offers hub.
- Refund execution.
- Refund request platform.
- Subscriptions.
- Loyalty/gift cards.
- Complaints/support platform.
- Six-agent AgenticOrg pack.
- SSO/SAML/SCIM.
- Dedicated deployments.
- Partner analytics.
- Hash-chained audit.
- SDKs.
- Public marketing site beyond a simple product page.

Deferred items are not rejected. They remain in the master PRD roadmap.

## 3. V1 Personas

### 3.1 Merchant Developer / Operator

Uses Grantex to:

- register a merchant;
- connect Plural sandbox credentials;
- configure basic policy;
- publish MCP/native API capabilities;
- view payment attempts and audit events.

### 3.2 AI Agent Platform / AgenticOrg Integrator

Uses Grantex to:

- request user consent;
- obtain Commerce Passport;
- call checkout/payment APIs;
- verify payment status;
- read audit-safe outcomes.

### 3.3 End User

Uses Grantex to:

- approve agent action;
- see spending limit, merchant, agent, and expiry;
- revoke the grant.

## 4. Provider Neutrality

Plural is the first adapter, not the product boundary.

V1 must implement a neutral payment provider interface:

- `MockPaymentProvider`
- `PluralPaymentProvider`

Provider interface:

- `healthCheck()`
- `validateCredentials()`
- `createPaymentIntent()`
- `createCheckoutLink()`
- `getPaymentStatus()`
- `handleWebhook()`
- `normalizeError()`

Provider interface contract:

```ts
type ProviderKey = "mock" | "plural";
type CommerceEnvironment = "sandbox" | "live";
type Money = { amount_minor_units: number; currency: "INR" | string };

type ProviderErrorCode =
  | "provider_unavailable"
  | "invalid_provider_credentials"
  | "provider_validation_failed"
  | "provider_rate_limited"
  | "provider_timeout"
  | "payment_declined"
  | "payment_expired"
  | "webhook_signature_invalid"
  | "webhook_replay_detected"
  | "unsupported_provider_event"
  | "unknown_provider_error";

type NormalizedProviderError = {
  code: ProviderErrorCode;
  message: string;
  retryable: boolean;
  provider_key: ProviderKey;
  provider_error_code?: string;
  provider_request_id?: string;
  safe_metadata?: Record<string, unknown>;
};

interface PaymentProvider {
  healthCheck(input: {
    tenant_id: string;
    merchant_id: string;
    environment: CommerceEnvironment;
  }): Promise<{ ok: boolean; status: "healthy" | "degraded" | "down"; checked_at: string; details?: Record<string, unknown> }>;

  validateCredentials(input: {
    tenant_id: string;
    merchant_id: string;
    environment: CommerceEnvironment;
    credential_ref: string;
  }): Promise<{ valid: boolean; merchant_account_ref?: string; capabilities: string[]; checked_at: string; error?: NormalizedProviderError }>;

  createPaymentIntent(input: {
    tenant_id: string;
    merchant_id: string;
    agent_id: string;
    payment_intent_id: string;
    cart_id: string;
    passport_jti: string;
    amount: Money;
    line_items_snapshot: unknown[];
    idempotency_key: string;
    environment: CommerceEnvironment;
    metadata: Record<string, string>;
  }): Promise<{ provider_payment_id: string; provider_order_id?: string; status: "created" | "authorized" | "payment_pending"; raw_status: string; provider_metadata?: Record<string, unknown> }>;

  createCheckoutLink(input: {
    tenant_id: string;
    merchant_id: string;
    payment_intent_id: string;
    provider_payment_id: string;
    amount: Money;
    success_url: string;
    cancel_url: string;
    expires_at: string;
    idempotency_key: string;
  }): Promise<{ checkout_url: string; expires_at: string; raw_status: string; provider_metadata?: Record<string, unknown> }>;

  getPaymentStatus(input: {
    tenant_id: string;
    merchant_id: string;
    payment_intent_id: string;
    provider_payment_id: string;
  }): Promise<{ status: "payment_pending" | "paid" | "failed" | "expired" | "cancelled"; raw_status: string; provider_metadata?: Record<string, unknown> }>;

  handleWebhook(input: {
    provider_key: ProviderKey;
    headers: Record<string, string>;
    raw_body: string;
    received_at: string;
  }): Promise<{ event_id: string; event_type: string; merchant_ref?: string; provider_payment_id?: string; status?: string; signature_valid: boolean; replay: boolean; provider_metadata?: Record<string, unknown> }>;

  normalizeError(error: unknown): NormalizedProviderError;
}
```

All provider methods are asynchronous. Provider adapters must never throw raw provider errors outside the adapter boundary; callers receive `NormalizedProviderError`. Transient provider/network failures may be retried by the service layer with bounded backoff. Validation, auth, policy, consent, tenant, and amount-cap failures must not be retried.

Do not put Plural-specific fields into core tables unless they are namespaced under provider metadata.

## 5. V1 Merchant Category

Only one preset ships in V1:

- `electronics_appliances`

Required product fields:

- SKU.
- Parent SKU for variants where applicable.
- Title.
- Brand.
- Model or variant.
- Price.
- Currency.
- Tax-inclusive flag.
- GST slab or tax rate.
- HSN code where applicable.
- Warranty summary.
- Return policy.
- Variant-level availability status: `in_stock`, `out_of_stock`, `pre_order`, `back_order`, or `unknown`.

V1 does not need full inventory quantity tracking. Variant-level availability bucket is enough because two variants of the same product may have different availability.

V1 must support variants. Implement `CommerceProduct` for the product family and `CommerceProductVariant` for purchasable SKUs. A product may have one variant if the merchant does not use variant groupings.

V1 default capabilities:

- merchant profile;
- catalog product detail;
- basic catalog search;
- price read;
- availability read;
- cart draft;
- checkout create;
- payment initiate;
- payment status.

V1 default guardrails:

- checkout requires Commerce Passport;
- payment amount cannot exceed passport limit;
- exact inventory quantity is not exposed;
- refund execution is disabled;
- emergency disable blocks all protected actions;
- stale price blocks checkout;
- unknown inventory requires user-facing warning.
- `pre_order` and `back_order` require clear user-facing availability copy before checkout.

Freshness rule:

- Price and availability are stale when `last_synced_at` is older than 24 hours, unless the merchant's source marks the product as manually maintained.
- Stale price blocks checkout/payment creation.
- Stale availability may allow browse/search but must show user-facing warning and cannot be represented as guaranteed inventory.

## 6. Commerce Passport V1

V1 passport types:

- `browse`
- `checkout`

Defer:

- `payment_delegated`
- `merchant_operator`
- `cart`
- `support`

V1 scopes:

- `commerce:catalog.read`
- `commerce:inventory.read`
- `commerce:checkout.create`
- `commerce:payment.initiate`
- `commerce:payment.status.read`

Default passport scope bundles:

- `browse`: `commerce:catalog.read`, `commerce:inventory.read`
- `checkout`: `commerce:catalog.read`, `commerce:inventory.read`, `commerce:checkout.create`, `commerce:payment.initiate`, `commerce:payment.status.read`

Agents may request a subset of the default bundle. Agents may not request scopes outside the selected passport type's maximum bundle.

Default passport expiry:

- `browse`: 60 minutes.
- `checkout`: 10 minutes.

The issuer may shorten expiry. Merchant policy may cap maximum expiry. Checkout passports should remain short-lived because they authorize payment-affecting actions.

Cart draft authorization:

- Creating a pre-consent cart draft is allowed for a registered `CommerceAgent` using agent authentication and merchant policy.
- Creating checkout/payment from a cart requires a `checkout` Commerce Passport.
- Cart draft creation must be audited but does not require a user-bound Commerce Passport.

Required claims:

- `iss`
- `sub`
- `aud`
- `tenant_id`
- `agent_id`
- `merchant_id`
- `scopes`
- `max_amount`
- `currency`
- `iat`
- `exp`
- `nbf`
- `jti`
- `grant_id`
- `consent_record_id`
- `policy_version`
- `env`
- `ver`

`max_amount` is always the tax-inclusive maximum total in minor currency units.

Agent identity requirement:

- `agent_id` must reference a registered `CommerceAgent`.
- Commerce Passport issuance must fail for unknown, disabled, or untrusted agents.
- Agent public key or DID metadata must be stored before the agent can request commerce passports.
- `CommerceAgent.trust_status` enum: `pending`, `trusted`, `suspended`, `disabled`.
- Only `trusted` agents may receive passports or call protected checkout/payment tools.

Agent authentication:

- Agent API calls must authenticate as a registered `CommerceAgent`.
- Preferred V1 agent auth is signed JWT bearer assertion in `Authorization: Bearer <agent_assertion_jwt>`, verified against `CommerceAgent.public_key_jwk`.
- Agent API keys may be supported as a secondary server-to-server mode using `Authorization: Bearer grtx_agent_<secret>`, stored only as a hash.
- Agent assertion must include `iss=agent_id`, `sub=agent_id`, `aud=grantex-commerce`, `tenant_id`, `iat`, `exp`, `jti`, and optional `session_id`.
- Agent assertion max lifetime is 5 minutes. Replay `jti` must be rejected during the assertion lifetime.
- The auth method used must be recorded on consent, passport, cart, and payment audit events.
- Agent authentication is not a substitute for user consent; checkout/payment still requires a valid `checkout` Commerce Passport.

API caller authentication:

- Merchant/operator dashboard uses the existing Grantex user auth if present; otherwise V1 fallback is email/password plus TOTP MFA with secure HTTP-only session cookie.
- Merchant server-to-server APIs use `Authorization: Bearer grtx_sk_<environment>_<secret>` API keys. Store only salted hashes. Resolve `tenant_id` and allowed merchants from the API key record.
- Agent APIs use agent JWT assertion or agent API key as above. Resolve `tenant_id` from the registered agent and validate it matches the request path/body.
- Internal background jobs use service identity with least-privilege scopes and explicit tenant/merchant parameters.
- Authentication failure returns `401`; authenticated caller without tenant, merchant, scope, or policy permission returns `403`.

V1 verification:

- Commerce Passport JWT signing algorithm is ES256 for V1.
- Verifiers must pin ES256 and reject `alg=none`, unexpected algorithms, missing `kid`, and unknown `kid`.
- JWKS endpoint: `GET /.well-known/jwks.json`.
- JWKS keys use `kid` format `commerce-passport-<yyyyMMdd>-<random_suffix>`.
- Key rotation keeps previous public keys available for at least 24 hours after the last passport signed with that key can expire.
- Clock skew tolerance for `iat`, `nbf`, and `exp` is 30 seconds.
- Offline JWT verification uses JWKS for non-payment reads.
- Online revocation check for payment-affecting actions.
- Merchant match is an always-on invariant: the passport `merchant_id` must belong to the `tenant_id` resolved from caller auth.
- A passport for tenant A's merchant must never authorize an action by a caller authenticated under tenant B.
- Protected actions fail closed if revocation service is unavailable.

V1 revocation:

- revoke passport;
- revoke all passports for user;
- revoke all passports for merchant.

## 7. Policy Engine V1

V1 policies:

1. Amount cap.
2. Scope allowlist.
3. Emergency disable.

Always-on invariants, not merchant-configurable policy toggles:

- tenant match;
- merchant match;
- agent status/trust check;
- passport expiry;
- passport revocation;
- sandbox/live environment match.

`CommercePolicy.rules` V1 schema:

```json
{
  "amount_cap": {
    "max_amount_minor_units": 50000000,
    "currency": "INR"
  },
  "scope_allowlist": [
    "commerce:catalog.read",
    "commerce:inventory.read",
    "commerce:checkout.create",
    "commerce:payment.initiate",
    "commerce:payment.status.read"
  ],
  "emergency_disable": false,
  "checkout_passport_max_ttl_seconds": 600,
  "browse_passport_max_ttl_seconds": 3600,
  "stale_price_max_age_seconds": 86400,
  "allow_unknown_inventory_checkout": false
}
```

Unknown rule keys must be rejected in V1. Policy activation must validate the schema and currency consistency. Amount cap uses tax-inclusive totals in minor currency units.

Policy output:

- `allow`
- `deny`
- `requires_user_consent`

Defer:

- complex category policies;
- agent trust scores;
- product/category allowlists;
- loyalty/refund/subscription policies;
- human approval workbench.

Emergency disable must take effect immediately for new protected actions. Do not rely only on a 60-second cache TTL.

Policy activation:

- Creating a policy does not automatically activate it.
- A policy becomes active only through `POST /v1/commerce/policies/{policy_id}/activate`.
- Policy activation must emit `policy.activated`.
- Every protected action must record the active policy version used for evaluation.

## 8. Payment V1

Provider:

- Mock provider for tests and local development.
- Plural sandbox for integration.
- Plural live behind feature flag only after legal and partner review.

V1 payment flow:

1. Agent creates cart draft.
2. Agent requests user consent.
3. Grantex issues Commerce Passport.
4. Agent calls Grantex payment intent API.
5. Grantex verifies passport and policy.
6. Grantex creates Plural checkout/payment link.
7. User completes payment.
8. Plural webhook updates payment status.
9. Audit timeline shows the full chain.

V1 payment statuses:

- `created`
- `authorized`
- `checkout_created`
- `payment_pending`
- `paid`
- `failed`
- `cancelled`
- `expired`

Valid payment state transitions:

- `created` -> `authorized`
- `authorized` -> `checkout_created`
- `checkout_created` -> `payment_pending`
- `payment_pending` -> `paid`
- `payment_pending` -> `failed`
- `payment_pending` -> `expired`
- `created|authorized|checkout_created|payment_pending` -> `cancelled`

Invalid payment state transitions must be rejected and audited.

AFA/OTP behavior:

- Plural hosted checkout owns the bank OTP/3DS/AFA step.
- Grantex tracks the payment as `payment_pending` while the user is on the hosted checkout or bank authorization step.
- Default pending timeout is 15 minutes.
- Successful AFA/OTP completion transitions to `paid` through webhook or reconciliation.
- User abandonment transitions to `expired` after timeout and reconciliation.
- Repeated AFA/OTP failure transitions to `failed` when provider reports failure.

Webhook reconciliation:

- Run automated reconciliation every 5 minutes.
- Reconcile `payment_pending` intents older than 2 minutes by calling provider `getPaymentStatus()`.
- Provide a manual "reconcile now" dashboard action for stuck payment intents.
- Reconciliation must be idempotent and audited.

Idempotency contract:

- `POST /v1/commerce/payments/intents` requires `Idempotency-Key`.
- `POST /v1/commerce/payments/intents/{id}/checkout-link` requires `Idempotency-Key`.
- `POST /v1/commerce/carts` requires `Idempotency-Key`.
- Keys are scoped by merchant, endpoint, and environment.
- Repeated request with same key and same body returns the original response.
- Repeated request with same key and different body returns HTTP `409`.
- Keys persist for at least 24 hours.

Defer:

- refunds as execution;
- subscriptions;
- EMI optimization;
- rewards;
- Pine POS.

Refund in V1:

- Refund execution is out of scope.
- Refund request API is out of scope.
- Merchant must process refunds in existing provider/merchant systems during V1.
- V1 may display provider payment status and audit references needed for manual refund handling.

## 9. Protocol Surface V1

V1 includes:

- Grantex native REST API.
- MCP server/tools.
- `/.well-known/grantex-commerce`.

V1 excludes:

- full UCP;
- full ACP;
- A2A.

The V1 docs may say:

- "designed for future UCP/ACP/AP2 compatibility";
- "MCP supported";
- "native Grantex Commerce API supported".

Do not claim certified compliance with ACP, UCP, AP2, MPP, or A2A.

AP2/MPP positioning:

- Grantex Commerce V1 is a delegated authorization and audit layer.
- Payment-network protocols such as AP2/MPP are treated as future compatibility targets for payment-network mandate evidence.
- V1 should not present itself as a replacement for AP2/MPP.
- V1 should state that Grantex can provide consent, scope, revocation, and audit evidence that payment-network protocols may consume in later integrations.

V1 MCP tools:

- `merchant.get_profile`
- `catalog.search`
- `catalog.get_item`
- `inventory.check`
- `cart.create`
- `checkout.create`
- `payment.create_intent`
- `payment.get_status`

MCP tool contract:

| Tool | Required auth | Required scope/passport | Input schema summary | Output schema summary | Audit |
| --- | --- | --- | --- | --- | --- |
| `merchant.get_profile` | Agent or public if merchant published public browse | none or `commerce:catalog.read` for private profile | `{merchant_id}` | merchant display/legal name, category preset, environment, capability list, verified status | no audit for public reads; `passport.verified` if passport used |
| `catalog.search` | Agent/API key/public per merchant setting | `commerce:catalog.read` for private catalog | `{merchant_id, query, filters?, limit?, cursor?}` | `{items:[{product_id,title,brand,variants_summary}], next_cursor?}` | no audit for public reads; read audit optional |
| `catalog.get_item` | Agent/API key/public per merchant setting | `commerce:catalog.read` for private catalog | `{merchant_id, product_id}` | product plus variant fields, price, tax, warranty, return summary, availability, freshness | read audit optional |
| `inventory.check` | Agent/API key | `commerce:inventory.read` | `{merchant_id, variant_ids:[...]}` | `{items:[{variant_id, availability_status, last_synced_at, stale}]}` | read audit optional |
| `cart.create` | Registered `CommerceAgent` | agent auth; checkout passport not required for pre-consent draft | `{merchant_id, line_items:[{variant_id, quantity}], currency}` | `{cart_id,status,total_amount,currency,expires_at,line_items_snapshot}` | `cart.created` |
| `checkout.create` | Registered `CommerceAgent` | `checkout` passport with `commerce:checkout.create` | `{merchant_id, cart_id, passport_jti}` | `{payment_intent_id,status,requires_payment_link:true}` | `policy.evaluated` if deny/consent; action audit |
| `payment.create_intent` | Registered `CommerceAgent` | `checkout` passport with `commerce:payment.initiate` | `{merchant_id, cart_id, passport_jti, idempotency_key}` | `{payment_intent_id,status,amount,currency}` | `payment_intent.created` |
| `payment.get_status` | Registered `CommerceAgent` or merchant API key | `commerce:payment.status.read` or merchant API permission | `{merchant_id, payment_intent_id}` | `{payment_intent_id,status,provider_status?,updated_at,audit_event_ids}` | no status-read audit required unless denied |

Every MCP tool must expose JSON Schema `inputSchema`. V1 should expose output schemas in tool metadata or documentation even if the runtime only requires input schemas. MCP errors use the same standard error envelope as REST where possible.

V1 MCP client requirement:

- Build a demo MCP client in the Grantex playground so the MCP server can be tested without relying on an external directory listing.
- Start external connector/listing conversations separately; connector listing is not a V1 launch dependency.

Outbound webhook policy:

- V1 emits no outbound webhooks.
- Agents poll `payment.get_status` for state changes.
- Merchants observe status through the dashboard or `GET /v1/commerce/payments/intents/{id}`.
- Outbound Grantex webhooks are deferred to V2.

## 10. Audit V1

Use append-only Postgres audit table.

Audit events:

- merchant.created
- merchant.disabled
- merchant.credentials.updated
- merchant.feature_flag.updated
- merchant.provider_credentials.validated
- merchant.webhook_source.created
- merchant.webhook_source.secret_rotated
- policy.created
- policy.activated
- consent.requested
- consent.granted
- consent.denied
- passport.issued
- passport.verified
- passport.revoked
- passport.expired
- policy.evaluated
- cart.created
- payment_intent.created
- payment_intent.cancelled
- payment_intent.expired
- checkout_link.created
- provider.webhook.received
- provider.webhook.signature_failed
- payment_intent.paid
- payment_intent.failed
- protected_action.denied
- idempotency.conflict
- rate_limit.exceeded
- meter.passport_issued
- meter.payment_intent_created

Every protected action must have an audit event.

Policy audit semantics:

- Audit `policy.evaluated` when the decision is `deny` or `requires_user_consent`.
- For `allow` decisions, the resulting action event must include `policy_version` and policy decision reference instead of emitting a separate `policy.evaluated` row.
- This avoids unnecessary audit write amplification while preserving forensic traceability.

V1 does not need hash chaining.

Audit append-only enforcement:

- The application database role must have only `INSERT` and `SELECT` on `commerce_audit_events`.
- `UPDATE` and `DELETE` must be revoked at the database level.
- Audit corrections must be new compensating events, never row edits.
- Admin users must not have dashboard controls that mutate audit rows.

Metering:

- Emit a metering event for every `passport.issued`.
- Emit a metering event for every `payment_intent.created`.
- Metering is not billing in V1, but it prevents historical usage gaps when billing is added later.

## 11. Merchant Data V1

V1 should avoid building a full PIM/inventory/pricing system.

Supported input methods:

- manual entry in dashboard;
- CSV upload;
- simple REST upsert APIs;
- merchant inbound webhook for one complete-state event:
  - `catalog.product.updated`

V1 product model:

- merchant_id;
- product_id;
- title;
- brand;
- description;
- image_url;
- variants.

V1 product variant model:

- variant_id;
- sku;
- parent_sku;
- model;
- variant_title;
- attributes;
- price_amount;
- currency;
- tax_inclusive;
- gst_slab or tax_rate;
- hsn_code;
- availability_status;
- warranty_summary;
- return_policy_summary;
- source_system;
- last_synced_at.

Inbound webhook behavior:

- `catalog.product.updated` payload must include full product plus variant price and availability state.
- Envelope:
  - `event_id`: unique per merchant/source;
  - `event_type`: `catalog.product.updated`;
  - `occurred_at`: ISO-8601 timestamp;
  - `payload_version`: `2026-05-01`;
  - `source_key`: configured source key;
  - `data`: full product payload.
- Signature header: `Grantex-Signature: t=<unix_timestamp>,v1=<hex_hmac_sha256>`.
- Signature payload is `<timestamp>.<raw_body>`.
- Signature secret is merchant/source-specific and rotated through the webhook source APIs.
- Partial price-only or inventory-only webhooks are out of scope for V1.
- If an inbound product update changes price for an active payment intent, the existing payment intent must not be silently updated.
- If the new price exceeds the passport `max_amount`, creating a new checkout link must require fresh consent.
- Multiple webhook sources per merchant are allowed in V1 so a merchant can separate manual back-office, ERP, POS, and test feeds even though only one event type is accepted.

V1 does not sync Shopify, WooCommerce, Magento, Google Merchant Center, or ONDC unless an existing connector already exists in the codebase.

## 12. Merchant Dashboard V1

Routes:

- `/dashboard/commerce/onboarding`
- `/dashboard/commerce/passports`
- `/dashboard/commerce/payments`
- `/dashboard/commerce/audit`
- `/dashboard/commerce/settings`
- `/dashboard/commerce/playground`

V1 dashboard features:

- create merchant;
- select electronics category preset;
- configure Plural sandbox credentials;
- validate Plural sandbox credentials;
- configure inbound webhook sources and rotate source secrets;
- add/upload product;
- configure amount cap and emergency disable;
- view passports;
- view payment attempts;
- view audit timeline;
- manually reconcile a stuck payment intent;
- run sandbox demo.

Dashboard authentication:

- Use existing Grantex dashboard authentication if present.
- If no operator auth exists, V1 fallback is email/password plus TOTP MFA.
- Merchant operator sessions use secure HTTP-only cookies, CSRF protection, idle timeout, and audit on privileged actions.
- SSO/SAML/SCIM are out of scope for V1 but must not be blocked architecturally.

No 22-route dashboard in V1.

## 13. AgenticOrg V1

Only one agent:

- `commerce-sales-agent`

Responsibilities:

- product discovery;
- product Q&A from tool data;
- cart draft;
- consent request;
- checkout/payment intent creation through Grantex tools.

Guardrails:

- no checkout without consent;
- no amount above passport limit;
- no unsupported offers;
- no guaranteed inventory when status is `unknown`;
- Agent's tool surface is Grantex tools only; provider orchestration happens in Grantex services, not in agent code;
- no direct payment credential handling.

V1 evals:

- refuses checkout without consent;
- respects amount cap;
- respects emergency disable;
- uses tool data for price;
- does not hallucinate EMI/discount;
- logs audit events.

## 14. Regulatory V1

India live payment mode:

- user-confirmed checkout only by default.
- no autonomous delegated payment without legal approval.
- no recurring mandates in V1.
- no UPI AutoPay/e-mandate in V1 unless separately approved.

RBI payment data localization:

- Live deployment region for India payment mode must be India-resident before Plural live mode opens.
- Live deployment must store payment-related data in India-resident infrastructure.
- Payment-related data includes payment intents, provider payment IDs, provider order IDs, checkout references, webhook payloads or payload hashes, audit events containing payment references, and consent records tied to payment actions.
- Sandbox may operate outside India if no real payment data is present.
- Live mode must not store payment-related data outside India unless legal review explicitly approves the architecture.
- Data residency requirements apply before Plural live mode is enabled.

V1 consent screen must show:

- merchant;
- agent;
- amount cap;
- currency;
- expiry;
- action being authorized;
- final payment confirmation requirement;
- revocation path.

Consent UX/security requirements:

- Consent page should be hosted on a Grantex-controlled domain such as `consent.grantex.dev` for V1.
- Consent approval and denial must be single-use actions tied to a consent request ID.
- Consent request ID must be UUID v4 or at least 128 bits of CSPRNG entropy.
- Consent request must expire; default expiry is 10 minutes.
- Consent request details must be immutable after presentation to the user.
- Use frame-busting headers: `X-Frame-Options: DENY` and appropriate `Content-Security-Policy`.
- Minimum CSP: `default-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; connect-src 'self'`.
- Do not use third-party iframes on the V1 consent page.
- Use CSRF protection for approval/deny actions.
- Show amount in tax-inclusive total and local currency formatting.
- Show merchant legal/display name and verified status.
- Show agent display name and trust status.
- Show expiry and revocation path before approval.
- High-value consent must be compatible with step-up authentication such as passkey/WebAuthn later, but passkey is not required in V1 unless already available.
- Page must be mobile responsive.
- Page must be accessible to screen readers.
- English copy is required in V1; Hindi/localization is recommended before broader India launch.

V1 payment requirement:

- Every V1 live payment requires final user confirmation.
- No autonomous delegated payment is allowed in V1.

Live launch blocker:

- legal review for RBI AFA/payment consent language.

## 15. V1 Data Model

Required entities:

- `CommerceMerchant`
- `CommerceCategoryPreset`
- `CommerceAgent`
- `CommerceProduct`
- `CommerceProductVariant`
- `CommerceConsentRecord`
- `CommercePassport`
- `CommercePolicy`
- `CommerceCart`
- `CommercePaymentIntent`
- `CommerceAuditEvent`
- `CommerceProviderCredential`
- `CommerceWebhookEvent`
- `CommerceAgentSession`
- `CommerceMeterEvent`

Database:

- V1 persistence target is Postgres.
- Use the codebase's existing migration tool if one exists.
- Migrations must be forward-only and backward-compatible enough to deploy before code that depends on them.
- Prefer Postgres row-level security for tenant-owned commerce tables if it fits the existing auth model.

V1 tenant model:

- One tenant represents one Grantex customer organization.
- A tenant may own one or more merchants, agents, provider credentials, policies, passports, carts, payment intents, and audit events.
- The Pine/Plural partner uses a dedicated partner tenant.
- AgenticOrg may have its own tenant for agent platform integration, but merchant commerce records remain owned by the merchant tenant.
- Every authenticated request resolves exactly one `tenant_id` from dashboard session, API key, agent identity, or service identity.

Minimum `CommerceMerchant` fields:

- `id`
- `tenant_id`
- `legal_name`
- `display_name`
- `category_preset`
- `verification_status`: `unverified`, `pending`, `verified`, `rejected`
- `environment`: `sandbox`, `live`
- `agentic_commerce_enabled`
- `default_currency`
- `country_code`
- `support_email`
- `provider_account_refs`
- `metadata`
- `created_at`
- `updated_at`
- `disabled_at`

Minimum `CommerceCategoryPreset` fields:

- `id`
- `preset_key`
- `display_name`
- `version`
- `required_fields`
- `default_policy_rules`
- `default_capabilities`
- `created_at`
- `updated_at`

Minimum `CommerceAgent` fields:

- `id`
- `tenant_id`
- `display_name`
- `agent_type`
- `public_key_jwk`
- `api_key_hash`
- `trust_status`: `pending`, `trusted`, `suspended`, `disabled`
- `disabled_at`
- `created_at`
- `updated_at`

Minimum `CommerceProduct` fields:

- `id`
- `tenant_id`
- `merchant_id`
- `product_id`
- `title`
- `brand`
- `description`
- `image_url`
- `category_preset`
- `source_system`
- `manually_maintained`
- `archived_at`
- `created_at`
- `updated_at`

Minimum `CommerceProductVariant` fields:

- `id`
- `tenant_id`
- `merchant_id`
- `product_id`
- `sku`
- `parent_sku`
- `model`
- `variant_title`
- `attributes`
- `price_amount`
- `currency`
- `tax_inclusive`
- `gst_slab` or `tax_rate`
- `hsn_code`
- `availability_status`
- `warranty_summary`
- `return_policy_summary`
- `source_system`
- `last_synced_at`
- `archived_at`

Minimum `CommerceConsentRecord` fields:

- `id`
- `tenant_id`
- `merchant_id`
- `agent_id`
- `user_principal_id`
- `consent_request_id`
- `passport_type`
- `requested_scopes`
- `approved_scopes`
- `max_amount`
- `currency`
- `consent_text_version`
- `presented_payload_hash`
- `status`: `requested`, `granted`, `denied`, `expired`
- `auth_method`
- `ip_hash`
- `user_agent_hash`
- `expires_at`
- `approved_at`
- `denied_at`
- `created_at`
- `updated_at`

Minimum `CommercePassport` fields:

- `id`
- `tenant_id`
- `merchant_id`
- `agent_id`
- `consent_record_id`
- `passport_type`
- `jti`
- `kid`
- `subject`
- `scopes`
- `max_amount`
- `currency`
- `policy_version`
- `environment`
- `issued_at`
- `not_before`
- `expires_at`
- `revoked_at`
- `revocation_reason`
- `created_at`

Minimum `CommercePolicy` fields:

- `id`
- `tenant_id`
- `merchant_id`
- `version`
- `rules`
- `status`: `draft`, `active`, `archived`
- `created_by`
- `activated_by`
- `activated_at`
- `created_at`
- `updated_at`

Minimum `CommerceCart` fields:

- `id`
- `tenant_id`
- `merchant_id`
- `agent_id`
- `passport_jti`
- `line_items`
- `currency`
- `subtotal_amount`
- `tax_amount`
- `total_amount`
- `status`
- `expires_at`
- `line_items_snapshot_hash`
- `created_at`
- `updated_at`

`passport_jti` is nullable while the cart is a pre-consent draft. It becomes required when creating checkout/payment from the cart.

V1 carts are immutable after creation except for status transitions. To change line items, create a new cart. This keeps idempotency, consent, and amount-cap checks simple for V1.

Minimum `CommercePaymentIntent` fields:

- `id`
- `tenant_id`
- `merchant_id`
- `agent_id`
- `cart_id`
- `passport_jti`
- `amount`
- `currency`
- `provider`
- `provider_environment`
- `provider_payment_id`
- `provider_order_id`
- `checkout_url`
- `status`
- `line_items_snapshot`
- `idempotency_key_hash`
- `provider_metadata`
- `created_at`
- `updated_at`
- `expires_at`

`CommercePaymentIntent` must either reference `cart_id` or carry an immutable `line_items_snapshot`; V1 requires both for debuggability. The snapshot must not be silently changed after payment intent creation.

Minimum `CommerceAuditEvent` fields:

- `id`
- `tenant_id`
- `merchant_id`
- `agent_id`
- `user_principal_id`
- `event_type`
- `resource_type`
- `resource_id`
- `passport_jti`
- `policy_version`
- `decision_id`
- `idempotency_key_hash`
- `request_id`
- `occurred_at`
- `metadata`

Minimum `CommerceProviderCredential` fields:

- `id`
- `tenant_id`
- `merchant_id`
- `provider_key`
- `environment`
- `credential_ref`
- `encrypted_secret_blob`
- `secret_version`
- `status`: `pending`, `valid`, `invalid`, `disabled`
- `last_validated_at`
- `last_validation_error`
- `capabilities`
- `created_at`
- `updated_at`
- `rotated_at`

Provider credential storage:

- Store provider credentials encrypted at rest using the platform KMS/secrets manager available in the codebase.
- If no secrets manager exists, use envelope encryption with a dedicated environment KMS key and store only encrypted blobs in Postgres.
- Never show raw provider credentials after save.
- Never write raw provider credentials to logs, audit metadata, analytics, or test snapshots.

Minimum `CommerceWebhookEvent` fields:

- `id`
- `tenant_id`
- `source_type`
- `source_key`
- `merchant_id`
- `event_id`
- `event_type`
- `signature_validation_status`
- `payload_hash`
- `raw_payload_ref`
- `error_code`
- `error_message`
- `attempt_count`
- `received_at`
- `processed_at`
- `status`

Minimum `CommerceAgentSession` fields:

- `id`
- `tenant_id`
- `agent_id`
- `user_principal_id`
- `started_at`
- `ended_at`
- `passport_jtis`
- `tools_called`
- `outcome`

All V1 tenant-owned entities must include `tenant_id`, even if the abbreviated field list above omits it.

Minimum `CommerceMeterEvent` fields:

- `id`
- `tenant_id`
- `merchant_id`
- `event_type`
- `resource_type`
- `resource_id`
- `occurred_at`
- `metadata`

Minimum required indexes and constraints:

- `CommerceMerchant(tenant_id, id)` unique lookup.
- `CommerceAgent(tenant_id, id)` unique lookup.
- `CommerceProduct(tenant_id, merchant_id, product_id)` unique.
- `CommerceProductVariant(tenant_id, merchant_id, sku)` unique for active variants.
- `CommercePassport(jti)` globally unique.
- `CommercePassport(tenant_id, merchant_id, agent_id, expires_at)`.
- `CommerceCart(tenant_id, merchant_id, created_at)`.
- `CommercePaymentIntent(tenant_id, merchant_id, created_at)`.
- `CommercePaymentIntent(tenant_id, provider, provider_payment_id)` unique where provider payment ID exists.
- Idempotency records unique by `(tenant_id, merchant_id, endpoint, environment, idempotency_key_hash)`.
- `CommerceWebhookEvent(tenant_id, source_type, source_key, event_id)` unique.
- `CommerceAuditEvent(tenant_id, merchant_id, occurred_at)`.
- One active `CommercePolicy` per `(tenant_id, merchant_id)`.
- Foreign keys from variants to products, carts to merchants/agents/passports where applicable, payment intents to carts, provider credentials to merchants, and audit events to tenant/merchant where applicable.

Do not create the full master-PRD entity set in V1 unless required by these flows.

## 16. V1 REST APIs

API documentation:

- Maintain an OpenAPI 3.1 document for V1, preferably `docs/api/grantex-commerce-v1.openapi.yaml` or the codebase's existing API-doc location.
- OpenAPI must include auth schemes, request schemas, response schemas, standard errors, pagination, and examples for sandbox flow.

Standard HTTP conventions:

- Create success: `201`.
- Read/list success: `200`.
- Update success: `200`.
- Accepted async/retry operation: `202` only when background processing is actually used.
- Validation error: `422`.
- Authentication failure: `401`.
- Authorization/policy denial: `403`.
- Not found within caller tenant: `404`.
- Idempotency conflict: `409`.
- Rate limit: `429`.
- Provider unavailable/timeout: `503` with retryable error envelope.

Standard error envelope:

```json
{
  "error": {
    "code": "policy_denied",
    "message": "Checkout exceeds the approved passport amount.",
    "decision_id": "dec_...",
    "audit_event_id": "aud_...",
    "remediation": "Request fresh user consent with a higher amount cap.",
    "retryable": false,
    "details": {}
  }
}
```

List endpoints use cursor pagination:

- request query: `limit`, `cursor`, `sort`, and endpoint-specific filters.
- response: `{ "items": [], "next_cursor": null }`.
- default `limit` is 25; max `limit` is 100.

`GET /v1/commerce/audit/events` filters:

- `merchant_id`
- `agent_id`
- `passport_jti`
- `payment_intent_id`
- `event_type`
- `from`
- `to`
- `limit`
- `cursor`

Merchant:

- `POST /v1/commerce/merchants`
- `GET /v1/commerce/merchants/{merchant_id}`
- `PATCH /v1/commerce/merchants/{merchant_id}`
- `POST /v1/commerce/merchants/{merchant_id}/disable-agentic-commerce`

Provider credentials:

- `POST /v1/commerce/provider-credentials`
- `GET /v1/commerce/provider-credentials`
- `PATCH /v1/commerce/provider-credentials/{credential_id}`
- `POST /v1/commerce/provider-credentials/{credential_id}/validate`

Products:

- `POST /v1/commerce/catalog/products`
- `POST /v1/commerce/catalog/products/bulk`
- `GET /v1/commerce/catalog/products`
- `GET /v1/commerce/catalog/products/{product_id}`
- `PATCH /v1/commerce/catalog/products/{product_id}`
- `DELETE /v1/commerce/catalog/products/{product_id}`
- `POST /v1/commerce/catalog/search`

Product deletion in V1 is soft-delete/archive. Do not hard-delete products or variants that are referenced by carts, payment intents, audit events, or webhooks.

Agents:

- `POST /v1/commerce/agents`
- `GET /v1/commerce/agents`
- `GET /v1/commerce/agents/{agent_id}`
- `PATCH /v1/commerce/agents/{agent_id}`

Policy:

- `POST /v1/commerce/policies`
- `GET /v1/commerce/policies`
- `GET /v1/commerce/policies/{policy_id}`
- `POST /v1/commerce/policies/{policy_id}/activate`
- `POST /v1/commerce/policies/evaluate`

Cart:

- `POST /v1/commerce/carts`
- `GET /v1/commerce/carts/{cart_id}`

Passport:

- `POST /v1/commerce/passports/consent-requests`
- `POST /v1/commerce/passports/exchange`
- `GET /v1/commerce/passports`
- `POST /v1/commerce/passports/verify`
- `POST /v1/commerce/passports/revoke`

Payments:

- `POST /v1/commerce/payments/intents`
- `GET /v1/commerce/payments/intents`
- `GET /v1/commerce/payments/intents/{id}`
- `POST /v1/commerce/payments/intents/{id}/checkout-link`
- `POST /v1/webhooks/providers/{provider_key}`

For Plural sandbox, `provider_key` is `plural`. Do not hardcode the route to Plural in the core webhook router.

Audit:

- `GET /v1/commerce/audit/events`

Well-known/MCP:

- `GET /.well-known/grantex-commerce`
- MCP streamable HTTP endpoint at `/mcp`

MCP transport note:

- `/mcp` represents the MCP server entrypoint.
- V1 MCP server uses the streamable HTTP transport from the current MCP specification.
- SSE transport is not supported in V1.
- The well-known profile must tell clients the exact MCP transport URL and supported tools.

Minimum `/.well-known/grantex-commerce` response:

```json
{
  "version": "2026-05-01",
  "merchant_id": "mch_...",
  "tenant_environment": "sandbox",
  "merchant": {
    "display_name": "Merchant Name",
    "legal_name": "Merchant Legal Name",
    "verified": true,
    "category_preset": "electronics_appliances"
  },
  "protocols": {
    "mcp": {
      "transport": "streamable_http",
      "url": "https://commerce.grantex.dev/mcp",
      "tools": ["merchant.get_profile", "catalog.search", "catalog.get_item", "inventory.check", "cart.create", "checkout.create", "payment.create_intent", "payment.get_status"]
    },
    "native_rest": {
      "base_url": "https://commerce.grantex.dev/v1/commerce"
    }
  },
  "auth": {
    "agent_jwt": true,
    "api_key": true,
    "commerce_passport_required_for": ["checkout.create", "payment.create_intent"]
  },
  "capabilities": ["catalog.search", "inventory.check", "cart.create", "checkout.create", "payment.create_intent", "payment.get_status"]
}
```

Inbound merchant webhooks:

- `POST /v1/webhooks/merchant/{merchant_id}/{source_key}`

Inbound webhook sources:

- `POST /v1/commerce/webhook-sources`
- `GET /v1/commerce/webhook-sources`
- `PATCH /v1/commerce/webhook-sources/{source_key}`
- `POST /v1/commerce/webhook-sources/{source_key}/rotate-secret`

Inbound merchant webhook contract:

- Webhook payloads must be signed with a merchant/source-specific secret.
- Signature algorithm is HMAC-SHA256 over `<timestamp>.<raw_body>`.
- Signature header format is `Grantex-Signature: t=<unix_timestamp>,v1=<hex_hmac_sha256>`.
- Include event ID, event type, occurred-at timestamp, source key, and payload version.
- Reject unsigned webhooks.
- Reject timestamps outside the configured replay window; default replay window is 5 minutes.
- Process repeated event IDs idempotently.
- Store failed events for dashboard visibility and manual replay.
- V1 accepts only `catalog.product.updated`; all other inbound event types return explicit `unsupported_event_type`.

Provider webhook contract:

- Route is `POST /v1/webhooks/providers/{provider_key}`.
- Plural signature scheme is an external blocker until Pine/Plural confirms the exact scheme.
- If Plural signature scheme is unavailable during development, implement the route against the mock provider signature contract and leave Plural live/sandbox webhook verification blocked with explicit configuration error.
- Provider webhook events must be idempotent by provider event ID and payment reference.

PATCH mutable field allowlists:

- Merchant PATCH may update: `display_name`, `support_email`, `agentic_commerce_enabled`, metadata fields that are explicitly non-security-sensitive.
- Agent PATCH may update: `display_name`, `public_key_jwk`, `trust_status`, `disabled_at`.
- Product PATCH may update: `title`, `brand`, `description`, `image_url`, `archived_at`.
- Variant PATCH may update: `variant_title`, `attributes`, `price_amount`, `currency`, `tax_inclusive`, `gst_slab`, `tax_rate`, `hsn_code`, `availability_status`, `warranty_summary`, `return_policy_summary`, `last_synced_at`, `archived_at`.
- Policy drafts may update `rules`; active policies are immutable and changes require creating a new policy version then activating it.
- Never allow clients to PATCH `id`, `tenant_id`, `merchant_id`, `created_at`, audit fields, provider credential secret blobs, `passport_jti`, or payment provider references.

Minimum request/response contracts:

- Create endpoints accept JSON body and return the created resource envelope `{ "data": { ... } }`.
- List endpoints return `{ "items": [...], "next_cursor": null }`.
- Protected action endpoints return `{ "data": ..., "decision_id": "...", "audit_event_id": "..." }` when an audit event is emitted.
- Idempotency conflict returns HTTP `409` with standard error envelope and must not return a mismatched previous success body.
- Validation failures return field-level details in `error.details.fields`.

Endpoint schema minimums:

| Endpoint | Request minimum | Response minimum |
| --- | --- | --- |
| `POST /v1/commerce/merchants` | legal/display name, category preset, country, currency | merchant |
| `GET /v1/commerce/merchants/{merchant_id}` | path merchant ID | merchant |
| `PATCH /v1/commerce/merchants/{merchant_id}` | mutable merchant fields only | merchant |
| `POST /v1/commerce/provider-credentials` | merchant ID, provider key, environment, credential payload | credential metadata, never raw secret |
| `GET /v1/commerce/provider-credentials` | merchant/provider/environment filters | credential metadata list |
| `PATCH /v1/commerce/provider-credentials/{credential_id}` | replacement credential payload or disabled status | credential metadata |
| `POST /v1/commerce/provider-credentials/{credential_id}/validate` | optional validation mode | validation status and capability list |
| `POST /v1/commerce/catalog/products` | product with variants | product with variants |
| `POST /v1/commerce/catalog/products/bulk` | array of products with variants | accepted/created/failed counts and row errors |
| `GET /v1/commerce/catalog/products` | merchant ID, filters, pagination | product list |
| `GET /v1/commerce/catalog/products/{product_id}` | product ID | product with variants |
| `PATCH /v1/commerce/catalog/products/{product_id}` | mutable product fields | product |
| `DELETE /v1/commerce/catalog/products/{product_id}` | product ID | archived product status |
| `POST /v1/commerce/catalog/search` | merchant ID, query, filters, pagination | matching products/variants |
| `POST /v1/commerce/agents` | display name, agent type, public key or API-key mode | agent metadata and one-time API key only if generated |
| `GET /v1/commerce/agents` | merchant/tenant filters, pagination | agent list |
| `GET /v1/commerce/agents/{agent_id}` | agent ID | agent metadata |
| `PATCH /v1/commerce/agents/{agent_id}` | mutable agent fields | agent metadata |
| `POST /v1/commerce/policies` | merchant ID, policy rules | draft policy |
| `GET /v1/commerce/policies` | merchant ID, status, pagination | policy list |
| `GET /v1/commerce/policies/{policy_id}` | policy ID | policy |
| `POST /v1/commerce/policies/{policy_id}/activate` | policy ID | active policy and audit ID |
| `POST /v1/commerce/policies/evaluate` | merchant ID, agent ID, passport/context/action/amount | decision, reason, policy version |
| `POST /v1/commerce/carts` | merchant ID, agent ID, line items, currency | immutable cart draft |
| `GET /v1/commerce/carts/{cart_id}` | cart ID | cart |
| `POST /v1/commerce/passports/consent-requests` | merchant ID, agent ID, requested scopes, amount cap, currency, expiry | consent request and approval URL |
| `POST /v1/commerce/passports/exchange` | consent request ID and approval proof | signed passport/JWT metadata |
| `GET /v1/commerce/passports` | merchant/agent/status filters, pagination | passport metadata list, not raw secrets |
| `POST /v1/commerce/passports/verify` | passport JWT or JTI, requested action | verification result |
| `POST /v1/commerce/passports/revoke` | JTI or scope of revocation, reason | revocation result |
| `POST /v1/commerce/payments/intents` | merchant ID, cart ID, passport JTI, amount/currency, idempotency key | payment intent |
| `GET /v1/commerce/payments/intents` | merchant/status/date filters, pagination | payment intent list |
| `GET /v1/commerce/payments/intents/{id}` | payment intent ID | payment intent |
| `POST /v1/commerce/payments/intents/{id}/checkout-link` | payment intent ID, idempotency key, return URLs | checkout URL and expiry |
| `POST /v1/webhooks/providers/{provider_key}` | signed raw provider body | accepted/ignored result |
| `GET /v1/commerce/audit/events` | filters and pagination | audit events |
| `POST /v1/webhooks/merchant/{merchant_id}/{source_key}` | signed catalog product updated envelope | accepted/failed result |
| `POST /v1/commerce/webhook-sources` | merchant ID, source key/display name | source metadata and one-time secret |
| `GET /v1/commerce/webhook-sources` | merchant ID | source metadata list |
| `PATCH /v1/commerce/webhook-sources/{source_key}` | mutable source fields | source metadata |
| `POST /v1/commerce/webhook-sources/{source_key}/rotate-secret` | source key | source metadata and one-time new secret |

Idempotency API contract:

- `POST /v1/commerce/payments/intents` requires `Idempotency-Key`.
- `POST /v1/commerce/payments/intents/{id}/checkout-link` requires `Idempotency-Key`.
- `POST /v1/commerce/carts` requires `Idempotency-Key`.
- Same key and same request body returns the original response.
- Same key and different request body returns HTTP `409`.
- Idempotency records persist for at least 24 hours.
- After 24 hours, the implementation may treat the key as expired and process a new request, but only after the old record is outside its retention window. The response must not be ambiguous.

Rate limits:

| Endpoint | Limit |
| --- | --- |
| `POST /v1/commerce/catalog/search` unauthenticated | 60 requests/minute/IP |
| `POST /v1/commerce/catalog/search` authenticated | 600 requests/minute/agent or API key |
| `POST /v1/commerce/payments/intents` | 60 requests/minute/merchant |
| `POST /v1/webhooks/providers/{provider_key}` | 1000 requests/minute/merchant/provider; verified provider sender only |
| `POST /v1/webhooks/merchant/{merchant_id}/{source_key}` | 100 requests/minute/source key |
| `POST /v1/commerce/passports/consent-requests` | 120 requests/minute/agent |
| `POST /v1/commerce/passports/verify` | 1000 requests/minute/agent or API key |
| `POST /v1/commerce/policies/evaluate` | 1000 requests/minute/agent or API key |
| MCP `/mcp` tool calls | 600 requests/minute/agent or API key |

Rate-limit source IP:

- For unauthenticated per-IP rate limits, trust forwarded IP headers only from configured trusted proxies/load balancers.
- Ignore spoofable `X-Forwarded-For` from untrusted peers.

Tenant isolation design:

- V1 tenant model: one tenant represents one Grantex customer organization.
- A tenant may own one or more merchants, agents, provider credentials, policies, passports, carts, payment intents, and audit events.
- The Pine/Plural partner uses a dedicated tenant.
- The first pilot merchant operates under its own tenant or under a Grantex internal sandbox tenant until live readiness.
- Every authenticated request resolves to exactly one `tenant_id` from auth context.
- Every tenant-owned table includes `tenant_id`.
- Every query must filter by `tenant_id`; prefer Postgres row-level security if it fits the existing codebase.
- No cross-tenant joins in V1 product code.
- Sandbox passports cannot authorize live actions.
- Test/demo merchants must be marked in dashboard and API responses.

## 16.1 Security And Operations Contracts

Secrets management:

- JWT signing keys, provider credentials, API keys, and webhook secrets must live in the codebase's existing secrets manager/KMS if available.
- If no secrets manager exists, use envelope encryption with environment-specific KMS key and store encrypted blobs only.
- Store API keys only as salted hashes.
- Provider credentials and webhook secrets are displayed only once at creation/rotation.

Logging and privacy:

- Structured logs must include request ID, tenant ID, merchant ID, agent ID, payment intent ID, provider key, and error code where relevant.
- Logs must redact emails, phone numbers, raw consent payloads, provider credentials, API keys, JWTs, webhook secrets, and raw payment data.
- Test snapshots must not contain real secrets or raw payment credentials.

Feature flags:

- Required flags: `commerce_v1_enabled`, `commerce_sandbox_enabled`, `plural_sandbox_enabled`, `plural_live_enabled`, `commerce_live_mode_enabled`.
- Feature flag changes that affect payment or agentic commerce must be audited as `merchant.feature_flag.updated`.
- Live flags require admin/operator permission and legal blocker acknowledgment.

Background jobs:

- Reconciliation runs through the codebase's existing job runner if present.
- If no job runner exists, V1 must add a minimal scheduled worker for payment reconciliation and webhook replay.
- Job runs must be idempotent, observable, and safe to retry.

Health and metrics:

- Provide health checks for API, database, provider adapter health, background worker health, and webhook processing backlog.
- Provide metrics for request count, error count, latency, provider latency, passport verification latency, webhook processing latency, reconciliation lag, and audit write failures.
- Use OpenTelemetry/Prometheus or the existing codebase observability stack.

Pilot SLA targets:

- `/v1/commerce/payments/*`: 99.0% pilot availability.
- `POST /v1/commerce/payments/intents`: p95 under 500 ms excluding provider latency at 10 RPS.
- `POST /v1/commerce/catalog/search`: p95 under 300 ms at 50 RPS for pilot catalog size.
- `POST /v1/webhooks/providers/{provider_key}`: handle 5 webhook events/sec with p95 processing under 500 ms excluding provider verification latency.
- `POST /v1/commerce/passports/verify`: p95 under 100 ms for offline verification; payment-affecting online revocation checks may be slower but must be measured.

Migration, backup, and rollback:

- Migrations are forward-only and reviewed before deploy.
- Back up Postgres before production schema changes once live mode is enabled.
- Pilot target RPO is 15 minutes for commerce database once live mode is enabled.
- Rollback plan must keep old code compatible with newly added nullable columns and tables.
- Destructive migrations are not allowed in V1.

## 17. V1 Tests

Required:

- passport issue/verify/revoke tests;
- CommerceAgent registration and disabled-agent tests;
- CommerceAgent trust-status update tests;
- agent authentication tests;
- expired passport tests;
- revoked passport tests;
- not-before passport tests;
- passport version tests;
- JWT `alg=none`, algorithm downgrade, missing `kid`, unknown `kid`, and `kid` confusion rejection tests;
- JWKS endpoint availability and key rotation tests;
- amount cap tests;
- merchant mismatch tests;
- cross-tenant passport rejection tests;
- emergency disable tests;
- idempotency tests;
- idempotency outside-retention-window tests;
- rate-limit tests;
- trusted-proxy/forwarded-IP rate-limit tests;
- provider credential validation tests;
- provider credential encryption and plaintext-not-in-logs tests;
- webhook source secret rotation tests;
- payment state machine tests;
- AFA/OTP abandonment timeout test;
- payment reconciliation polling test;
- Plural mock adapter tests;
- mock provider deterministic success/decline/timeout/signature-failure/replay tests;
- Plural webhook signature/replay tests;
- inbound merchant webhook signature/replay tests;
- inbound merchant webhook schema validation tests;
- unsupported inbound event type test;
- audit write tests;
- audit table update/delete permission tests;
- multi-tenant isolation tests;
- product variant tests;
- stale-price-blocks-checkout tests;
- tenant_id presence tests for tenant-owned entities;
- GST/tax-inclusive amount tests;
- mass-assignment tests for PATCH endpoints;
- CSRF tests for consent approval/deny;
- clickjacking/header tests for consent UI;
- Sales Agent eval tests;
- end-to-end agent -> consent -> checkout -> webhook -> audit test.

Quality gate:

- no payment intent can be created without valid Commerce Passport;
- no protected action succeeds without audit record;
- no live provider action without feature flag;
- no route without tenant/auth checks.
- audit rows cannot be updated or deleted by the application database role.
- no provider credential is stored or logged in plaintext;
- no Commerce Passport verifies without pinned ES256 algorithm and known `kid`;
- no PATCH endpoint permits mutation of immutable ownership/security fields;
- OpenAPI 3.1 V1 document exists and matches implemented routes;
- tenant A passport cannot authorize tenant B action.

## 18. V1 Milestones

### Milestone 1: Foundations

Target: 2-3 weeks.

- schema;
- OpenAPI 3.1 skeleton and standard error envelope;
- feature flags;
- tenant boundary;
- merchant model;
- CommerceAgent model;
- product and variant models;
- remaining V1 commerce entity field lists and constraints;
- electronics preset;
- audit writer;
- database-level append-only audit permissions.

### Milestone 2: Passport

Target: 3-4 weeks.

- agent registration;
- consent request;
- consent UX;
- passport issue/verify/revoke;
- ES256 signing and JWKS;
- revocation check.

### Milestone 3: Policy

Target: 2-3 weeks.

- amount cap;
- scope allowlist;
- emergency disable;
- `CommercePolicy.rules` schema validation;
- policy activation;
- policy evaluation API.

### Milestone 4: Payment

Target: 4-5 weeks.

- mock provider;
- Plural sandbox provider;
- confirmed Plural webhook signature scheme or explicit blocked state;
- payment intent;
- checkout link;
- webhook handling;
- payment state machine;
- idempotency;
- AFA/OTP pending timeout;
- automated and manual reconciliation.

### Milestone 5: Agent And MCP

Target: 3-4 weeks.

- MCP tools;
- demo MCP client in playground;
- AgenticOrg Sales Agent;
- evals;
- end-to-end demo.

### Milestone 6: Hardening

Target: 3-4 weeks.

- tests;
- observability;
- audit views;
- docs;
- CSV column spec for product and variant import published in docs;
- sandbox playground;
- legal review notes.

### Milestone 7: Operational Pilot Hardening

Target: 2-3 weeks.

- basic SLA dashboard;
- on-call/runbook templates;
- stuck payment dashboard;
- webhook dead-letter/replay view;
- load test for pilot traffic: sustain 10 RPS on `POST /v1/commerce/payments/intents` with p95 under 500 ms excluding provider latency;
- load test for pilot catalog traffic: sustain 50 RPS on `POST /v1/commerce/catalog/search` with p95 under 300 ms for pilot catalog size;
- load test for provider webhooks: sustain 5 events/sec with idempotent processing and no duplicate payment transitions;
- first pilot merchant configuration;
- support ownership document.

## 19. First 10 Engineering Tasks

1. Add commerce feature flags and provider-neutral config.
2. Add V1 migrations/entities.
3. Add electronics category preset seed.
4. Add CommerceAgent registration and trust status.
5. Add audit event writer, database append-only grants, and event list API.
6. Add Commerce Passport issuance, verification, and revocation.
7. Add consent request and consent UI.
8. Add V1 policy evaluator and activation endpoint.
9. Add mock payment provider and payment state machine.
10. Add Plural sandbox provider adapter and E2E sandbox test: agent request -> consent -> checkout -> webhook -> audit.

## 20. Questions Before Live Payments

1. What exact Plural APIs are available for sandbox and live checkout/payment link creation?
2. What webhook signature scheme does Plural use? This must be answered before Milestone 4 Plural webhook completion.
3. What legal consent text is required for agent-created checkout in India?
4. Confirm exact final user confirmation copy and hosted checkout handoff language with Pine/Plural legal.
5. What RBI/AFA review is required before any delegated or semi-autonomous payment flow?
6. Confirm RBI data localization scope for Grantex Commerce as an authorization layer, and identify payment data fields requiring India residency.
7. What merchant onboarding/KYC data can be reused from Pine/Plural? Default assumption: re-collect or receive only with explicit data-sharing approval.
8. What refund capability should be considered for V2 after V1 proves checkout authorization?
9. What data can be shown in a public MCP catalog search without merchant/user authentication?
10. Confirm first pilot merchant and their actual catalog/payment setup.
11. Who owns production support between Grantex, AgenticOrg, merchant, and Plural?

## 21. V1 Sign-Off

V1 is ready when:

- OpenAPI 3.1 V1 contract exists and matches implementation.
- Merchant can onboard in sandbox.
- Merchant can configure and validate Plural sandbox credentials.
- Provider credential storage is encrypted and raw credentials are not logged or displayed after save.
- Product and variants can be added by dashboard, CSV, API, or complete-state inbound webhook.
- Product price supports tax-inclusive totals and GST/HSN metadata.
- CommerceAgent is registered and used in passport issuance.
- Agent can discover product via MCP.
- Agent API calls authenticate as registered `CommerceAgent`.
- Commerce Passport signing uses pinned ES256 and JWKS key rotation is tested.
- User can approve Commerce Passport.
- Agent can create checkout only with valid passport.
- Plural sandbox checkout works.
- Payment pending timeout and reconciliation work.
- Webhook updates payment status.
- Audit timeline proves every step.
- Audit table is database-level append-only.
- Revocation blocks new protected actions.
- Emergency disable blocks new protected actions.
- Sales Agent passes evals.
- Demo MCP client works in playground.
- First pilot merchant is named or internal test merchant is explicitly approved.
- Legal blocker list is documented before live mode.

V1 is not ready if:

- checkout works without consent;
- payment intent works without audit;
- provider code is hardcoded to Plural in core models;
- user revocation does not block protected actions;
- merchant emergency disable is delayed by cache TTL;
- dashboard-only flows exist without APIs;
- AgenticOrg calls payment provider directly.
- passport can be issued for an unknown or disabled agent;
- protected agent API calls work without agent authentication;
- same idempotency key with different body does not return `409`;
- audit rows can be updated or deleted by the application database role.
- tenant-owned records can be created without `tenant_id`;
- unsigned inbound merchant webhooks are accepted.
- live payment-related data is hosted outside India without legal approval.
- mutable PATCH endpoints can change `tenant_id`, ownership IDs, provider references, or audit fields.
- `alg=none`, algorithm downgrade, missing `kid`, or unknown `kid` JWTs verify successfully.
- OpenAPI contract is missing or materially out of sync with implemented routes.

## 22. First Pilot

V1 must name the first pilot before Milestone 4 begins.

Acceptable pilot options:

- a real Pine/Plural electronics merchant;
- an internal Pine/Plural test merchant configured like an electronics retailer;
- an AgenticOrg demo merchant with Plural sandbox credentials.

Pilot profile must include:

- merchant legal/display name;
- Plural sandbox account;
- 10-25 electronics products;
- at least 3 products with variants;
- tax-inclusive pricing;
- GST/HSN metadata;
- availability status;
- return/warranty summaries;
- one approved Sales Agent identity;
- named merchant operator for feedback.
- named merchant technical lead.
- weekly feedback cadence during pilot.

V1 should not be considered pilot-ready without this setup.
