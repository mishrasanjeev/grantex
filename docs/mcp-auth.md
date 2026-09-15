---
title: "MCP Auth 3.0: deployment and consent page"
description: "Deploying @grantex/mcp-auth 3.0 with Postgres or Redis, configuring it against the MCP authorization specification, customising the consent page and migrating from 2.x."
---

# `@grantex/mcp-auth` 3.0

> **Status.** Version 3.0.0 is prepared in the repository and **not yet
> published to npm**. The current published release is
> `@grantex/mcp-auth@2.0.2`; its behaviour is described in the
> [MCP Auth Server guide](/features/mcp-auth-server). Everything below
> describes 3.0.0 as built from source.

`@grantex/mcp-auth` puts an OAuth 2.1 authorization server in front of an MCP
server and hands the actual grant to Grantex. 3.0 is built for production:

- **Durable state.** Clients, consent records, pending authorizations,
  authorization codes with their PKCE challenges, refresh-token bindings and
  revocations live in Postgres or Redis, so a restart or a second replica
  loses nothing.
- **The current MCP authorization specification** (2026-07-28): protected
  resource metadata (RFC 9728), resource indicators with audience binding
  (RFC 8707), PKCE S256 only, `iss` in authorization responses (RFC 9207),
  and OAuth Client ID Metadata Documents. A conformance suite maps each
  server-side MUST of the specification, plus the Security Best Practices'
  confused-deputy requirements (consent and callback bound to the approving
  browser, CSRF-protected consent), to a test.
- **A rendered consent page** that shows purpose, tools, caps, data region and
  duration before anything reaches Grantex.
- **Tools refused at the MCP server**, not merely hidden from `tools/list`,
  with scopes derived from Grantex tool manifests and a `decision_required`
  challenge for actions a person must approve.

## How a request flows

1. An MCP client calls your MCP server without a token and receives `401`
   with `WWW-Authenticate: Bearer resource_metadata="…"`.
2. It reads the protected-resource metadata, then this server's
   authorization-server metadata.
3. It sends the user to `/authorize` with PKCE (S256) and `resource`. The
   client is either registered (dynamic registration or pre-registered) or
   identified by an https metadata-document URL.
4. `/authorize` validates the request and renders the **consent page**.
5. The Principal approves; only then does the server ask Grantex to
   authorize the grant, with the resource as its audience, and it sets a
   callback-binding cookie on that browser. The Principal may confirm again
   in Grantex.
6. Grantex redirects to `/callback`. Only if the browser presents the
   callback-binding cookie does the server issue a single-use code to the
   client's redirect URI with `iss`.
7. The client redeems the code at `/token` (PKCE verifier, optional
   `resource`); the server exchanges the upstream code and returns the grant
   token only if its audience is the requested resource.
8. The MCP server's `requireMcpAuth` verifies every request's token
   (signature, issuer, audience, revocation) and refuses any `tools/call` the
   grant does not cover.

## Install

Until 3.0.0 is published, build it from the repository:

```bash
git clone https://github.com/mishrasanjeev/grantex
cd grantex/packages/mcp-auth
npm ci && npm run build && npm pack
```

Install the resulting tarball with `@grantex/sdk` and the database driver you
use (`pg` or `postgres`, or `ioredis`). The drivers are not dependencies of
the package; the storage classes accept any compatible client.

## Deploying with Postgres

<!-- snippet: packages/mcp-auth/tests/docs/examples/postgres-storage.ts -->
```typescript
import pg from 'pg';
import { PostgresStorage, runMigrations } from '@grantex/mcp-auth/postgres';

export async function openPostgresStorage(databaseUrl: string) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });

  // Idempotent and serialised by an advisory lock, so every replica can run
  // it at start-up.
  await runMigrations(pool);

  const storage = new PostgresStorage({ db: pool });

  // Expired rows are already invisible to every read; purging bounds table size.
  const purge = setInterval(() => {
    storage.purgeExpired().catch((err: unknown) => console.error('mcp-auth purge failed', err));
  }, 5 * 60_000);
  purge.unref();

  return {
    storage,
    async close() {
      clearInterval(purge);
      await pool.end();
    },
  };
}
```

- **Migrations** ship in `migrations/` (`001_mcp_auth_state.sql`). They are
  forward-only; `runMigrations()` applies each file once, in name order, in
  one transaction under an advisory lock, and records it in
  `mcp_auth_schema_migrations`. To use your own migration tool, apply the
  same files in name order and record them the same way.
- **Tables:** `mcp_auth_clients`, `mcp_auth_pending_authorizations`,
  `mcp_auth_authorization_codes`, `mcp_auth_refresh_token_bindings`,
  `mcp_auth_consents`, `mcp_auth_revocations`. Put them in a dedicated
  schema with the connection's `search_path` if you share a database.
- **Secrets at rest:** codes, refresh tokens, consent ids and pending
  authorization ids are stored only as SHA-256 keys, and client secrets only
  as hashes. The `record` column holds binding data in clear JSON (client,
  redirect URI, PKCE challenge, scopes, resource) and, for an issued code,
  the upstream Grantex code for up to `codeExpirationSeconds`. That code is a
  single-use credential: restrict access to the tables and their backups.
- **Single use** is enforced with `DELETE … RETURNING`: of any number of
  concurrent redemptions of one code, exactly one succeeds.
- `postgres` (postgres.js) works through `fromPostgresJs(sql)`.

## Deploying with Redis

<!-- snippet: packages/mcp-auth/tests/docs/examples/redis-storage.ts -->
```typescript
import { Redis } from 'ioredis';
import { RedisStorage, fromIoredis } from '@grantex/mcp-auth/redis';

export function openRedisStorage(redisUrl: string, keyPrefix = 'grantex:mcp-auth:') {
  // Redis 6.2 or later, with AOF or RDB persistence so client registrations
  // (stored without a TTL) survive a Redis restart.
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 2 });
  const storage = new RedisStorage({ redis: fromIoredis(redis), keyPrefix });

  return {
    storage,
    async close() {
      await redis.quit();
    },
  };
}
```

- Requires Redis 6.2 or later (`GETDEL`). Expiring records carry a matching
  `PX` TTL; the refresh-token take runs as a Lua script.
- Client registrations have no TTL: enable AOF or RDB persistence, or
  registered clients disappear with a Redis restart.
- Use a distinct `keyPrefix` per deployment when sharing an instance.
- node-redis works with `{ send: (command, args) => client.sendCommand([command, ...args]) }`.

## Operating it

- **Replicas.** Any number of processes can share one storage. Rate limits
  are per process (10/min for `/authorize`, 20/min for `/token`, `/consent`,
  `/introspect`, `/revoke`, 100/min otherwise); enforce global limits at
  your proxy.
- **TLS and proxies.** `issuer` must be the public https origin (http is
  accepted only for localhost). The consent form checks `Origin` against it,
  so a proxy must preserve the browser's `Origin` and `Sec-Fetch-Site`
  headers.
- **Grantex callback.** Register `{issuer}/callback` (or `callbackUrl`) as a
  redirect URI on the Grantex agent.
- **Storage failures** refuse requests (500 at the authorization server, 503
  from `requireMcpAuth` when revocation state is unreadable); they never
  grant access.
- **`InMemoryStorage`** (`@grantex/mcp-auth/testing`) is for tests and refuses
  to start with `NODE_ENV=production`.

## Configuring the authorization server

<!-- snippet: packages/mcp-auth/tests/docs/examples/auth-server.ts -->
```typescript
import type { Grantex } from '@grantex/sdk';
import { createMcpAuthServer } from '@grantex/mcp-auth';
import type { LoadedManifest, McpAuthStorage } from '@grantex/mcp-auth';

export async function startAuthServer(options: {
  grantex: Grantex;
  storage: McpAuthStorage;
  manifest: LoadedManifest;
}) {
  return createMcpAuthServer({
    grantex: options.grantex,
    agentId: 'ag_acme_kyb_tools',
    storage: options.storage,

    // This authorization server, and the MCP server its tokens are for.
    issuer: 'https://auth.acme.example.com',
    resource: 'https://mcp.acme.example.com/mcp',
    resourceName: 'Acme KYB tools',
    grantexIssuer: 'https://grantex.dev',

    // scopes_supported and the consent page's tool list come from the manifest.
    manifests: [options.manifest],

    // What the grant is for, shown on the consent page.
    grant: {
      purpose: 'aml.cdd.onboarding',
      purposeDescription: 'Business onboarding checks for new applicants',
      dataRegion: 'eu',
      duration: '8h',
    },

    consentUi: {
      appName: 'Acme Compliance',
      privacyUrl: 'https://acme.example.com/privacy',
      termsUrl: 'https://acme.example.com/terms',
    },
    consentPage: {
      theme: { accentColor: '#0b6e4f', radiusPx: 6 },
      text: { title: 'Allow case tools?', approve: 'Allow access' },
    },

    // Only accept metadata-document clients served from these hosts.
    clientIdMetadataDocuments: { allowedHosts: ['*.acme.example.com'] },
  });
}
```

| Option | Required | Meaning |
|---|---|---|
| `grantex`, `agentId` | yes | Grantex SDK client and the agent grants are requested for. |
| `storage` | yes | `PostgresStorage`, `RedisStorage` or your own `McpAuthStorage`. |
| `issuer` | yes | Public https URL of this server. No query or fragment. |
| `resource` | yes, or `allowedResources` | Canonical URI of the MCP server. Every grant is audience-bound to the requested resource; anything else is `invalid_target`. |
| `allowedResources` | no | Further accepted resources. With more than one, clients must send `resource`. |
| `scopes` | yes, or `manifests` | Scopes clients may request; others are `invalid_scope`. |
| `manifests` | no | Grantex tool manifests (0.5 or 0.6 JSON). Adds `tool:<connector>:<permission>` scopes and lists tools on the consent page. |
| `grantexIssuer`, `jwksUri`, `audience` | for `/introspect`, `/revoke` | Issuer of grant tokens, its JWKS, and the audience to require (defaults to the accepted resources). |
| `grant` | no | `purpose`, `purposeDescription`, `dataRegion`, `duration` (sent as `expiresIn`), `authorizeParams`. |
| `consentUi` | no | `appName`, and https `appLogo`, `privacyUrl`, `termsUrl`. |
| `consentPage` | no | Theme, text, `lang`, `extraCss`, `renderDetails`, `expiresInSeconds` (60–3600). |
| `clientIdMetadataDocuments` | no | `enabled` (default true), `allowedHosts`, `allowedPorts` (`[443]`), `timeoutMs` (5000), `maxBytes` (16384), `cacheTtlSeconds` (300), `maxCacheTtlSeconds` (86400). |
| `resourceName`, `resourceDocumentation` | no | Published in protected-resource metadata. |
| `callbackUrl`, `callbackPath` | no | Upstream consent callback (default `{issuer}/callback`). |
| `codeExpirationSeconds` | no | Authorization code and pending authorization lifetime (600). |
| `sandboxAutoApprove` | no | Accept a Grantex sandbox auto-approval after local consent. Off by default. |
| `hooks.onRevocation` | no | Called after a revocation is recorded. |

### Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /.well-known/oauth-authorization-server` | RFC 8414 metadata (also at `/.well-known/oauth-authorization-server/<issuer path>`). |
| `GET /.well-known/oauth-protected-resource/<resource path>` | RFC 9728 metadata for each accepted resource (and at the root when there is one). |
| `POST /register` | Dynamic client registration (https or loopback redirect URIs; `grant_types` `authorization_code` with optional `refresh_token`; `client_name` up to 200 characters). |
| `GET /authorize` | Validates the request and renders the consent page. |
| `POST /consent` | Consent form submission; answers 303. |
| `GET /callback` | Upstream consent callback; issues a code only to the browser holding the callback-binding cookie. |
| `POST /token` | `authorization_code` and `refresh_token` grants. |
| `POST /introspect`, `POST /revoke` | RFC 7662 and RFC 7009, backed by stored revocations; `/revoke` also revokes refresh tokens bound to the client. |

## Clients

- **Client ID Metadata Documents** (preferred by the specification). The
  client uses an https URL as `client_id`. The server fetches it with SSRF
  protections: only port 443 unless `allowedPorts` says otherwise; every
  address the host resolves to must be public (loopback, private,
  link-local, carrier-grade NAT, multicast, documentation, AS112, AMT,
  NAT64, 6to4 and IPv4-mapped ranges are refused) and the connection is
  pinned to the vetted address; redirects are not followed; the body is limited in
  size and time; the document must name its own URL as `client_id`, carry
  `client_name` and https or loopback `redirect_uris`, and use
  `token_endpoint_auth_method: none`. Results are cached per
  `Cache-Control`. Any failure is `invalid_client` with a reason code, never
  a redirect. Restrict hosts with `allowedHosts`.
- **Dynamic registration** (`POST /register`) remains for older clients. The
  client secret is returned once and stored as a hash.
- **Pre-registered clients**: write a `ClientRegistration` with
  `storage.putClient()` (use `hashClientSecret()` for a confidential client).

## The consent page

`GET /authorize` renders the page for every valid request; nothing is sent to
Grantex until the Principal approves. This is what the specification requires
of an authorization server that forwards to a third-party authorization server
with one static client.

The page shows:

- the application and the client (flagged when it identified itself with a
  metadata document, whose name is not verified);
- the **host the Principal will be sent back to**, prominently, with a warning
  when every redirect URI is on localhost;
- **purpose**, **data region** and **duration** from `grant`, labelled as
  declared by the service (the page says they are enforced only where the
  grant and the service apply them);
- the service (`resourceName` and `resource`);
- each **tool** the requested scopes cover with its permission and declared
  **caps**, and which tools need a decision grant;
- the scopes requested.

**Security.** The page is server-rendered with an escaping template and no
script. It is served with `Content-Security-Policy: default-src 'none';
script-src 'none'; style-src 'sha256-…'; img-src <logo origin>;
form-action 'self' https:; frame-ancestors 'none'; base-uri 'none'`,
`Cache-Control: no-store`, `X-Frame-Options: DENY` and
`Referrer-Policy: same-origin`. The form carries a CSRF token and the page
sets a per-consent `__Host-` cookie (Secure, HttpOnly, SameSite=Strict); both
are stored only as hashes in a consent record that is consumed exactly once.
A submission from another site is refused before the record is touched.

**Bound to the approving browser.** Approval sets a second `__Host-` cookie
(Secure, HttpOnly, SameSite=Lax, so it survives the return from Grantex)
whose hash is stored on the pending authorization. `/callback` issues a code
only when the returning browser presents it; otherwise it answers 403 and
the authorization is spent. This stops an attacker who approves consent for
their own client from sending the Grantex consent link to someone else and
collecting that person's code.

**Tested.** The page is checked in Chromium at 375 px (no overflow, 44 px
touch targets, stylesheet applied under the CSP) and with axe-core against
WCAG 2.0, 2.1 and 2.2 A/AA rules at mobile and desktop widths.

### Customising it

<!-- snippet: packages/mcp-auth/tests/docs/examples/consent-details.ts -->
```typescript
import type { ConsentPageOptions } from '@grantex/mcp-auth';

export const consentPage: ConsentPageOptions = {
  lang: 'en-GB',
  theme: {
    accentColor: '#0b6e4f',
    textColor: '#111827',
    radiusPx: 4,
    fontFamily: 'Inter, system-ui, sans-serif',
  },
  text: {
    title: 'Allow case tools?',
    approve: 'Allow access',
    deny: 'Not now',
  },
  extraCss: '.card{box-shadow:0 1px 3px rgba(0,0,0,.12)}',
  // Replaces the "What you are granting" section. helpers.html escapes every
  // interpolated value; returning a plain string is refused.
  renderDetails: (model, { html }) => html`
    <section aria-labelledby="case-tools">
      <h2 id="case-tools">Case tools for ${model.purpose?.code ?? 'no declared purpose'}</h2>
      <ul>
        ${model.tools.map((tool) => html`<li>${tool.name}${tool.requiresDecision ? ' (needs approval per action)' : ''}</li>`)}
      </ul>
      <p>Data stays in ${model.dataRegion ?? 'any region'} for ${model.duration ?? 'the default duration'}.</p>
    </section>`,
};
```

| Option | Rules |
|---|---|
| `theme` | `backgroundColor`, `surfaceColor`, `textColor`, `mutedTextColor`, `accentColor`, `accentTextColor`, `borderColor` as hex colours; `radiusPx` 0–24; `fontFamily` letters, digits, spaces, commas and hyphens (unquoted family names). Text/background pairs must reach 4.5:1 contrast or the server refuses to start. |
| `text` | Any of the page's strings (for wording or translation). |
| `lang` | BCP 47 tag for the `lang` attribute. |
| `extraCss` | Appended to the stylesheet and covered by its CSP hash; no `<style>` or comment markup. |
| `renderDetails` | Replaces the details section. Must return `helpers.html` output (`html` works only as a template tag). The header, redirect host, warnings and form cannot be replaced. |
| `expiresInSeconds` | How long a rendered page can be submitted (600). |

## Protecting the MCP server

<!-- snippet: packages/mcp-auth/tests/docs/examples/mcp-server.ts -->
```typescript
import express from 'express';
import { toolPolicyFromManifests } from '@grantex/mcp-auth';
import type { DecisionVerifier, LoadedManifest, RevocationChecker } from '@grantex/mcp-auth';
import { protectedResourceMetadataHandler, requireMcpAuth } from '@grantex/mcp-auth/express';
import type { McpAuthRequest } from '@grantex/mcp-auth/express';

export function createMcpApp(options: {
  manifest: LoadedManifest;
  /** The authorization server's storage: tokens revoked there are refused here. */
  revocations: RevocationChecker;
  decisions: DecisionVerifier;
  grantexIssuer: string;
}) {
  const resource = 'https://mcp.acme.example.com/mcp';
  const app = express();

  // RFC 9728: tells MCP clients which authorization server to use.
  app.get('/.well-known/oauth-protected-resource/mcp', protectedResourceMetadataHandler({
    resource,
    authorizationServers: ['https://auth.acme.example.com'],
    resourceName: 'Acme KYB tools',
  }));

  app.post(
    '/mcp',
    express.json(),
    requireMcpAuth({
      issuer: options.grantexIssuer,
      audience: resource,
      revocations: options.revocations,
      // A tools/call outside the grant is refused here with 403.
      tools: toolPolicyFromManifests([options.manifest]),
      // Tools marked requires_decision also need a person's decision grant.
      decisions: options.decisions,
    }),
    (req: McpAuthRequest, res) => {
      const message = req.body as { id?: unknown };
      // Only requests the grant covers reach your MCP handler.
      res.json({ jsonrpc: '2.0', id: message.id ?? null, result: { grantee: req.mcpGrant?.sub } });
    },
  );

  return app;
}
```

`requireMcpAuth` (Express; the Hono version takes the same options) requires
`audience` and answers:

| Situation | Response |
|---|---|
| No token | `401`, `WWW-Authenticate: Bearer resource_metadata="…"` |
| Malformed, expired, revoked (`grant_revoked`), wrong issuer or audience | `401`, `error="invalid_token"` |
| With `tools`: a body that is not parsed JSON-RPC 2.0 (a string, Buffer, `{}`, an array with a non-message) | `400`, `reason: "body_not_parsed"` |
| Missing required `scopes` | `403`, `error="insufficient_scope"`, `scope="…"` |
| `tools/call` for a tool the grant does not cover | `403`, `insufficient_scope` with the scope that would grant it; body `reason: "tool_not_granted"` |
| `tools/call` for an undeclared tool | `403`, body `reason: "manifest_unknown_tool"` |
| `requires_decision` tool without a valid decision grant | `403`, `error="insufficient_authorization"`, `decision_required="<connector>:<tool>"` |
| More than one `requires_decision` call in one batch | `403`, body `reason: "decision_invalid"`, `sub_reason: "multiple_decisions_in_batch"` |
| Revocation state unreadable | `503` |

A batch with one refused call is refused as a whole. Mount it after
`express.json()`: with `tools` configured, a body the guard cannot read as
JSON-RPC 2.0 is refused, so a handler that parses the raw body itself can
never act on a call the guard did not check. Every refusal is reported to
`onDenial` with a low-cardinality reason (`missing_token`, `invalid_token`,
`grant_revoked`, `insufficient_scope`, `tool_not_granted`,
`manifest_unknown_tool`, `body_not_parsed`, `decision_required`,
`decision_invalid`, ...) for metrics. Creating the middleware without
`revocations` logs a warning. The MCP server must also never forward the
client's access token to upstream APIs; the guard exposes the verified grant
on the request, not a token to pass on.
`filterToolsForGrant()` can also hide ungranted tools from `tools/list`.
Framework-neutral hosts can use `createMcpResourceGuard()` directly.

The exact challenge formats are specified in
[`spec/mcp-auth-challenges.md`](https://github.com/mishrasanjeev/grantex/blob/main/spec/mcp-auth-challenges.md).

## Extension points

- **Scopes from manifests.** `manifests` (authorization server) and
  `toolPolicyFromManifests()` (MCP server) read plain manifest JSON in the 0.5
  form (`"tool": "read"`) and the 0.6 form (`"tool": { "permission": "write",
  "caps": {…}, "requires_decision": true }`), so a manifest loaded with the
  SDK's 0.6 loader can be passed as its JSON. Each tool requires
  `tool:<connector>:<permission>`, honouring `admin > delete > write > read`.
  Duplicate tool names across manifests are refused unless you pass
  `toolName`.
- **Decision grants.** Every call to a `requires_decision` tool goes to the
  configured `DecisionVerifier`, which returns `valid`, `absent` or
  `invalid` with a sub-reason (`action_mismatch`, `expired`, `consumed`,
  `same_approver`). A verifier that returns `valid` must consume the decision
  grant atomically first, so one grant never authorises two calls; a batch
  with more than one such call is refused before any verifier runs. Without
  a verifier, such calls are refused:

<!-- snippet: packages/mcp-auth/tests/docs/examples/decision-verifier.ts -->
```typescript
import type { DecisionVerifier } from '@grantex/mcp-auth';

/**
 * Refuse every tool that declares requires_decision, for example on a
 * server that must never perform decisions. For Grantex decision grants use
 * grantexDecisionVerifier, which verifies and consumes them.
 */
export const decisionVerifier: DecisionVerifier = {
  async verify() {
    return { status: 'absent' };
  },
};
```

- **Grantex decision grants.** `grantexDecisionVerifier(options)` is the
  reference `DecisionVerifier` for decision grants issued by the Grantex auth
  service (`spec/decision-grant.md`). It reads one grant, or two
  comma-separated grants for a decision in `four_eyes_on`, from the
  `grantex-decision-grant` request header (`header` to change it); derives
  the semantic action from the tool name and the call's `case_id`,
  `decision`, `subject` and `amount`; asks `caseVersion(caseId, check)` for
  the case's current version from your own case state; verifies the grants
  with `verify` and consumes them with `consume`, answering `valid` only after
  the issuer confirmed consumption (`consume_unavailable` otherwise). Pass
  `verifyDecisionGrants` and `grantex.decisions.consume` from `@grantex/sdk`
  0.6 or later; they are injected so this package does not depend on an
  unreleased SDK. Refusals carry the SDK's sub-reason (`action_mismatch`,
  `wrong_case`, `case_changed`, `expired`, `consumed`, `same_approver`,
  `four_eyes_incomplete`, `malformed`, ...) in the `decision_invalid` body.
- **Purpose-bound grants.** `grant.authorizeParams` returns extra parameters
  for the Grantex authorize call (for example `authorization_details` with
  purpose and region). It cannot override the agent, principal, scopes,
  audience, redirect URI or state. mcp-auth does not yet send `grant.purpose`
  to Grantex itself (it is built against the published SDK); with a Grantex
  deployment and SDK that accept a purpose, return it from `authorizeParams`
  (for example `{ purpose: 'aml.cdd.onboarding' }`) so the grant carries
  it. Until then the values in `grant` are shown on the consent page as
  declared, not enforced by the grant token.

## Conformance

`packages/mcp-auth/tests/conformance/mcp-authorization-2026-07-28.test.ts`
lists every MUST of the MCP authorization specification dated 2026-07-28,
plus the confused-deputy requirements from the MCP Security Best Practices
(consent and the authorization state bound to the approving browser and
verified at the callback; CSRF protection on the consent form). Each
requirement on an authorization server or MCP server has a test, except
SEC-12 (the MCP server must not pass the client's token to upstream APIs),
which only the host application can meet and is listed with that reason.
Client requirements are listed as out of scope. Run it with `npx vitest run
tests/conformance`.

## Migrating from 2.x

| 2.x | 3.0 |
|---|---|
| `clientStore`, `codeStore`, `pendingStore`, `refreshTokenStore` | One `storage`. `createMcpAuthServer` throws if the old options are passed. Registrations from a 2.x client store must be re-created with `storage.putClient()`, replacing `clientSecret` with `clientSecretHash: hashClientSecret(secret)`. |
| `InMemoryClientStore`, `InMemoryCodeStore`, … | Removed. `InMemoryStorage` from `@grantex/mcp-auth/testing`, for tests only. |
| No `resource` needed | `resource` (or `allowedResources`) is required; tokens are always audience-bound and `/introspect` always checks `aud`. |
| Any issuer URL | `issuer` must be https (http only on localhost). |
| `/authorize` redirected to Grantex | `/authorize` renders the consent page; the flow continues with `POST /consent` (303). |
| `/callback` accepted any request with a known `state` | `/callback` requires the callback-binding cookie set on the browser that approved (403 otherwise). |
| Any `client_name` and `grant_types` at `/register` | `client_name` 1–200 characters; `grant_types` `authorization_code` with optional `refresh_token`. |
| Metadata documents from any port | Port 443 unless `allowedPorts`. |
| Upstream error text relayed to the client | Only `access_denied` or `server_error`, plus `iss`; `/authorize` and `/token` no longer put upstream text in `error_description`. |
| Any requested scope forwarded | Scopes outside `scopes`/`manifests` are `invalid_scope`. |
| Any redirect URI at `/register` | https or loopback http only. |
| `allowedRedirectUris` (not enforced) | Removed. |
| `requireMcpAuth({ issuer })` | `audience` is required; responses carry `WWW-Authenticate`. Add `revocations: storage` and `tools` to enforce revocation and tool grants. |
| Upstream exchange without `redirectUri` | Sends the callback URL, which Grantex requires. |
| A refresh returning the same refresh token | The token is not handed out again; the response omits `refresh_token`. |
| `consentUi` URLs of any scheme | `appLogo`, `privacyUrl`, `termsUrl` must be https. |
| Tokens without `jti` could be active at `/introspect` | Reported inactive. |
| Metadata advertised `consent_ui` and `audit_stream` routes that did not exist | Removed. |

Suggested order: deploy storage and run migrations; set `resource`; update MCP
clients' expectations of `/authorize` (browsers follow the page; nothing else
changes for them); add `audience`, `revocations` and `tools` to
`requireMcpAuth`; then remove the old store options.

## Known limitations

- The Grantex principal for every grant is the OAuth `client_id`, not the
  person who approved; all users of one client share it. See `FINDINGS.md`.
- Purpose and data region are displayed but not yet carried in the grant
  token (see Extension points).
- Rate limits are per process.
- `onTokenIssued` is declared but not called.
