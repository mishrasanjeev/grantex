---
name: grantex-commerce-enterprise-implementation
description: Enterprise implementation guardrails for Grantex Commerce V1 across grantex.dev and agenticorg.ai. Use when reviewing, planning, implementing, testing, or signing off Grantex Commerce, agentic commerce, merchant AI-native onboarding, MCP/UCP/ACP publishing, merchant catalog/inventory/pricing, Commerce Passports, Plural payments, webhooks, APIs, database models, UI/UX, retries, observability, release gates, or production hardening from GRANTEX_COMMERCE_V1_BUILD_SPEC.md.
effort: max
---

# Grantex Commerce Enterprise Implementation

Use this skill to implement Grantex Commerce V1 as a finished pilot-production product, not as a demo, proof of concept, thin MCP wrapper, or payment-link prototype.

The implementation source of truth is `GRANTEX_COMMERCE_V1_BUILD_SPEC.md`. The master context file is `GRANTEX_COMMERCE_PRD.md`. Read the V1 build spec before changing code. Use the master PRD only for strategic context and future compatibility.

## Non-Negotiable Product Boundary

Build V1 around this claim:

> An AI agent can initiate a commerce checkout through a payment provider only when Grantex can verify user consent, scope, merchant policy, revocation status, tenant boundary, agent identity, and audit evidence.

Do not expand V1 into the full master PRD. Do not silently drop any V1 requirement. If a requirement cannot be implemented because an external API, credential, legal approval, or codebase dependency is missing, build the provider-neutral abstraction, mock/sandbox path, feature flag, tests, and explicit blocker.

## Repo Ownership

When working in `grantex.dev`, own:

- merchant onboarding and control plane;
- commerce data models and migrations;
- catalog, variant, inventory, pricing, and import APIs;
- provider credential setup and validation;
- inbound merchant webhook source management;
- CommerceAgent registry and authentication;
- Commerce Passport consent, issuance, verification, revocation, and JWKS;
- policy engine;
- cart and checkout/payment intent APIs;
- Plural sandbox adapter behind provider-neutral interface;
- Plural webhook handling and payment reconciliation;
- MCP-compatible publishing layer and demo MCP client;
- audit ledger, metering, observability, tests, and release gates.

When working in `agenticorg.ai`, own:

- merchant commerce Sales Agent pack;
- workflows that call Grantex tools only;
- agent authentication against Grantex;
- demo flows and evals;
- refusal behavior for missing consent, stale inventory, unsupported offers, disabled merchants, and policy denial.

AgenticOrg must not duplicate Grantex-owned commerce infrastructure. AgenticOrg must not hold Plural credentials or call Plural directly.

## First Operating Rule

Before implementation:

1. Read `GRANTEX_COMMERCE_V1_BUILD_SPEC.md`.
2. Read the codebase's existing auth, database, API, routing, background job, frontend, test, observability, and configuration patterns.
3. Map every V1 requirement to existing modules or new modules.
4. Create a task plan ordered by dependency.
5. Implement in vertical slices that can be tested end to end.

Do not implement from memory. Do not hand-roll patterns that the codebase already has.

## Anti-Shortcut Protocol

Before editing files, create a traceability matrix in the working notes or implementation plan with:

- V1 build spec section;
- requirement summary;
- owning repo: `grantex.dev`, `agenticorg.ai`, or external blocker;
- implementation files/modules;
- migration or schema impact;
- API/UI impact;
- test coverage;
- release-gate evidence;
- status: not started, implemented, tested, blocked, or deferred by explicit V1 scope.

Before writing migrations or endpoints, verify the V1 spec has contract-level definitions for:

- provider interface signatures and normalized provider errors;
- all required entity field lists, indexes, relationships, and constraints;
- API authentication schemes for dashboard, merchant API, agent API, and internal jobs;
- Commerce Passport JWT algorithm, JWKS endpoint, `kid` rotation, and clock skew;
- `CommercePolicy.rules` schema;
- endpoint request/response/error contracts and OpenAPI location;
- MCP tool input/output schemas and required scopes;
- webhook envelope, signature scheme, replay window, and idempotency;
- PATCH mutable field allowlists;
- rate-limit source IP trust rules;
- security, secrets, logging, operations, backup, rollback, and SLA gates.

If any of these are missing or contradicted by the codebase, stop and update the implementation plan or spec before coding. Do not infer critical security/payment contracts silently.

Do not mark a requirement complete unless implementation and test evidence exist. If a requirement is intentionally not implemented, label it with one of:

- out of V1 scope according to the build spec;
- blocked by missing external credential/API/legal approval;
- not applicable to this repo because owned by the other repo.

Never use these as completion substitutes:

- TODO comments;
- placeholder UI;
- mocked success without a real mock-provider contract;
- untested endpoint stubs;
- dashboard-only implementation without API;
- API-only implementation for a required dashboard workflow;
- provider-specific shortcut in core models;
- happy-path-only tests;
- manual verification where an automated test is practical.

If the implementation becomes too large for one session, stop only at a clean vertical boundary and leave a machine-readable continuation checklist with completed, pending, blocked, and verified items.

## Definition Of Done Per Requirement

For every feature, all applicable layers must be done:

- schema or persistence;
- validation;
- auth and tenant boundary;
- business policy;
- API endpoint or MCP tool;
- UI workflow if merchant/operator-facing;
- webhook/background job if event-driven;
- audit event;
- observability/logging;
- automated tests;
- documentation or inline admin help where needed;
- release-gate entry.

A feature is incomplete if any required layer is missing and not explicitly marked as blocked or out of scope.

## Architecture Rules

- Keep Plural behind `PaymentProvider` or equivalent neutral interface.
- Implement `MockPaymentProvider` for local tests and deterministic E2E.
- Implement `PluralPaymentProvider` for sandbox; live mode stays feature-flagged.
- Do not put Plural-specific fields into core tables except under namespaced provider metadata or explicit neutral provider reference fields.
- Every UI flow must have an equivalent API.
- Every payment-affecting action must require a valid checkout Commerce Passport.
- Creating a pre-consent cart draft may be allowed for an authenticated registered `CommerceAgent`; checkout/payment still requires a valid user-bound checkout passport.
- Every protected action must write audit evidence.
- Every tenant-owned query must filter by `tenant_id`.
- Every tenant-owned row must include `tenant_id`.
- Prefer existing framework primitives for validation, auth, migrations, queues, forms, tests, and telemetry.
- Do not store raw card/payment credentials.
- Do not claim certified UCP, ACP, AP2, MPP, or A2A compliance in V1.

## Data Model Requirements

Implement the V1 entity set only:

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

Every tenant-owned table must include:

- `tenant_id`
- `created_at`
- `updated_at` where mutable
- stable primary key
- indexes for tenant-scoped listing and lookup

Use database constraints for invariants that must never be bypassed:

- required tenant ownership;
- merchant ownership;
- product/variant SKU uniqueness within merchant/tenant as appropriate;
- payment status enum/state machine;
- idempotency key uniqueness by merchant, endpoint, environment;
- webhook event ID uniqueness by merchant/source/provider;
- active policy version uniqueness per merchant when applicable;
- passport `jti` uniqueness;
- not-null required commerce fields;
- foreign keys for merchant, tenant, cart, passport, agent, product, and payment references.

Audit table rules:

- append-only at database permission level;
- app role has `INSERT` and `SELECT` only;
- no app-level `UPDATE` or `DELETE`;
- corrections are compensating events;
- dashboard must not expose audit mutation controls.

Product deletion:

- implement soft-delete/archive;
- never hard-delete product or variant rows referenced by carts, payment intents, audit events, or webhooks.

## Merchant Data Requirements

Support all V1 merchant data paths:

- dashboard manual product entry;
- CSV upload with documented columns;
- REST upsert APIs;
- complete-state inbound merchant webhook for `catalog.product.updated`.

Required product/variant fields include:

- product ID;
- title;
- brand;
- description;
- image URL;
- category/preset;
- variant ID;
- SKU;
- parent SKU;
- model;
- variant title;
- attributes;
- price amount;
- currency;
- tax-inclusive flag;
- GST slab or tax rate;
- HSN code;
- availability status;
- warranty summary;
- return policy summary;
- source system;
- last synced timestamp.

V1 must support products with variants. A product with no visible variant grouping still needs one purchasable variant.

Do not silently update active payment intent amounts when catalog price changes. If a new price exceeds passport `max_amount`, require fresh consent before creating a new checkout link.

## Agent Identity And Commerce Passport

Agents must authenticate as registered `CommerceAgent` identities. V1 may support:

- signed JWT bearer assertions using `public_key_jwk`; or
- agent API key bound to `CommerceAgent`.

Record agent auth method on consent, passport, cart, payment, and audit events.

Agent authentication is not user consent. Checkout/payment requires a valid checkout Commerce Passport.

Commerce Passport must include or enforce:

- `iss`
- `sub`
- `aud`
- `tenant_id`
- `merchant_id`
- `agent_id`
- `scope`
- `max_amount`
- `currency`
- `iat`
- `nbf`
- `exp`
- `jti`
- `ver`

Default scope bundles:

- `browse`: `commerce:catalog.read`, `commerce:inventory.read`
- `checkout`: `commerce:catalog.read`, `commerce:inventory.read`, `commerce:checkout.create`, `commerce:payment.initiate`, `commerce:payment.status.read`

Default expiry:

- browse: 60 minutes;
- checkout: 10 minutes.

Payment-affecting actions require online revocation check. Merchant emergency disable must block protected actions immediately.

## Policy Engine

Policy evaluation must cover at least:

- merchant match;
- tenant match;
- agent status;
- agent trust status;
- scope allowlist;
- amount cap;
- currency;
- emergency disable;
- passport expiry;
- passport revocation;
- category/product constraints where implemented;
- sandbox/live environment mismatch.

Policy decisions:

- `allow`
- `deny`
- `requires_user_consent`

Audit `policy.evaluated` when decision is `deny` or `requires_user_consent`. For `allow`, include policy version and decision reference on the resulting action audit event.

## REST API Contract

Implement these V1 routes unless the codebase has an established versioning convention that requires a documented equivalent path.

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

Audit:

- `GET /v1/commerce/audit/events`

Well-known and MCP:

- `GET /.well-known/grantex-commerce`
- MCP streamable HTTP endpoint at `/mcp`

Inbound merchant webhooks:

- `POST /v1/webhooks/merchant/{merchant_id}/{source_key}`

Inbound webhook sources:

- `POST /v1/commerce/webhook-sources`
- `GET /v1/commerce/webhook-sources`
- `PATCH /v1/commerce/webhook-sources/{source_key}`
- `POST /v1/commerce/webhook-sources/{source_key}/rotate-secret`

For every route:

- enforce auth and tenant boundary;
- validate request body with structured schema;
- return consistent error codes and error shapes;
- write audit events for protected actions;
- include tests for success, validation failure, unauthorized, forbidden, tenant mismatch, disabled merchant/agent, and idempotency where applicable.

## Idempotency, Retries, And Reconciliation

Require `Idempotency-Key` for:

- `POST /v1/commerce/payments/intents`
- `POST /v1/commerce/payments/intents/{id}/checkout-link`
- `POST /v1/commerce/carts`

Rules:

- key scope is merchant, endpoint, and environment;
- same key plus same body returns original response;
- same key plus different body returns HTTP `409`;
- records persist at least 24 hours;
- idempotency conflicts are audited.

Retries:

- retry transient provider/network failures with bounded exponential backoff and jitter;
- do not retry validation, auth, policy, amount-cap, consent, or tenant errors;
- make webhook handling idempotent;
- make background reconciliation idempotent;
- persist retry attempts and final failure reasons;
- never double-create provider payments from retried requests.

Reconciliation:

- payment intents older than 2 minutes in `payment_pending` must reconcile by provider status lookup;
- dashboard must expose manual "reconcile now" for stuck intents;
- reconciliation must write audit evidence.

## Payment State Machine

Implement explicit allowed transitions:

- `created` -> `authorized`
- `authorized` -> `checkout_created`
- `checkout_created` -> `payment_pending`
- `payment_pending` -> `paid`
- `payment_pending` -> `failed`
- `payment_pending` -> `expired`
- `created|authorized|checkout_created|payment_pending` -> `cancelled`

Reject and audit invalid transitions.

AFA/OTP behavior:

- hosted checkout or bank authorization keeps status as `payment_pending`;
- successful provider webhook or reconciliation transitions to `paid`;
- provider failure transitions to `failed`;
- abandonment timeout transitions to `expired`;
- live V1 payment requires final user confirmation;
- autonomous delegated payment is not allowed in V1.

## Webhook Requirements

Plural webhook:

- verify signature;
- reject replay;
- store raw payload or safe hashed/reference form according to data policy;
- idempotently process provider event ID;
- update payment state only through allowed transitions;
- audit received, signature failure, status update, and ignored duplicate.

Merchant inbound webhook:

- support only `catalog.product.updated` in V1;
- require merchant/source-specific secret;
- require event ID, event type, occurred-at timestamp, source key, and payload version;
- reject unsigned events;
- reject timestamps outside replay window, default 5 minutes;
- idempotently process repeated event IDs;
- store failed events for dashboard visibility and manual replay;
- return explicit `unsupported_event_type` for all other event types.

Outbound Grantex webhooks are not V1. Agents poll `payment.get_status`; merchants use dashboard or `GET /v1/commerce/payments/intents/{id}`.

## MCP And Protocol Publishing

Publish:

- `GET /.well-known/grantex-commerce`
- MCP streamable HTTP endpoint at `/mcp`

MCP tools:

- `merchant.get_profile`
- `catalog.search`
- `catalog.get_item`
- `inventory.check`
- `cart.create`
- `checkout.create`
- `payment.create_intent`
- `payment.get_status`

Rules:

- well-known profile must list supported tools, auth requirements, scopes, environment, merchant identity, and MCP transport URL;
- use current MCP streamable HTTP transport;
- SSE is not supported in V1;
- protect tool calls with agent auth and passport checks as required;
- implement a demo MCP client in Grantex playground;
- do not claim full UCP/ACP/AP2/MPP/A2A certification.

## Merchant Dashboard UI/UX

Build usable operator workflows, not placeholder pages.

Routes:

- `/dashboard/commerce/onboarding`
- `/dashboard/commerce/passports`
- `/dashboard/commerce/payments`
- `/dashboard/commerce/audit`
- `/dashboard/commerce/settings`
- `/dashboard/commerce/playground`

Required dashboard capabilities:

- create merchant;
- select electronics category preset;
- configure Plural sandbox credentials;
- validate provider credentials;
- configure webhook sources and rotate source secrets;
- add product manually;
- upload product CSV;
- view product variants, tax, GST/HSN, availability, warranty, return summary;
- configure amount cap and emergency disable;
- view passports and revocation state;
- view payment attempts and status timeline;
- trigger manual reconciliation for stuck payment intents;
- view audit timeline;
- run sandbox agent/MCP demo.

UI quality bar:

- responsive desktop and mobile layouts;
- accessible forms, labels, focus states, keyboard navigation, and screen reader text;
- clear empty, loading, error, success, disabled, and pending states;
- no text overflow in buttons, cards, tables, or dialogs;
- destructive actions require confirmation;
- live/sandbox/test merchants are visibly marked;
- provider secrets are never displayed after save;
- validation errors identify exact fields;
- all dashboard flows call the same APIs external integrators can call.

## AgenticOrg Requirements

Implement `commerce-sales-agent` with workflows for:

- product discovery;
- product Q&A from Grantex tool data;
- cart draft creation;
- consent request;
- checkout/payment intent creation through Grantex tools.

Agent behavior:

- no checkout without consent;
- no amount above passport cap;
- no unsupported offer claims;
- no guaranteed inventory when status is `unknown`;
- no direct payment provider calls;
- no direct provider credential handling;
- no hallucinated EMI, discount, availability, warranty, tax, or return policy.

Agent evals must prove refusals and safe behavior for denied consent, missing consent, stale inventory, disabled merchant, disabled agent, amount cap breach, unsupported offer, and payment status polling.

## Observability And Operations

Add structured logs, metrics, and traces for:

- request ID;
- tenant ID;
- merchant ID;
- agent ID;
- passport `jti`;
- cart ID;
- payment intent ID;
- provider reference ID;
- webhook event ID;
- policy version;
- idempotency key hash;
- error code.

Never log secrets, raw credentials, raw card details, or sensitive authentication material.

Operational hardening:

- background jobs for reconciliation and webhook retry/replay;
- dead-letter or failed-event view for webhooks;
- stuck payment dashboard;
- runbook notes for provider outage, webhook backlog, reconciliation failure, audit write failure, and emergency disable;
- load test target: sustain 10 RPS on payment intent creation with p95 under 500 ms excluding provider latency.

## Security, Privacy, And Regulatory Gates

Implement:

- encrypted storage for provider credentials;
- secret rotation for webhook sources;
- CSRF protection on consent approval/deny;
- frame-busting headers on consent page;
- Content Security Policy on consent page;
- signed webhooks and replay defense;
- rate limits from the V1 build spec;
- tenant isolation tests;
- sandbox/live separation;
- feature flag for live Plural mode.

India live mode:

- no live payment without legal approval;
- no autonomous delegated payment in V1;
- every live payment requires final user confirmation;
- payment-related data must be India-resident unless legal review explicitly approves otherwise;
- document legal blockers before enabling live mode.

## Required Tests

Add or update tests for:

- passport issue, verify, revoke;
- CommerceAgent registration and disabled-agent behavior;
- CommerceAgent trust-status updates;
- agent authentication;
- expired passport;
- revoked passport;
- not-before passport;
- passport version;
- JWT `alg=none`, algorithm downgrade, missing `kid`, unknown `kid`, and `kid` confusion rejection;
- JWKS endpoint availability and key rotation;
- amount cap;
- merchant mismatch;
- cross-tenant passport rejection;
- emergency disable;
- idempotency;
- idempotency outside-retention-window behavior;
- rate limits;
- trusted-proxy/forwarded-IP rate-limit behavior;
- provider credential validation;
- provider credential encryption and plaintext-not-in-logs;
- webhook source secret rotation;
- payment state machine;
- AFA/OTP abandonment timeout;
- payment reconciliation polling;
- mock payment provider;
- Plural sandbox adapter or mocked Plural contract;
- Plural webhook signature and replay;
- inbound merchant webhook signature and replay;
- inbound merchant webhook schema validation;
- unsupported inbound event type;
- audit write;
- audit table update/delete permission denial;
- multi-tenant isolation;
- product variants;
- stale-price-blocks-checkout behavior;
- tenant ID presence for all tenant-owned entities;
- GST/tax-inclusive amounts;
- mass-assignment on PATCH endpoints;
- CSRF protection for consent approval/deny;
- clickjacking/frame-header protection for consent UI;
- Sales Agent evals;
- end-to-end agent -> consent -> checkout -> webhook -> audit.

No route is complete without tests for auth, tenant boundary, validation failure, and happy path.

Testing discipline:

- Run the smallest relevant test while implementing each slice.
- Run the full affected backend test suite before sign-off.
- Run the full affected frontend test suite before sign-off.
- Run lint/typecheck/build commands used by the repo before sign-off.
- For UI changes, verify responsive behavior, empty/loading/error/success states, and form validation.
- For payment/webhook changes, include deterministic replay, duplicate, invalid signature, stale timestamp, and invalid transition tests.
- For tenant isolation, include cross-tenant negative tests, not only same-tenant happy path.
- For release sign-off, produce a command log summary with pass/fail status and unresolved failures.

Do not ignore failing tests. Fix them or clearly identify them as unrelated pre-existing failures with evidence.

## Release Gate

Do not call the work done unless all are true:

- OpenAPI 3.1 V1 contract exists and matches implementation;
- merchant can onboard in sandbox;
- merchant can configure and validate Plural sandbox credentials;
- provider credential storage is encrypted and raw credentials are not logged or displayed after save;
- products and variants can be added by dashboard, CSV, API, and complete-state inbound webhook;
- product price supports tax-inclusive totals and GST/HSN metadata;
- CommerceAgent is registered and used in passport issuance;
- agent API calls authenticate as registered `CommerceAgent`;
- agent can discover product via MCP;
- Commerce Passport signing uses pinned ES256 and JWKS key rotation is tested;
- user can approve Commerce Passport;
- agent can create checkout only with valid passport;
- Plural sandbox checkout works or a contract-compatible mock is explicitly used while sandbox access is blocked;
- payment pending timeout and reconciliation work;
- webhook updates payment status;
- audit timeline proves every step;
- audit table is database-level append-only;
- revocation blocks new protected actions;
- emergency disable blocks new protected actions immediately;
- Sales Agent passes evals;
- demo MCP client works in playground;
- first pilot merchant is named or internal test merchant is explicitly approved;
- legal blocker list is documented before live mode.

V1 is not ready if:

- checkout works without consent;
- payment intent works without audit;
- provider code is hardcoded to Plural in core models;
- user revocation does not block protected actions;
- merchant emergency disable is delayed by cache TTL;
- dashboard-only flows exist without APIs;
- AgenticOrg calls payment provider directly;
- passport can be issued for an unknown or disabled agent;
- protected agent API calls work without agent authentication;
- same idempotency key with different body does not return `409`;
- audit rows can be updated or deleted by the application database role;
- tenant-owned records can be created without `tenant_id`;
- unsigned inbound merchant webhooks are accepted;
- live payment-related data is hosted outside India without legal approval.

## Implementation Review Pass

Before final answer or handoff, perform a self-review in this order:

1. Re-read the V1 build spec sign-off and not-ready sections.
2. Compare implemented files against the traceability matrix.
3. Search the codebase for TODO, FIXME, placeholder, mock-only, hardcoded tenant, hardcoded merchant, hardcoded Plural, missing tenant filters, and unsafe logging in touched modules.
4. Inspect every new route for auth, tenant scoping, validation, rate limiting where required, and error shape consistency.
5. Inspect every payment-affecting flow for passport verification, policy evaluation, revocation check, idempotency, state-machine enforcement, and audit event.
6. Inspect every webhook for signature verification, replay defense, idempotency, error persistence, and audit event.
7. Inspect every merchant dashboard workflow for API equivalence.
8. Confirm no AgenticOrg code handles payment provider credentials or calls Plural directly.
9. Confirm tests cover negative cases, not only the happy path.
10. Confirm live mode remains feature-flagged and legal blockers are documented.

If any item fails, do not claim completion. Continue fixing or mark the exact blocker.

## Human Review Gates

Require explicit human review before merge for these high-risk areas:

- first commerce schema migration, especially tenant ownership, foreign keys, indexes, uniqueness, and append-only audit permissions;
- JWT/JWKS verification code, especially ES256 pinning, `kid` handling, clock skew, revocation checks, and rejection of `alg=none` or algorithm-confusion attacks;
- consent screen security, especially CSP, `X-Frame-Options`, CSRF model, single-use approval/deny, and absence of unsafe inline script/style unless the existing framework has a reviewed nonce pattern;
- webhook signature verification, especially raw-body handling, replay window, event idempotency, and timing-safe signature comparison;
- Plural adapter after Pine/Plural confirms the real API and webhook signature scheme.

Do not self-approve these gates. If human review is unavailable, mark the release gate as blocked and explain the risk.

## Handoff Evidence Pack

Final handoff must include:

- requirements completed;
- requirements not applicable to this repo;
- requirements blocked and why;
- files changed;
- migrations added;
- API endpoints implemented;
- MCP tools implemented;
- webhooks implemented;
- dashboard routes implemented;
- tests added;
- commands run and results;
- known external dependencies;
- release gate pass/fail table.

Do not give a vague "implemented successfully" response without evidence.

## Final Implementation Discipline

When uncertain:

- prefer the V1 build spec over the master PRD;
- prefer codebase patterns over new abstractions;
- prefer explicit feature flags over hidden behavior;
- prefer provider-neutral interfaces over Plural coupling;
- prefer failing closed over permissive commerce actions;
- prefer auditability over convenience;
- prefer complete negative tests over optimistic happy-path demos.

Before final response, report:

- files changed;
- migrations added;
- APIs implemented;
- UI routes implemented;
- tests run and results;
- known blockers;
- release gate status.
