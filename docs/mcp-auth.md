---
title: "MCP Auth 4.0: authenticated human consent"
description: "Bind MCP consent to an authenticated human, preserve principal identity across callbacks and refresh, and check current grant authority before execution."
---

# `@grantex/mcp-auth` 4.0

> **Status.** Version 4.0.0 is published and registry verified as of
> September 29, 2026. Real storage/restart, Chromium and clean registry
> consumer validation passed. See [release status](/release-status). The immutable 2.0.2
> behavior remains in [the historical guide](/legacy/mcp-auth-server-2).
> Node.js 22.12+ and SDK 0.8.1+ are required.

`@grantex/mcp-auth` puts an OAuth 2.1 authorization server in front of an MCP
server and hands the actual grant to Grantex. Configure every boundary below:

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
- **A rendered consent page** that shows purpose, tools, caps and duration
  before anything reaches Grantex, and a purpose that Grantex then binds the
  grant to.
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
4. `/authorize` validates the request, resolves the authenticated host principal,
   and renders the **consent page**. Without a verified session it returns 401.
5. The Principal approves; only then does the server ask Grantex to
   authorize the grant, with the resource as its audience and `grant.purpose`
   as its purpose, and it sets a callback-binding cookie on that browser. The
   Principal may confirm again in Grantex.
6. Grantex redirects to `/callback`. Only if the browser presents the
   callback-binding cookie and the same authenticated principal does the server issue a single-use code to the
   client's redirect URI with `iss`.
7. The client redeems the code at `/token` (PKCE verifier, optional
   `resource`); the server exchanges the upstream code and returns the grant
   token only if its audience and upstream principal subject match the stored authorization.
8. The MCP server's `requireMcpAuth` verifies every request's token
   (signature, issuer, audience, local revocation and current issuer authority) and refuses any `tools/call` the
   grant does not cover.

## Install

Install the version documented here after confirming registry publication, on Node.js 22.12 or newer:

```bash
npm install @grantex/mcp-auth@4.0.0 @grantex/sdk@0.8.1
```

Also install the database driver you use (`pg` or `postgres`, or `ioredis`).
The drivers are not dependencies of
the package; the storage classes accept any compatible client.

## Authenticated principal and login

Supply `resolvePrincipal(request)` from your host's verified session or verified
identity-provider credentials. It returns `{ principalId }` with a stable,
tenant-scoped external ID, or `undefined` when unauthenticated. Do not read the
principal from query/body parameters, unsigned cookies or the OAuth client ID.
The host owns login; authenticate first, then resume a validated authorization
request. Do not use an arbitrary `returnTo` URL or expose session credentials.

Authorization without a session returns `401 login_required`. A resolver outage
returns 503 without issuing authority. Approval and callback resolve the session
again: logout, account/tenant switching or missing identity-bound state returns
403 and requires a new authorization. Use secure HTTP-only host session cookies
whose same-site settings permit the cross-origin callback (usually Lax for its
top-level GET), and protect your host login against CSRF and session fixation.

The OAuth client and human are different identities. Grantex maps the external
principal ID to an internal ID; that returned ID is stored and must match the
token subject at exchange and refresh. A swapped upstream code is refused and
its returned token is never delivered. The original human need not keep a browser
session for an already-authorized refresh; the stored subject is preserved.

Live Grantex consent still needs a principal passkey. See
[enrollment](/features/fido-webauthn). Do not invent a sandbox bypass for live
consent. General delegation approval does not authorize sensitive decisions:
mark those tools `requires_decision` and consume the action-bound decision grant,
with independent approvers where a four-eyes rule requires them.

## Deploying with Postgres

{/* snippet: packages/mcp-auth/tests/docs/examples/postgres-storage.ts */}
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

{/* snippet: packages/mcp-auth/tests/docs/examples/redis-storage.ts */}
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

{/* snippet: packages/mcp-auth/tests/docs/examples/auth-server.ts */}
```typescript
import type { Grantex } from '@grantex/sdk';
import { createMcpAuthServer } from '@grantex/mcp-auth';
import type { LoadedManifest, McpAuthStorage, PrincipalResolver } from '@grantex/mcp-auth';

export async function startAuthServer(options: {
  grantex: Grantex;
  storage: McpAuthStorage;
  manifest: LoadedManifest;
  resolvePrincipal: PrincipalResolver;
}) {
  return createMcpAuthServer({
    grantex: options.grantex,
    resolvePrincipal: options.resolvePrincipal,
    agentId: 'ag_acme_kyb_tools',
    storage: options.storage,

    // This authorization server, and the MCP server its tokens are for.
    issuer: 'https://auth.acme.example.com',
    resource: 'https://mcp.acme.example.com/mcp',
    resourceName: 'Acme KYB tools',
    grantexIssuer: 'https://grantex.dev',

    // scopes_supported and the consent page's tool list come from the manifest.
    manifests: [options.manifest],

    // What the grant is for, shown on the consent page. The purpose and
    // duration are sent to Grantex, which binds the grant to them.
    grant: {
      purpose: 'aml.cdd.onboarding',
      purposeDescription: 'Business onboarding checks for new applicants',
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
| `grant` | no | `purpose` (sent to Grantex, which binds the grant to it; see [Purpose](#purpose)), `purposeDescription`, `duration` (sent as `expiresIn`), `authorizeParams`. `dataRegion` is refused at start-up. |
| `consentUi` | no | `appName`, and https `appLogo`, `privacyUrl`, `termsUrl`. |
| `consentPage` | no | Theme, text, `lang`, `extraCss`, `renderDetails`, `expiresInSeconds` (60–3600). |
| `clientIdMetadataDocuments` | no | `enabled` (default true), `allowedHosts`, `allowedPorts` (`[443]`), `timeoutMs` (5000), `maxBytes` (16384), `cacheTtlSeconds` (300), `maxCacheTtlSeconds` (86400). |
| `resourceName`, `resourceDocumentation` | no | Published in protected-resource metadata. |
| `callbackUrl`, `callbackPath` | no | Upstream consent callback (default `{issuer}/callback`). |
| `codeExpirationSeconds` | no | Authorization code and pending authorization lifetime (600). |
| `sandboxAutoApprove` | no | Accept a Grantex sandbox auto-approval after local consent. Off by default. |
| `hooks.onRevocation` | no | Called after a revocation is recorded. |
| `warn` | no | Receives operator warnings (default `console.warn`): Grantex refusing `grant.purpose`, with its reason, error code and request id, or answering without confirming it. See [Purpose](#purpose). |

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
- **purpose** and **duration** from `grant`. When `grant.purpose` is set,
  the page says that Grantex records the purpose on the grant; when it is
  not, the page says nothing about recording one. Either way it says that
  call limits are declared by the service and enforced only where the
  service applies them. The data region row always reads "None declared",
  because a grant made through mcp-auth cannot carry a data region (see
  [Purpose](#purpose));
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

{/* snippet: packages/mcp-auth/tests/docs/examples/consent-details.ts */}
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
      <p>Access lasts ${model.duration ?? 'the default duration'}.</p>
    </section>`,
};
```

| Option | Rules |
|---|---|
| `theme` | `backgroundColor`, `surfaceColor`, `textColor`, `mutedTextColor`, `accentColor`, `accentTextColor`, `borderColor` as hex colours; `radiusPx` 0–24; `fontFamily` letters, digits, spaces, commas and hyphens (unquoted family names). Text/background pairs must reach 4.5:1 contrast or the server refuses to start. |
| `text` | Any of the page's strings (for wording or translation). The note above the details is `declaredNote` when `grant.purpose` is set and `noPurposeNote` when it is not. |
| `lang` | BCP 47 tag for the `lang` attribute. |
| `extraCss` | Appended to the stylesheet and covered by its CSP hash; no `<style>` or comment markup. |
| `renderDetails` | Replaces the details section. Must return `helpers.html` output (`html` works only as a template tag). The header, redirect host, warnings and form cannot be replaced. `model.dataRegion` is never set. |
| `expiresInSeconds` | How long a rendered page can be submitted (600). |

## Protecting the MCP server

{/* snippet: packages/mcp-auth/tests/docs/examples/mcp-server.ts */}
```typescript
import express from 'express';
import { toolPolicyFromManifests } from '@grantex/mcp-auth';
import type { CurrentGrantVerifier, DecisionVerifier, LoadedManifest, RevocationChecker } from '@grantex/mcp-auth';
import { protectedResourceMetadataHandler, requireMcpAuth } from '@grantex/mcp-auth/express';
import type { McpAuthRequest } from '@grantex/mcp-auth/express';

export function createMcpApp(options: {
  manifest: LoadedManifest;
  /** The authorization server's storage: tokens revoked there are refused here. */
  revocations: RevocationChecker;
  currentGrant: CurrentGrantVerifier;
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
      currentGrant: options.currentGrant,
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
`audience` and `revocations`, and answers:

| Situation | Response |
|---|---|
| No token | `401`, `WWW-Authenticate: Bearer resource_metadata="…"` |
| Malformed, expired, revoked (`grant_revoked`), wrong issuer or audience, an algorithm other than RS256 or ES256, a wrong `typ`, not a grant token (neither `urn:grantex:grant` nor `scp`), no `scope` or `scp`, a `null` or mistyped claim, or standard and legacy claims that disagree | `401`, `error="invalid_token"` |
| With `tools`: a body that is not parsed JSON-RPC 2.0 (a string, Buffer, `{}`, an array with a non-message) | `400`, `reason: "body_not_parsed"` |
| Missing required `scopes` | `403`, `error="insufficient_scope"`, `scope="…"` |
| `tools/call` for a tool the grant does not cover | `403`, `insufficient_scope` with the scope that would grant it; body `reason: "tool_not_granted"` |
| `tools/call` for an undeclared tool | `403`, body `reason: "manifest_unknown_tool"` |
| `requires_decision` tool without a valid decision grant | `403`, `error="insufficient_authorization"`, `decision_required="<connector>:<tool>"` |
| More than one `requires_decision` call in one batch | `403`, body `reason: "decision_invalid"`, `sub_reason: "multiple_decisions_in_batch"` |
| Revocation state unreadable | `503` |

The guard validates grant tokens as
[`spec/grant-token-0.6.md`](https://github.com/mishrasanjeev/grantex/blob/main/spec/grant-token-0.6.md)
("Validation") requires:

- **Algorithms.** Only `RS256` and `ES256`. The `algorithms` option may
  narrow that to one of them; a list naming any other algorithm (`PS256`,
  `EdDSA`, `HS256`, ...) throws when the middleware is created.
- **`typ`.** Must be `at+jwt` (or `application/at+jwt`). The auth service sets
  it on every grant token; only a pre-0.6 token (no `urn:grantex:grant`, with
  `scp`), issued before it did, may omit it.
- **Grant tokens only.** A token must carry `urn:grantex:grant` (0.6) or
  `scp` (before 0.6). The auth service's OAuth access tokens, which are also
  `at+jwt` but carry only `client_id`, `scope` and a `cnf.jkt`, are refused.
- **Scopes.** Read from the space-delimited `scope`, falling back to `scp` when
  a 0.6 token omits `scope` (a grant with a scope containing whitespace). A
  pre-0.6 token is read from `scp`, because its `scope` was a lossy join. An
  empty `scope` (or `scp: []`) is an empty scope set, as the SDK verifiers
  read it: the token is admitted only where neither `scopes` nor `tools`
  requires a scope.
- **Grant fields.** `agentDid`, `developerId`, `grantId` and
  `delegationDepth` on the verified grant come from `urn:grantex:grant`, then
  from the legacy `agt`, `dev`, `grnt` and `delegationDepth`. A 0.6 token must
  name its agent and developer in one form or the other.
- **Proof of possession is not checked.** Validation step 5 of the profile
  requires a resource server to verify proof of possession when the token
  has `cnf.jkt`. The guard does not: a key-bound grant token is admitted as a
  bearer token. If your server needs sender-constrained tokens, verify the
  DPoP proof (RFC 9449) yourself and compare its key thumbprint with
  `raw.cnf.jkt` of the verified grant (`req.mcpGrant`, or
  `c.get('mcpGrant')` in Hono) before acting on the call.

The guard therefore keeps working when the auth service stops issuing the
legacy claims (`GRANT_TOKEN_LEGACY_CLAIMS=false`, the 0.7 default), and so does
the developer check of `grantexDecisionVerifier`. As in the SDK verifiers, a
claim present with `null` or the wrong type, legacy aliases included, is
refused rather than treated as absent, and so is a 0.6 token whose standard
claim and legacy alias disagree.

A batch with one refused call is refused as a whole. Mount it after
`express.json()`: with `tools` configured, a body the guard cannot read as
JSON-RPC 2.0 is refused, so a handler that parses the raw body itself can
never act on a call the guard did not check. Every refusal is reported to
`onDenial` with a low-cardinality reason (`missing_token`, `invalid_token`,
`grant_revoked`, `insufficient_scope`, `tool_not_granted`,
`manifest_unknown_tool`, `body_not_parsed`, `decision_required`,
`decision_invalid`, ...) for metrics.

From 3.0.0 the guard refuses to start without a revocation
configuration: `requireMcpAuth`, the Hono version and
`createMcpResourceGuard()` throw when `revocations` is missing, or is neither
an object with an `isTokenRevoked(jti)` function nor `'none'`. A guard that
cannot see revocations accepts a revoked token until it expires, so running
without one has to be a stated choice: `revocations: 'none'` is the explicit
opt-out. It starts, logs a warning, and neither checks revocation nor
requires a `jti`, as a 2.x guard without `revocations` did. The MCP server
must also never forward the
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

{/* snippet: packages/mcp-auth/tests/docs/examples/decision-verifier.ts */}
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
  comma-separated grants for a decision in `four_eyes_on` (the manifest's
  or the grant's `urn:grantex:decision:v1` entry's), from the
  `grantex-decision-grant` request header (`header` to change it); derives
  the semantic action from the tool name and the call's `case_id`,
  `decision`, `subject`, `amount` and the manifest's `decision_fields`;
  requires the access token's developer (`urn:grantex:grant.developer_id`,
  or the legacy `dev`) and a connector from a
  manifest-derived tool policy (a call without either is refused as
  `malformed`); asks `caseVersion(caseId, check)` for
  the case's current version from your own case state; verifies the grants
  with `verify` and consumes them with `consume`, answering `valid` only after
  the issuer confirmed consumption (`consume_unavailable` otherwise). Pass
  `verifyDecisionGrants` and
  `(set, context) => grantex.decisions.consume(set, context)` from
  `@grantex/sdk` 0.6 or later; they are injected so this package does not
  depend on an unreleased SDK. `context` is `{ agentDid, grantId, grantToken }`:
  the agent (`agt`, its DID) and grant of the access token, and the access
  token itself as the guard verified it (`check.grantToken`). Pass it on,
  because an auth service with `DECISION_GRANT_AGENT_BINDING=true`
  establishes the calling agent from `grantToken` and consumes a decision
  requested for an agent only with that agent's live grant token
  (`wrong_agent` otherwise). The token goes only to `consume`, and so only to
  the auth service that issued it. An SDK that predates `agentDid` or
  `grantToken` drops them and consumes as before, and an auth service with the
  binding off ignores them. Refusals carry the SDK's sub-reason
  (`action_mismatch`, `wrong_case`, `wrong_agent`, `case_changed`, `expired`,
  `consumed`, `same_approver`, `four_eyes_incomplete`, `malformed`, ...) in the
  `decision_invalid` body.
  Consumption spends the grant: if the tool call fails afterwards, a person
  has to approve again.
  The guard also reads the access token's `urn:grantex:decision:v1` entries
  (`spec/grant-token-0.6.md`): a tool listed there needs a decision grant even
  when its manifest does not declare `requires_decision`, and a token whose
  decision entries cannot be read is refused for every `tools/call`
  (`decision_invalid` / `malformed_authorization_details`).
- **Authorize parameters.** `grant.authorizeParams` returns extra parameters
  for the Grantex authorize call, for parameters a newer Grantex server
  accepts. It cannot override the agent, principal, scopes, audience,
  redirect URI, state or purpose: it may repeat `grant.purpose`, but a
  different `purpose`, or one when `grant.purpose` is unset, refuses the
  authorization with `500 server_error` before Grantex is called. The
  purpose sent is always the one the consent page showed.

## Purpose

`grant.purpose` is shown on the consent page and, once the Principal
approves, sent to Grantex as the `purpose` of `POST /v1/authorize`. Grantex
stores it on the grant and carries it in the grant token's
`authorization_details` (`urn:grantex:tools:v1`, one entry per connector),
where the SDKs' `enforce()` checks it against each tool's `allowed_purposes`.
Every `@grantex/sdk` version sends it; a Grantex server that predates
purpose-bound grants ignores it, which is why the answer is checked.

**Use a purpose Grantex accepts.** `createMcpAuthServer` checks only that
`grant.purpose` is well formed. Whether Grantex accepts the term is for
Grantex to decide, and it does not publish its purpose vocabulary in its
metadata (`/.well-known/oauth-authorization-server`), so mcp-auth cannot
check the term at start-up without keeping a copy that could drift. A
well-formed term outside the vocabulary, such as `marketing.analytics`,
therefore starts cleanly and then fails **every** authorization after the
Principal approves the consent page: the client receives
`error=invalid_scope`, and `warn` receives Grantex's reason, error code
and request id. Use a term from the
[purpose vocabulary](/concepts/purpose-bound-grants) or a private
`x-<org>.<term>`, and complete one authorization after each deployment
that changes `grant.purpose`.

| Grantex answers | The server |
|---|---|
| `201` echoing the purpose | Continues to Grantex consent as usual. |
| `201` without the purpose (a server that predates purpose-bound grants) | Refuses with `502 server_error` ("Grantex did not confirm the purpose for this grant") and reports it through `warn`. Nothing is issued. |
| `400 INVALID_PURPOSE`: a purpose outside the vocabulary, or requested scopes that name no connector (no `tool:<connector>:<permission>` scope) | Redirects the client with `error=invalid_scope` and a fixed `error_description` naming the purpose. Upstream text is not relayed to the client; Grantex's reason, error code and request id go to `warn` on one line, with the reason cut to 300 characters. |
| Any other failure | `502 server_error` with a fixed description; upstream text is not relayed. |

A purpose needs a connector to bind to, so offer `tool:<connector>:<permission>`
scopes (from `manifests`) and have clients request at least one; a request
for a scope such as `profile` alone is refused.

**Data region.** `grant.dataRegion` is not supported. `POST /v1/authorize`,
the Grantex endpoint mcp-auth calls, takes no data region: Grantex builds
the grant's `authorization_details` from the purpose and scopes alone. A
grant made through mcp-auth therefore cannot carry a data region, and the
consent page could only promise a restriction the grant does not carry.
`createMcpAuthServer` throws at start-up when it is set; remove it, and say
where data is held in the privacy policy linked from the page
(`consentUi.privacyUrl`) instead. Grant tokens from other flows can carry
`data_region` in `authorization_details`; the SDKs report it but do not
yet evaluate it (see [purpose-bound grants](/concepts/purpose-bound-grants)).

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

## Migrating from 3.x to 4.0

Token introspection now requires confidential-client Basic authentication and
defaults to online current issuer verification. A revoked grant or issuer
outage reports `active: false`; unsigned caller identity is not authentication.
`allowUnauthenticatedIntrospection: true` and `introspectionCurrentGrant: 'none'`
are explicit warned evaluation-only opt-outs.

1. Implement and test the verified `resolvePrincipal` host-session resolver.
2. Add `currentGrant: grantexCurrentGrantVerifier(grantex)` alongside shared
   `revocations` in every resource guard and Express/Hono middleware. The helper
   calls `grantex.grants.verify` on each protected request without a positive
   cache. Inactive authority returns 401; issuer failures return 503.
3. Drain pending authorizations and upgrade all replicas together. Do not mix
   v3 and v4 in one state namespace. Existing client registrations can remain;
   identity-unbound pending requests, codes and refresh bindings must restart.
   JSON state supports the new fields; existing SQL migrations remain valid.
4. Test logout/account switching, consent denial, browser callback, token
   exchange, refresh, revocation, service outages and your actual MCP client.

Version 3 used the OAuth client ID as the principal and had no issuer-side
current-grant hook in the resource guard. The v4 defaults deliberately close
those gaps. `allowLegacyClientPrincipal: true`, `currentGrant: 'none'` and
`revocations: 'none'` are explicit warned evaluation opt-outs, not production
recommendations. Purpose/duration changes after rendering invalidate consent;
`authorizeParams` cannot override the displayed duration.

Local or issuer revocation stops subsequent requests, not completed side effects
or a handler already in flight. Apply atomic spend/call reservations and SDK
`enforce` at the actual business side-effect boundary; displaying caps does not
create counters. Host login, session correctness, TLS and gateway-wide rate
limits remain deployment responsibilities.

## Earlier migration from 2.x to 3.x

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
| `requireMcpAuth({ issuer })` | `audience` and `revocations` are required; responses carry `WWW-Authenticate`. Pass `revocations: storage` (or `revocations: 'none'` to opt out explicitly) and `tools` to enforce revocation and tool grants. |
| `requireMcpAuth`, `/introspect` and `/revoke` accepted RS256, ES256, PS256 and EdDSA; `algorithms` could name any algorithm | RS256 and ES256 only. `algorithms` naming anything else throws at start-up. `typ` must be `at+jwt` (absent only on a pre-0.6 token). |
| `requireMcpAuth` read `scp`, `agt`, `dev`, `grnt` and `delegationDepth` only | Reads `scope` and `urn:grantex:grant` first, the legacy claims as a fallback; refuses a 0.6 token whose claims disagree. |
| Upstream exchange without `redirectUri` | Sends the callback URL, which Grantex requires. |
| A refresh returning the same refresh token | The token is not handed out again; the response omits `refresh_token`. |
| `consentUi` URLs of any scheme | `appLogo`, `privacyUrl`, `termsUrl` must be https. |
| Tokens without `jti` could be active at `/introspect` | Reported inactive. |
| Metadata advertised `consent_ui` and `audit_stream` routes that did not exist | Removed. |

Suggested order: deploy storage and run migrations; set `resource`; update MCP
clients' expectations of `/authorize` (browsers follow the page; nothing else
changes for them); add `audience`, `revocations` and `tools` to
`requireMcpAuth`; then remove the old store options.

## Operational boundaries

- The host supplies and verifies the human's session; the package cannot
  establish identity from an unverified caller-supplied principal ID.
- A data region cannot be declared: `grant.dataRegion` is refused at
  start-up, because `POST /v1/authorize` takes no data region (see
  [Purpose](#purpose)).
- A purpose outside the Grantex vocabulary is found only when Grantex
  refuses it, after the Principal approves the consent page, not at
  start-up (see [Purpose](#purpose)).
- Rate limits are per process.
- `hooks.onTokenIssued` is invoked after successful exchange and refresh. It
  carries a secret bearer token and must not log it. Hook errors warn without
  changing delivery; use policy enforcement, not this hook, for authorization.
