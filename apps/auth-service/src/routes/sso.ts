import type { FastifyInstance } from 'fastify';
import { getSql } from '../db/client.js';

// ─── Routes ───────────────────────────────────────────────────────────────

export async function ssoRoutes(app: FastifyInstance): Promise<void> {
  // ── SSO config management (API-key auth, /v1/sso/config) ──────────────

  /** POST /v1/sso/config — create or update the OIDC SSO config for this org */
  app.post<{
    Body: {
      issuerUrl: string;
      clientId: string;
      clientSecret: string;
      redirectUri: string;
    };
  }>('/v1/sso/config', async (request, reply) => {
    const { issuerUrl, clientId, clientSecret, redirectUri } = request.body ?? {};
    if (!issuerUrl || !clientId || !clientSecret || !redirectUri) {
      return reply.status(400).send({
        message: 'issuerUrl, clientId, clientSecret, and redirectUri are required',
        code: 'BAD_REQUEST',
        requestId: request.id,
      });
    }

    const sql = getSql();
    const rows = await sql<Array<Record<string, unknown>>>`
      INSERT INTO sso_configs (developer_id, issuer_url, client_id, client_secret, redirect_uri)
      VALUES (${request.developer.id}, ${issuerUrl}, ${clientId}, ${clientSecret}, ${redirectUri})
      ON CONFLICT (developer_id) DO UPDATE
        SET issuer_url    = EXCLUDED.issuer_url,
            client_id     = EXCLUDED.client_id,
            client_secret = EXCLUDED.client_secret,
            redirect_uri  = EXCLUDED.redirect_uri,
            updated_at    = NOW()
      RETURNING developer_id, issuer_url, client_id, redirect_uri, created_at, updated_at
    `;
    const row = rows[0]!;
    return reply.status(201).send({
      issuerUrl: row['issuer_url'],
      clientId: row['client_id'],
      redirectUri: row['redirect_uri'],
      createdAt: row['created_at'],
      updatedAt: row['updated_at'],
    });
  });

  /** GET /v1/sso/config — get the current SSO config (client secret masked) */
  app.get('/v1/sso/config', async (request, reply) => {
    const sql = getSql();
    const rows = await sql<Array<Record<string, unknown>>>`
      SELECT developer_id, issuer_url, client_id, redirect_uri, created_at, updated_at
      FROM sso_configs
      WHERE developer_id = ${request.developer.id}
    `;
    if (!rows[0]) {
      return reply.status(404).send({ message: 'SSO config not found', code: 'NOT_FOUND', requestId: request.id });
    }
    const row = rows[0];
    return reply.send({
      issuerUrl: row['issuer_url'],
      clientId: row['client_id'],
      redirectUri: row['redirect_uri'],
      createdAt: row['created_at'],
      updatedAt: row['updated_at'],
    });
  });

  /** DELETE /v1/sso/config — remove SSO config */
  app.delete('/v1/sso/config', async (request, reply) => {
    const sql = getSql();
    const rows = await sql`
      DELETE FROM sso_configs WHERE developer_id = ${request.developer.id} RETURNING developer_id
    `;
    if (!rows[0]) {
      return reply.status(404).send({ message: 'SSO config not found', code: 'NOT_FOUND', requestId: request.id });
    }
    return reply.status(204).send();
  });

  // ── SSO flow (no API-key auth needed) ─────────────────────────────────

  /**
   * GET /sso/login?org=<developerId> — returns the OIDC authorization URL.
   * The caller (dashboard/frontend) redirects the user there.
   */
  app.get(
    '/sso/login',
    { config: { skipAuth: true } },
    async (request, reply) => {
      const query = request.query as Record<string, string>;
      const org = query['org'];
      if (!org) {
        return reply.status(400).send({ message: 'org query parameter is required', code: 'BAD_REQUEST' });
      }

      const sql = getSql();
      const rows = await sql<Array<Record<string, unknown>>>`
        SELECT issuer_url, client_id, redirect_uri
        FROM sso_configs
        WHERE developer_id = ${org}
      `;
      if (!rows[0]) {
        return reply.status(404).send({ message: 'SSO not configured for this org', code: 'NOT_FOUND' });
      }
      const cfg = rows[0];
      const state = Buffer.from(JSON.stringify({ org })).toString('base64url');

      const authorizeUrl = new URL(`${String(cfg['issuer_url'])}/authorize`);
      authorizeUrl.searchParams.set('client_id', String(cfg['client_id']));
      authorizeUrl.searchParams.set('redirect_uri', String(cfg['redirect_uri']));
      authorizeUrl.searchParams.set('response_type', 'code');
      authorizeUrl.searchParams.set('scope', 'openid email profile');
      authorizeUrl.searchParams.set('state', state);

      return reply.send({ authorizeUrl: authorizeUrl.toString() });
    },
  );

  /**
   * GET /sso/callback?code=<code>&state=<state> — exchanges the authorization
   * code for an ID token, returns the authenticated user's info.
   */
  app.get(
    '/sso/callback',
    { config: { skipAuth: true } },
    async (request, reply) => {
      const query = request.query as Record<string, string>;
      const { code, state } = query;

      if (!code || !state) {
        return reply.status(400).send({ message: 'code and state are required', code: 'BAD_REQUEST' });
      }

      let org: string;
      try {
        const decoded = JSON.parse(Buffer.from(state, 'base64url').toString()) as { org: string };
        org = decoded.org;
      } catch {
        return reply.status(400).send({ message: 'Invalid state parameter', code: 'BAD_REQUEST' });
      }

      const sql = getSql();
      const rows = await sql<Array<Record<string, unknown>>>`
        SELECT issuer_url, client_id, client_secret, redirect_uri
        FROM sso_configs
        WHERE developer_id = ${org}
      `;
      if (!rows[0]) {
        return reply.status(404).send({ message: 'SSO not configured for this org', code: 'NOT_FOUND' });
      }
      const cfg = rows[0];

      // Exchange authorization code for tokens at the IdP's token endpoint
      const tokenRes = await fetch(`${String(cfg['issuer_url'])}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: String(cfg['redirect_uri']),
          client_id: String(cfg['client_id']),
          client_secret: String(cfg['client_secret']),
        }).toString(),
      });

      if (!tokenRes.ok) {
        return reply.status(502).send({ message: 'Token exchange failed', code: 'SSO_ERROR' });
      }

      const tokenData = await tokenRes.json() as Record<string, unknown>;
      const idToken = String(tokenData['id_token'] ?? '');

      // Decode ID token claims (without verification — the IdP already validated the code)
      let claims: Record<string, unknown> = {};
      try {
        const payload = idToken.split('.')[1] ?? '';
        claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<string, unknown>;
      } catch {
        return reply.status(502).send({ message: 'Invalid ID token from IdP', code: 'SSO_ERROR' });
      }

      return reply.send({
        email: claims['email'] ?? null,
        name: claims['name'] ?? null,
        sub: claims['sub'] ?? null,
        developerId: org,
      });
    },
  );
}
