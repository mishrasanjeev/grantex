import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { getSql } from '../db/client.js';
import { newSsoConnectionId } from '../lib/ids.js';
import { emitEvent } from '../lib/events.js';
import {
  discoverOidcProvider,
  verifyIdToken,
  generateSamlAuthorizeUrl,
  parseSamlResponse,
  resolveConnection,
  mapGroupsToScopes,
  jitProvision,
  createSsoSession,
  type SamlConnectionOptions,
  type SsoConnectionRow,
} from '../lib/sso.js';
import { authenticateLdap, testLdapConnection, type LdapConfig } from '../lib/ldap.js';
import { config } from '../config.js';
import { getKeyPair } from '../lib/crypto.js';
import { encrypt, decrypt } from '../lib/vault-crypto.js';
import { assertValidRedirectUri, safeFetch, validateOutboundUrl } from '../lib/url-security.js';

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Derive a deterministic HMAC key for SSO state signing.
 * Uses SSO_STATE_SECRET env var if set, otherwise derives from the RSA private key.
 */
function getSsoHmacKey(): string {
  if (config.ssoStateSecret) return config.ssoStateSecret;
  // Derive from RSA private key — stable across restarts as long as the key doesn't change.
  const { kid } = getKeyPair();
  const raw = config.rsaPrivateKey ?? kid;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/** Create an HMAC-signed SSO state parameter. */
export function signSsoState(payload: Record<string, unknown>): string {
  const statePayload = Buffer.from(JSON.stringify({
    ...payload,
    iat: Math.floor(Date.now() / 1000),
    nonce: crypto.randomBytes(16).toString('base64url'),
  })).toString('base64url');
  const stateSignature = crypto.createHmac('sha256', getSsoHmacKey()).update(statePayload).digest('base64url');
  return `${statePayload}.${stateSignature}`;
}

/** Verify and decode an HMAC-signed SSO state parameter. Returns null if invalid. */
export function verifySsoState(state: string): Record<string, unknown> | null {
  const dotIdx = state.indexOf('.');
  if (dotIdx === -1) return null;
  const payload = state.slice(0, dotIdx);
  const sig = state.slice(dotIdx + 1);
  if (!sig) return null;
  const expectedSig = crypto.createHmac('sha256', getSsoHmacKey()).update(payload).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<string, unknown>;
    const issuedAt = decoded['iat'];
    const now = Math.floor(Date.now() / 1000);
    if (typeof issuedAt !== 'number' || !Number.isSafeInteger(issuedAt)
      || issuedAt > now + 60 || now - issuedAt > 10 * 60) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

function connectionToResponse(row: SsoConnectionRow) {
  const protocolFields =
    row.protocol === 'oidc'
      ? { issuerUrl: row.issuer_url, clientId: row.client_id }
      : row.protocol === 'saml'
        ? { idpEntityId: row.idp_entity_id, idpSsoUrl: row.idp_sso_url, spEntityId: row.sp_entity_id, spAcsUrl: row.sp_acs_url }
        : {
            ldapUrl: row.ldap_url,
            ldapBindDn: row.ldap_bind_dn,
            ldapSearchBase: row.ldap_search_base,
            ldapSearchFilter: row.ldap_search_filter,
            ldapGroupSearchBase: row.ldap_group_search_base,
            ldapGroupSearchFilter: row.ldap_group_search_filter,
            ldapTlsEnabled: row.ldap_tls_enabled,
          };
  return {
    id: row.id,
    developerId: row.developer_id,
    name: row.name,
    protocol: row.protocol,
    status: row.status,
    ...protocolFields,
    domains: row.domains,
    jitProvisioning: row.jit_provisioning,
    enforce: row.enforce,
    groupAttribute: row.group_attribute,
    groupMappings: row.group_mappings,
    defaultScopes: row.default_scopes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validateSsoHttpUrl(value: string, field: string): string | null {
  try {
    validateOutboundUrl(value, {
      allowedProtocols: ['https:', 'http:'],
      allowInsecureHttp: config.allowInsecureSsoUrls,
      allowPrivateHosts: config.allowPrivateSsoHosts,
    });
    return null;
  } catch (err) {
    return `${field}: ${err instanceof Error ? err.message : 'invalid URL'}`;
  }
}

function samlConnectionOptions(conn: SsoConnectionRow): SamlConnectionOptions {
  if (
    !conn.idp_certificate
    || !conn.idp_entity_id
    || !conn.idp_sso_url
    || !conn.sp_entity_id
    || !conn.sp_acs_url
  ) {
    throw new Error('SSO connection is missing required SAML settings');
  }
  return {
    connectionId: conn.id,
    idpCertificate: conn.idp_certificate,
    idpEntityId: conn.idp_entity_id,
    idpSsoUrl: conn.idp_sso_url,
    spEntityId: conn.sp_entity_id,
    spAcsUrl: conn.sp_acs_url,
    ...(conn.group_attribute ? { groupAttribute: conn.group_attribute } : {}),
  };
}

function validateLdapUrl(value: string, tlsEnabled: boolean): string | null {
  try {
    const url = validateOutboundUrl(value, {
      allowedProtocols: ['ldap:', 'ldaps:'],
      allowPrivateHosts: config.allowPrivateSsoHosts,
      allowInsecureHttp: true,
    });
    if (url.protocol === 'ldap:' && !tlsEnabled && !config.allowInsecureSsoUrls) {
      return 'ldapUrl: Insecure LDAP URLs are disabled; use LDAPS or enable SSO_ALLOW_INSECURE_URLS';
    }
    return null;
  } catch (err) {
    return `ldapUrl: ${err instanceof Error ? err.message : 'invalid URL'}`;
  }
}

function validateOptionalRedirectUri(value: string, field: string): string | null {
  try {
    assertValidRedirectUri(value);
    return null;
  } catch (err) {
    return `${field}: ${err instanceof Error ? err.message : 'invalid URL'}`;
  }
}

const SSO_SECRET_PREFIX = 'vault:v1:';

function encryptSsoSecret(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return `${SSO_SECRET_PREFIX}${encrypt(value)}`;
}

function isEncryptedSsoSecret(value: string | null): boolean {
  return typeof value === 'string' && value.startsWith(SSO_SECRET_PREFIX);
}

function decryptSsoSecret(value: string | null, field = 'sso secret'): string | null {
  if (!value) return null;
  if (!isEncryptedSsoSecret(value)) {
    throw new Error(`${field} is not encrypted; run the SSO secret backfill`);
  }
  return decrypt(value.slice(SSO_SECRET_PREFIX.length));
}

async function backfillLegacySsoSecrets(): Promise<void> {
  const sql = getSql();
  const legacySecretPattern = `${SSO_SECRET_PREFIX}%`;
  const connectionRows = await sql<Array<{
    id: string;
    client_secret: string | null;
    ldap_bind_password: string | null;
  }>>`
    SELECT id, client_secret, ldap_bind_password
    FROM sso_connections
    WHERE (client_secret IS NOT NULL AND client_secret <> '' AND client_secret NOT LIKE ${legacySecretPattern})
       OR (ldap_bind_password IS NOT NULL AND ldap_bind_password <> '' AND ldap_bind_password NOT LIKE ${legacySecretPattern})
  `;

  for (const row of connectionRows) {
    const nextClientSecret = row.client_secret && !isEncryptedSsoSecret(row.client_secret)
      ? encryptSsoSecret(row.client_secret)
      : row.client_secret;
    const nextLdapBindPassword = row.ldap_bind_password && !isEncryptedSsoSecret(row.ldap_bind_password)
      ? encryptSsoSecret(row.ldap_bind_password)
      : row.ldap_bind_password;
    await sql`
      UPDATE sso_connections
      SET client_secret = ${nextClientSecret},
          ldap_bind_password = ${nextLdapBindPassword},
          updated_at = NOW()
      WHERE id = ${row.id}
    `;
  }

  const configRows = await sql<Array<{ developer_id: string; client_secret: string | null }>>`
    SELECT developer_id, client_secret
    FROM sso_configs
    WHERE client_secret IS NOT NULL AND client_secret <> '' AND client_secret NOT LIKE ${legacySecretPattern}
  `;

  for (const row of configRows) {
    await sql`
      UPDATE sso_configs
      SET client_secret = ${encryptSsoSecret(row.client_secret)},
          updated_at = NOW()
      WHERE developer_id = ${row.developer_id}
    `;
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────

export async function ssoRoutes(app: FastifyInstance): Promise<void> {
  await backfillLegacySsoSecrets();

  // ══════════════════════════════════════════════════════════════════════════
  // SSO Connections CRUD (API-key authenticated)
  // ══════════════════════════════════════════════════════════════════════════

  /** POST /v1/sso/connections — create a new SSO connection */
  app.post<{
    Body: {
      name: string;
      protocol: 'oidc' | 'saml' | 'ldap';
      issuerUrl?: string;
      clientId?: string;
      clientSecret?: string;
      idpEntityId?: string;
      idpSsoUrl?: string;
      idpCertificate?: string;
      spEntityId?: string;
      spAcsUrl?: string;
      ldapUrl?: string;
      ldapBindDn?: string;
      ldapBindPassword?: string;
      ldapSearchBase?: string;
      ldapSearchFilter?: string;
      ldapGroupSearchBase?: string;
      ldapGroupSearchFilter?: string;
      ldapTlsEnabled?: boolean;
      domains?: string[];
      jitProvisioning?: boolean;
      enforce?: boolean;
      groupAttribute?: string;
      groupMappings?: Record<string, string[]>;
      defaultScopes?: string[];
    };
  }>('/v1/sso/connections', async (request, reply) => {
    const b = request.body ?? ({} as Record<string, unknown>);
    if (!b.name || !b.protocol) {
      return reply.status(400).send({ message: 'name and protocol are required', code: 'BAD_REQUEST', requestId: request.id });
    }
    if (b.protocol !== 'oidc' && b.protocol !== 'saml' && b.protocol !== 'ldap') {
      return reply.status(400).send({ message: 'protocol must be oidc, saml, or ldap', code: 'BAD_REQUEST', requestId: request.id });
    }
    if (b.protocol === 'oidc' && (!b.issuerUrl || !b.clientId || !b.clientSecret)) {
      return reply.status(400).send({ message: 'OIDC connections require issuerUrl, clientId, and clientSecret', code: 'BAD_REQUEST', requestId: request.id });
    }
    if (
      b.protocol === 'saml'
      && (!b.idpEntityId || !b.idpSsoUrl || !b.idpCertificate || !b.spEntityId || !b.spAcsUrl)
    ) {
      return reply.status(400).send({
        message: 'SAML connections require idpEntityId, idpSsoUrl, idpCertificate, spEntityId, and spAcsUrl',
        code: 'BAD_REQUEST',
        requestId: request.id,
      });
    }
    if (b.protocol === 'ldap' && (!b.ldapUrl || !b.ldapBindDn || !b.ldapBindPassword || !b.ldapSearchBase)) {
      return reply.status(400).send({ message: 'LDAP connections require ldapUrl, ldapBindDn, ldapBindPassword, and ldapSearchBase', code: 'BAD_REQUEST', requestId: request.id });
    }

    const urlErrors = [
      b.protocol === 'oidc' && typeof b.issuerUrl === 'string' ? validateSsoHttpUrl(b.issuerUrl, 'issuerUrl') : null,
      b.protocol === 'saml' && typeof b.idpSsoUrl === 'string' ? validateSsoHttpUrl(b.idpSsoUrl, 'idpSsoUrl') : null,
      b.protocol === 'saml' && typeof b.spAcsUrl === 'string' ? validateOptionalRedirectUri(b.spAcsUrl, 'spAcsUrl') : null,
      b.protocol === 'ldap' && typeof b.ldapUrl === 'string' ? validateLdapUrl(b.ldapUrl, b.ldapTlsEnabled === true) : null,
    ].filter((err): err is string => err !== null);
    if (urlErrors.length > 0) {
      return reply.status(400).send({ message: urlErrors.join('; '), code: 'BAD_REQUEST', requestId: request.id });
    }

    const sql = getSql();
    const id = newSsoConnectionId();
    const encryptedClientSecret = encryptSsoSecret(b.clientSecret);
    const encryptedLdapBindPassword = encryptSsoSecret(b.ldapBindPassword);

    const rows = await sql<SsoConnectionRow[]>`
      INSERT INTO sso_connections (
        id, developer_id, name, protocol,
        issuer_url, client_id, client_secret,
        idp_entity_id, idp_sso_url, idp_certificate, sp_entity_id, sp_acs_url,
        ldap_url, ldap_bind_dn, ldap_bind_password, ldap_search_base, ldap_search_filter,
        ldap_group_search_base, ldap_group_search_filter, ldap_tls_enabled,
        domains, jit_provisioning, enforce,
        group_attribute, group_mappings, default_scopes
      ) VALUES (
        ${id}, ${request.developer.id}, ${b.name}, ${b.protocol},
        ${b.issuerUrl ?? null}, ${b.clientId ?? null}, ${encryptedClientSecret},
        ${b.idpEntityId ?? null}, ${b.idpSsoUrl ?? null}, ${b.idpCertificate ?? null},
        ${b.spEntityId ?? null}, ${b.spAcsUrl ?? null},
        ${b.ldapUrl ?? null}, ${b.ldapBindDn ?? null}, ${encryptedLdapBindPassword},
        ${b.ldapSearchBase ?? null}, ${b.ldapSearchFilter ?? '(uid={{username}})'},
        ${b.ldapGroupSearchBase ?? null}, ${b.ldapGroupSearchFilter ?? '(member={{dn}})'},
        ${b.ldapTlsEnabled ?? false},
        ${b.domains ?? []}, ${b.jitProvisioning ?? false}, ${b.enforce ?? false},
        ${b.groupAttribute ?? null}, ${JSON.stringify(b.groupMappings ?? {})},
        ${b.defaultScopes ?? []}
      )
      RETURNING *
    `;

    await emitEvent(request.developer.id, 'sso.connection.created', { connectionId: id, protocol: b.protocol });

    return reply.status(201).send(connectionToResponse(rows[0]!));
  });

  /** GET /v1/sso/connections — list all SSO connections for this org */
  app.get('/v1/sso/connections', async (request, reply) => {
    const sql = getSql();
    const rows = await sql<SsoConnectionRow[]>`
      SELECT * FROM sso_connections
      WHERE developer_id = ${request.developer.id}
      ORDER BY created_at ASC
    `;
    return reply.send({ connections: rows.map(connectionToResponse) });
  });

  /** GET /v1/sso/connections/:id — get a single connection */
  app.get<{ Params: { id: string } }>('/v1/sso/connections/:id', async (request, reply) => {
    const sql = getSql();
    const rows = await sql<SsoConnectionRow[]>`
      SELECT * FROM sso_connections
      WHERE id = ${request.params.id} AND developer_id = ${request.developer.id}
    `;
    if (!rows[0]) {
      return reply.status(404).send({ message: 'SSO connection not found', code: 'NOT_FOUND', requestId: request.id });
    }
    return reply.send(connectionToResponse(rows[0]));
  });

  /** PATCH /v1/sso/connections/:id — update a connection */
  app.patch<{
    Params: { id: string };
    Body: {
      name?: string;
      status?: 'active' | 'inactive' | 'testing';
      issuerUrl?: string;
      clientId?: string;
      clientSecret?: string;
      idpEntityId?: string;
      idpSsoUrl?: string;
      idpCertificate?: string;
      spEntityId?: string;
      spAcsUrl?: string;
      ldapUrl?: string;
      ldapBindDn?: string;
      ldapBindPassword?: string;
      ldapSearchBase?: string;
      ldapSearchFilter?: string;
      ldapGroupSearchBase?: string;
      ldapGroupSearchFilter?: string;
      ldapTlsEnabled?: boolean;
      domains?: string[];
      jitProvisioning?: boolean;
      enforce?: boolean;
      groupAttribute?: string;
      groupMappings?: Record<string, string[]>;
      defaultScopes?: string[];
    };
  }>('/v1/sso/connections/:id', async (request, reply) => {
    const sql = getSql();
    const b = request.body ?? ({} as Record<string, unknown>);

    // Check at least one field is being updated
    const hasUpdates = [
      b.name, b.status, b.issuerUrl, b.clientId, b.clientSecret,
      b.idpEntityId, b.idpSsoUrl, b.idpCertificate, b.spEntityId, b.spAcsUrl,
      b.ldapUrl, b.ldapBindDn, b.ldapBindPassword, b.ldapSearchBase, b.ldapSearchFilter,
      b.ldapGroupSearchBase, b.ldapGroupSearchFilter, b.ldapTlsEnabled,
      b.domains, b.jitProvisioning, b.enforce, b.groupAttribute, b.groupMappings, b.defaultScopes,
    ].some((v) => v !== undefined);

    if (!hasUpdates) {
      return reply.status(400).send({ message: 'No fields to update', code: 'BAD_REQUEST', requestId: request.id });
    }

    // Read current row, merge updates, write back
    const existing = await sql<SsoConnectionRow[]>`
      SELECT * FROM sso_connections
      WHERE id = ${request.params.id} AND developer_id = ${request.developer.id}
    `;
    if (!existing[0]) {
      return reply.status(404).send({ message: 'SSO connection not found', code: 'NOT_FOUND', requestId: request.id });
    }
    const cur = existing[0];

    if (b.status !== undefined && !['active', 'inactive', 'testing'].includes(String(b.status))) {
      return reply.status(400).send({ message: 'status must be active, inactive, or testing', code: 'BAD_REQUEST', requestId: request.id });
    }

    const urlErrors = [
      cur.protocol === 'oidc' && typeof b.issuerUrl === 'string' ? validateSsoHttpUrl(b.issuerUrl, 'issuerUrl') : null,
      cur.protocol === 'saml' && typeof b.idpSsoUrl === 'string' ? validateSsoHttpUrl(b.idpSsoUrl, 'idpSsoUrl') : null,
      cur.protocol === 'saml' && typeof b.spAcsUrl === 'string' ? validateOptionalRedirectUri(b.spAcsUrl, 'spAcsUrl') : null,
      cur.protocol === 'ldap' && typeof b.ldapUrl === 'string' ? validateLdapUrl(b.ldapUrl, b.ldapTlsEnabled ?? Boolean(cur.ldap_tls_enabled)) : null,
    ].filter((err): err is string => err !== null);
    if (urlErrors.length > 0) {
      return reply.status(400).send({ message: urlErrors.join('; '), code: 'BAD_REQUEST', requestId: request.id });
    }
    const nextClientSecret = b.clientSecret !== undefined
      ? encryptSsoSecret(b.clientSecret)
      : cur.client_secret;
    const nextLdapBindPassword = b.ldapBindPassword !== undefined
      ? encryptSsoSecret(b.ldapBindPassword)
      : cur.ldap_bind_password;

    const rows = await sql<SsoConnectionRow[]>`
      UPDATE sso_connections SET
        name            = ${b.name ?? cur.name},
        status          = ${b.status ?? cur.status},
        issuer_url      = ${b.issuerUrl ?? cur.issuer_url},
        client_id       = ${b.clientId ?? cur.client_id},
        client_secret   = ${nextClientSecret},
        idp_entity_id   = ${b.idpEntityId ?? cur.idp_entity_id},
        idp_sso_url     = ${b.idpSsoUrl ?? cur.idp_sso_url},
        idp_certificate = ${b.idpCertificate ?? cur.idp_certificate},
        sp_entity_id    = ${b.spEntityId ?? cur.sp_entity_id},
        sp_acs_url      = ${b.spAcsUrl ?? cur.sp_acs_url},
        ldap_url        = ${b.ldapUrl ?? cur.ldap_url},
        ldap_bind_dn    = ${b.ldapBindDn ?? cur.ldap_bind_dn},
        ldap_bind_password = ${nextLdapBindPassword},
        ldap_search_base   = ${b.ldapSearchBase ?? cur.ldap_search_base},
        ldap_search_filter = ${b.ldapSearchFilter ?? cur.ldap_search_filter},
        ldap_group_search_base   = ${b.ldapGroupSearchBase ?? cur.ldap_group_search_base},
        ldap_group_search_filter = ${b.ldapGroupSearchFilter ?? cur.ldap_group_search_filter},
        ldap_tls_enabled = ${b.ldapTlsEnabled ?? cur.ldap_tls_enabled},
        domains         = ${b.domains ?? cur.domains},
        jit_provisioning = ${b.jitProvisioning ?? cur.jit_provisioning},
        enforce         = ${b.enforce ?? cur.enforce},
        group_attribute = ${b.groupAttribute ?? cur.group_attribute},
        group_mappings  = ${JSON.stringify(b.groupMappings ?? cur.group_mappings)},
        default_scopes  = ${b.defaultScopes ?? cur.default_scopes},
        updated_at      = NOW()
      WHERE id = ${request.params.id} AND developer_id = ${request.developer.id}
      RETURNING *
    `;

    await emitEvent(request.developer.id, 'sso.connection.updated', { connectionId: request.params.id });

    return reply.send(connectionToResponse(rows[0]!));
  });

  /** DELETE /v1/sso/connections/:id — delete a connection */
  app.delete<{ Params: { id: string } }>('/v1/sso/connections/:id', async (request, reply) => {
    const sql = getSql();
    const rows = await sql`
      DELETE FROM sso_connections
      WHERE id = ${request.params.id} AND developer_id = ${request.developer.id}
      RETURNING id
    `;
    if (!rows[0]) {
      return reply.status(404).send({ message: 'SSO connection not found', code: 'NOT_FOUND', requestId: request.id });
    }

    await emitEvent(request.developer.id, 'sso.connection.deleted', { connectionId: request.params.id });

    return reply.status(204).send();
  });

  /** POST /v1/sso/connections/:id/test — test an SSO connection */
  app.post<{ Params: { id: string } }>('/v1/sso/connections/:id/test', async (request, reply) => {
    const sql = getSql();
    const rows = await sql<SsoConnectionRow[]>`
      SELECT * FROM sso_connections
      WHERE id = ${request.params.id} AND developer_id = ${request.developer.id}
    `;
    if (!rows[0]) {
      return reply.status(404).send({ message: 'SSO connection not found', code: 'NOT_FOUND', requestId: request.id });
    }
    const conn = rows[0];

    if (conn.protocol === 'oidc') {
      try {
        const doc = await discoverOidcProvider(conn.issuer_url!);
        return reply.send({
          success: true,
          protocol: 'oidc',
          issuer: doc.issuer,
          authorizationEndpoint: doc.authorization_endpoint,
          tokenEndpoint: doc.token_endpoint,
          jwksUri: doc.jwks_uri,
        });
      } catch (err) {
        return reply.status(422).send({
          success: false,
          protocol: 'oidc',
          error: err instanceof Error ? err.message : 'Discovery failed',
        });
      }
    }

    if (conn.protocol === 'saml') {
      // SAML: validate certificate is parseable
      try {
        const certPem = conn.idp_certificate!.includes('BEGIN CERTIFICATE')
          ? conn.idp_certificate!
          : `-----BEGIN CERTIFICATE-----\n${conn.idp_certificate!}\n-----END CERTIFICATE-----`;
        new crypto.X509Certificate(certPem);
        return reply.send({
          success: true,
          protocol: 'saml',
          idpEntityId: conn.idp_entity_id,
          idpSsoUrl: conn.idp_sso_url,
        });
      } catch {
        return reply.status(422).send({
          success: false,
          protocol: 'saml',
          error: 'Invalid IdP certificate',
        });
      }
    }

    // LDAP: test connectivity
    const ldapResult = await testLdapConnection({
      ldapUrl: conn.ldap_url!,
      bindDn: conn.ldap_bind_dn!,
      bindPassword: decryptSsoSecret(conn.ldap_bind_password, 'sso_connections.ldap_bind_password')!,
      searchBase: conn.ldap_search_base!,
      searchFilter: conn.ldap_search_filter ?? '(uid={{username}})',
      tlsEnabled: conn.ldap_tls_enabled,
    });
    if (ldapResult.success) {
      return reply.send({
        success: true,
        protocol: 'ldap',
        ldapUrl: conn.ldap_url,
        ldapSearchBase: conn.ldap_search_base,
        ldapTlsEnabled: conn.ldap_tls_enabled,
      });
    }
    return reply.status(422).send({
      success: false,
      protocol: 'ldap',
      error: ldapResult.error ?? 'LDAP connection failed',
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // SSO enforcement
  // ══════════════════════════════════════════════════════════════════════════

  /** POST /v1/sso/enforce — enable or disable org-wide SSO enforcement */
  app.post<{ Body: { enforce: boolean } }>('/v1/sso/enforce', async (request, reply) => {
    const { enforce } = request.body ?? {};
    if (typeof enforce !== 'boolean') {
      return reply.status(400).send({ message: 'enforce (boolean) is required', code: 'BAD_REQUEST', requestId: request.id });
    }
    // Update all active connections for this org
    const sql = getSql();
    await sql`
      UPDATE sso_connections
      SET enforce = ${enforce}, updated_at = NOW()
      WHERE developer_id = ${request.developer.id} AND status = 'active'
    `;
    return reply.send({ enforce, developerId: request.developer.id });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // SSO sessions
  // ══════════════════════════════════════════════════════════════════════════

  /** GET /v1/sso/sessions — list active SSO sessions for this org */
  app.get('/v1/sso/sessions', async (request, reply) => {
    const sql = getSql();
    const rows = await sql<Array<Record<string, unknown>>>`
      SELECT * FROM sso_sessions
      WHERE developer_id = ${request.developer.id}
        AND expires_at > NOW()
      ORDER BY created_at DESC
    `;
    return reply.send({
      sessions: rows.map((r) => ({
        id: r['id'],
        connectionId: r['connection_id'],
        principalId: r['principal_id'],
        email: r['email'],
        name: r['name'],
        idpSubject: r['idp_subject'],
        groups: r['groups'],
        mappedScopes: r['mapped_scopes'],
        expiresAt: r['expires_at'],
        createdAt: r['created_at'],
      })),
    });
  });

  /** DELETE /v1/sso/sessions/:id — revoke an SSO session */
  app.delete<{ Params: { id: string } }>('/v1/sso/sessions/:id', async (request, reply) => {
    const sql = getSql();
    const rows = await sql`
      DELETE FROM sso_sessions
      WHERE id = ${request.params.id} AND developer_id = ${request.developer.id}
      RETURNING id
    `;
    if (!rows[0]) {
      return reply.status(404).send({ message: 'SSO session not found', code: 'NOT_FOUND', requestId: request.id });
    }
    return reply.status(204).send();
  });

  // ══════════════════════════════════════════════════════════════════════════
  // SSO login flow (public — no API-key auth)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * GET /sso/login?org=<developerId>&domain=<emailDomain>
   * Returns the IdP authorization URL. Supports OIDC (redirect) and SAML (POST binding).
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

      const domain = query['domain'];
      const conn = await resolveConnection(org, domain);
      if (!conn) {
        return reply.status(404).send({ message: 'SSO not configured for this org', code: 'NOT_FOUND' });
      }

      const requestedRedirectUri = query['redirect_uri'];
      if (requestedRedirectUri) {
        const redirectError = validateOptionalRedirectUri(requestedRedirectUri, 'redirect_uri');
        if (redirectError) {
          return reply.status(400).send({ message: redirectError, code: 'BAD_REQUEST', requestId: request.id });
        }
      }

      const state = signSsoState({
        org,
        connectionId: conn.id,
        ...(requestedRedirectUri ? { redirectUri: requestedRedirectUri } : {}),
      });

      if (conn.protocol === 'oidc') {
        // Use OIDC Discovery to get the authorization endpoint
        let authorizeEndpoint: string;
        try {
          const discovery = await discoverOidcProvider(conn.issuer_url!);
          authorizeEndpoint = discovery.authorization_endpoint;
        } catch {
          // Fallback to /authorize
          authorizeEndpoint = `${conn.issuer_url!}/authorize`;
        }
        const endpointError = validateSsoHttpUrl(authorizeEndpoint, 'authorization_endpoint');
        if (endpointError) {
          return reply.status(400).send({ message: endpointError, code: 'BAD_REQUEST', requestId: request.id });
        }

        const authorizeUrl = new URL(authorizeEndpoint);
        authorizeUrl.searchParams.set('client_id', conn.client_id!);
        authorizeUrl.searchParams.set('redirect_uri', requestedRedirectUri ?? '');
        authorizeUrl.searchParams.set('response_type', 'code');
        authorizeUrl.searchParams.set('scope', 'openid email profile');
        authorizeUrl.searchParams.set('state', state);

        return reply.send({ authorizeUrl: authorizeUrl.toString(), protocol: 'oidc', connectionId: conn.id });
      }

      if (conn.protocol === 'saml') {
        try {
          const authorizeUrl = await generateSamlAuthorizeUrl(samlConnectionOptions(conn), state);
          return reply.send({ authorizeUrl, protocol: 'saml', connectionId: conn.id });
        } catch {
          return reply.status(502).send({
            message: 'SAML login initialization failed',
            code: 'SSO_ERROR',
            requestId: request.id,
          });
        }
      }

      // LDAP: no redirect flow — return connection info for direct credential submission
      return reply.send({
        protocol: 'ldap',
        connectionId: conn.id,
        ldapUrl: conn.ldap_url,
        message: 'LDAP connections require direct credential submission to POST /sso/callback/ldap',
      });
    },
  );

  /**
   * POST /sso/callback/oidc — OIDC callback with proper ID-token verification.
   * Accepts { code, state } and returns authenticated user info + session.
   */
  app.post(
    '/sso/callback/oidc',
    { config: { skipAuth: true, rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, string>;
      const { code, state, redirect_uri: redirectUri } = body;

      if (!code || !state) {
        return reply.status(400).send({ message: 'code and state are required', code: 'BAD_REQUEST' });
      }

      const statePayload = verifySsoState(state);
      if (!statePayload) {
        return reply.status(400).send({ message: 'Invalid state parameter', code: 'BAD_REQUEST', requestId: request.id });
      }
      const stateData = statePayload as unknown as { org: string; connectionId: string; redirectUri?: string };
      // OIDC callback handlers commonly forward only `code` and `state` from
      // the IdP, so the body's redirect_uri may be absent. The signed state
      // already integrity-protects the value supplied at /sso/login, so fall
      // back to it when the body omits it; only fail when the body provides
      // a different value (tampering attempt).
      const effectiveRedirectUri = redirectUri ?? stateData.redirectUri;
      if (stateData.redirectUri && redirectUri && redirectUri !== stateData.redirectUri) {
        return reply.status(400).send({ message: 'redirect_uri does not match signed state', code: 'BAD_REQUEST', requestId: request.id });
      }
      if (effectiveRedirectUri) {
        const redirectError = validateOptionalRedirectUri(effectiveRedirectUri, 'redirect_uri');
        if (redirectError) {
          return reply.status(400).send({ message: redirectError, code: 'BAD_REQUEST', requestId: request.id });
        }
      }

      const sql = getSql();
      const rows = await sql<SsoConnectionRow[]>`
        SELECT * FROM sso_connections
        WHERE id = ${stateData.connectionId}
          AND developer_id = ${stateData.org}
          AND protocol = 'oidc'
          AND status = 'active'
      `;
      if (!rows[0]) {
        return reply.status(404).send({ message: 'SSO connection not found', code: 'NOT_FOUND' });
      }
      const conn = rows[0];

      // Discover the token endpoint
      let tokenEndpoint: string;
      try {
        const discovery = await discoverOidcProvider(conn.issuer_url!);
        tokenEndpoint = discovery.token_endpoint;
      } catch {
        tokenEndpoint = `${conn.issuer_url!}/token`;
      }
      const tokenEndpointError = validateSsoHttpUrl(tokenEndpoint, 'token_endpoint');
      if (tokenEndpointError) {
        return reply.status(400).send({ message: tokenEndpointError, code: 'BAD_REQUEST', requestId: request.id });
      }

      // Exchange authorization code for tokens
      const tokenRes = await safeFetch(tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: effectiveRedirectUri ?? '',
          client_id: conn.client_id!,
          client_secret: decryptSsoSecret(conn.client_secret, 'sso_connections.client_secret')!,
        }).toString(),
      }, {
        allowedProtocols: ['https:', 'http:'],
        allowInsecureHttp: config.allowInsecureSsoUrls,
        allowPrivateHosts: config.allowPrivateSsoHosts,
      });

      if (!tokenRes.ok) {
        return reply.status(502).send({ message: 'Token exchange failed', code: 'SSO_ERROR' });
      }

      const tokenData = (await tokenRes.json()) as Record<string, unknown>;
      const idToken = String(tokenData['id_token'] ?? '');

      // Verify ID token signature via JWKS
      let claims: Record<string, unknown>;
      try {
        claims = await verifyIdToken(idToken, conn.issuer_url!, conn.client_id!) as unknown as Record<string, unknown>;
      } catch {
        return reply.status(502).send({ message: 'ID token verification failed', code: 'SSO_ERROR' });
      }

      // Extract groups from the configured attribute
      const groups: string[] = [];
      if (conn.group_attribute && claims[conn.group_attribute]) {
        const raw = claims[conn.group_attribute];
        if (Array.isArray(raw)) groups.push(...raw.map(String));
        else groups.push(String(raw));
      }

      // Map groups to scopes
      const mappedScopes = mapGroupsToScopes(groups, conn.group_mappings, conn.default_scopes);

      // JIT provisioning
      const claimEmail = typeof claims['email'] === 'string' ? claims['email'] : undefined;
      const claimName = typeof claims['name'] === 'string' ? claims['name'] : undefined;

      let principalId: string | undefined;
      if (conn.jit_provisioning) {
        principalId = await jitProvision(stateData.org, {
          sub: String(claims['sub']),
          ...(claimEmail !== undefined ? { email: claimEmail } : {}),
          ...(claimName !== undefined ? { name: claimName } : {}),
        });
      }

      // Create SSO session
      const session = await createSsoSession({
        developerId: stateData.org,
        connectionId: conn.id,
        ...(principalId !== undefined ? { principalId } : {}),
        ...(claimEmail !== undefined ? { email: claimEmail } : {}),
        ...(claimName !== undefined ? { name: claimName } : {}),
        idpSubject: String(claims['sub']),
        groups,
        mappedScopes,
      });

      await emitEvent(stateData.org, 'sso.login', {
        connectionId: conn.id,
        protocol: 'oidc',
        sessionId: session.id,
        email: claims['email'] ?? null,
      });

      return reply.send({
        sessionId: session.id,
        email: claims['email'] ?? null,
        name: claims['name'] ?? null,
        sub: claims['sub'] ?? null,
        groups,
        mappedScopes,
        principalId: principalId ?? null,
        developerId: stateData.org,
        expiresAt: session.expires_at,
      });
    },
  );

  /**
   * POST /sso/callback/saml — SAML callback.
   * Accepts { SAMLResponse, RelayState } and returns authenticated user info + session.
   */
  app.post(
    '/sso/callback/saml',
    { config: { skipAuth: true, rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, string>;
      const { SAMLResponse, RelayState } = body;

      if (!SAMLResponse || !RelayState) {
        return reply.status(400).send({ message: 'SAMLResponse and RelayState are required', code: 'BAD_REQUEST' });
      }

      const statePayload = verifySsoState(RelayState);
      if (!statePayload) {
        return reply.status(400).send({ message: 'Invalid RelayState', code: 'BAD_REQUEST', requestId: request.id });
      }
      const stateData = statePayload as unknown as { org: string; connectionId: string };

      const sql = getSql();
      const rows = await sql<SsoConnectionRow[]>`
        SELECT * FROM sso_connections
        WHERE id = ${stateData.connectionId}
          AND developer_id = ${stateData.org}
          AND protocol = 'saml'
          AND status = 'active'
      `;
      if (!rows[0]) {
        return reply.status(404).send({ message: 'SSO connection not found', code: 'NOT_FOUND' });
      }
      const conn = rows[0];

      // Parse and verify SAML response
      let attributes;
      try {
        attributes = await parseSamlResponse(SAMLResponse, samlConnectionOptions(conn));
      } catch {
        return reply.status(502).send({
          message: 'SAML response verification failed',
          code: 'SSO_ERROR',
          requestId: request.id,
        });
      }

      // Extract groups
      const groups = attributes.groups ?? [];

      // Map groups to scopes
      const mappedScopes = mapGroupsToScopes(groups, conn.group_mappings, conn.default_scopes);

      // JIT provisioning
      let principalId: string | undefined;
      if (conn.jit_provisioning) {
        principalId = await jitProvision(stateData.org, {
          sub: attributes.sub,
          ...(attributes.email !== undefined ? { email: attributes.email } : {}),
          ...(attributes.name !== undefined ? { name: attributes.name } : {}),
        });
      }

      // Create SSO session
      const session = await createSsoSession({
        developerId: stateData.org,
        connectionId: conn.id,
        ...(principalId !== undefined ? { principalId } : {}),
        ...(attributes.email !== undefined ? { email: attributes.email } : {}),
        ...(attributes.name !== undefined ? { name: attributes.name } : {}),
        idpSubject: attributes.sub,
        groups,
        mappedScopes,
      });

      await emitEvent(stateData.org, 'sso.login', {
        connectionId: conn.id,
        protocol: 'saml',
        sessionId: session.id,
        email: attributes.email ?? null,
      });

      return reply.send({
        sessionId: session.id,
        email: attributes.email ?? null,
        name: attributes.name ?? null,
        sub: attributes.sub,
        groups,
        mappedScopes,
        principalId: principalId ?? null,
        developerId: stateData.org,
        expiresAt: session.expires_at,
      });
    },
  );

  /**
   * POST /sso/callback/ldap — LDAP callback (username + password bind).
   * Unlike OIDC/SAML, LDAP has no redirect flow; the client submits credentials directly.
   */
  app.post(
    '/sso/callback/ldap',
    { config: { skipAuth: true, rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, string>;
      const { username, password, connectionId, org } = body;

      if (!username || !password || !connectionId || !org) {
        return reply.status(400).send({ message: 'username, password, connectionId, and org are required', code: 'BAD_REQUEST' });
      }

      const sql = getSql();
      const rows = await sql<SsoConnectionRow[]>`
        SELECT * FROM sso_connections
        WHERE id = ${connectionId}
          AND developer_id = ${org}
          AND protocol = 'ldap'
          AND status = 'active'
      `;
      if (!rows[0]) {
        return reply.status(404).send({ message: 'LDAP connection not found', code: 'NOT_FOUND' });
      }
      const conn = rows[0];

      const ldapConfig: LdapConfig = {
        ldapUrl: conn.ldap_url!,
        bindDn: conn.ldap_bind_dn!,
        bindPassword: decryptSsoSecret(conn.ldap_bind_password, 'sso_connections.ldap_bind_password')!,
        searchBase: conn.ldap_search_base!,
        searchFilter: conn.ldap_search_filter ?? '(uid={{username}})',
        ...(conn.ldap_group_search_base ? { groupSearchBase: conn.ldap_group_search_base } : {}),
        ...(conn.ldap_group_search_filter ? { groupSearchFilter: conn.ldap_group_search_filter } : {}),
        tlsEnabled: conn.ldap_tls_enabled,
      };

      let userInfo;
      try {
        userInfo = await authenticateLdap(ldapConfig, username, password);
      } catch (err) {
        return reply.status(401).send({
          message: err instanceof Error ? err.message : 'LDAP authentication failed',
          code: 'SSO_AUTH_FAILED',
        });
      }

      // Map groups to scopes
      const mappedScopes = mapGroupsToScopes(userInfo.groups, conn.group_mappings, conn.default_scopes);

      // JIT provisioning
      let principalId: string | undefined;
      if (conn.jit_provisioning) {
        principalId = await jitProvision(org, {
          sub: userInfo.dn,
          ...(userInfo.email !== undefined ? { email: userInfo.email } : {}),
          ...(userInfo.displayName !== undefined ? { name: userInfo.displayName } : {}),
        });
      }

      // Create SSO session
      const session = await createSsoSession({
        developerId: org,
        connectionId: conn.id,
        ...(principalId !== undefined ? { principalId } : {}),
        ...(userInfo.email !== undefined ? { email: userInfo.email } : {}),
        ...(userInfo.displayName !== undefined ? { name: userInfo.displayName } : {}),
        idpSubject: userInfo.dn,
        groups: userInfo.groups,
        mappedScopes,
      });

      await emitEvent(org, 'sso.login', {
        connectionId: conn.id,
        protocol: 'ldap',
        sessionId: session.id,
        email: userInfo.email ?? null,
      });

      return reply.send({
        sessionId: session.id,
        email: userInfo.email ?? null,
        name: userInfo.displayName ?? null,
        sub: userInfo.dn,
        groups: userInfo.groups,
        mappedScopes,
        principalId: principalId ?? null,
        developerId: org,
        expiresAt: session.expires_at,
      });
    },
  );

  // ══════════════════════════════════════════════════════════════════════════
  // Legacy endpoints (backward compatibility with basic SSO)
  // ══════════════════════════════════════════════════════════════════════════

  /** POST /v1/sso/config — legacy: create or update OIDC SSO config */
  app.post<{
    Body: { issuerUrl: string; clientId: string; clientSecret: string; redirectUri: string };
  }>('/v1/sso/config', async (request, reply) => {
    const { issuerUrl, clientId, clientSecret, redirectUri } = request.body ?? {};
    if (!issuerUrl || !clientId || !clientSecret || !redirectUri) {
      return reply.status(400).send({ message: 'issuerUrl, clientId, clientSecret, and redirectUri are required', code: 'BAD_REQUEST', requestId: request.id });
    }
    const issuerError = validateSsoHttpUrl(issuerUrl, 'issuerUrl');
    const redirectError = validateOptionalRedirectUri(redirectUri, 'redirectUri');
    if (issuerError || redirectError) {
      return reply.status(400).send({ message: [issuerError, redirectError].filter(Boolean).join('; '), code: 'BAD_REQUEST', requestId: request.id });
    }

    const sql = getSql();
    const encryptedClientSecret = encryptSsoSecret(clientSecret);
    const rows = await sql<Array<Record<string, unknown>>>`
      INSERT INTO sso_configs (developer_id, issuer_url, client_id, client_secret, redirect_uri)
      VALUES (${request.developer.id}, ${issuerUrl}, ${clientId}, ${encryptedClientSecret}, ${redirectUri})
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

  /** GET /v1/sso/config — legacy: get OIDC SSO config */
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

  /** DELETE /v1/sso/config — legacy: remove SSO config */
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

  /**
   * GET /sso/login?org=<developerId> — legacy: returns OIDC authorize URL
   * (still works via resolveConnection fallback)
   */
  // Note: The /sso/login route above already handles the legacy case via resolveConnection.

  /**
   * GET /sso/callback?code=<code>&state=<state> — legacy: OIDC callback
   * (kept for backward compatibility with existing integrations)
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
      const statePayload = verifySsoState(state);
      if (!statePayload) {
        return reply.status(400).send({ message: 'Invalid state parameter', code: 'BAD_REQUEST' });
      }
      org = statePayload['org'] as string;

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
      const issuerUrl = String(cfg['issuer_url']);
      const tokenEndpoint = `${issuerUrl.replace(/\/$/, '')}/token`;
      const tokenEndpointError = validateSsoHttpUrl(tokenEndpoint, 'token_endpoint');
      if (tokenEndpointError) {
        return reply.status(400).send({ message: tokenEndpointError, code: 'BAD_REQUEST', requestId: request.id });
      }

      const tokenRes = await safeFetch(tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: String(cfg['redirect_uri']),
          client_id: String(cfg['client_id']),
          client_secret: decryptSsoSecret(String(cfg['client_secret']), 'sso_configs.client_secret')!,
        }).toString(),
      }, {
        allowedProtocols: ['https:', 'http:'],
        allowInsecureHttp: config.allowInsecureSsoUrls,
        allowPrivateHosts: config.allowPrivateSsoHosts,
      });

      if (!tokenRes.ok) {
        return reply.status(502).send({ message: 'Token exchange failed', code: 'SSO_ERROR' });
      }

      const tokenData = (await tokenRes.json()) as Record<string, unknown>;
      const idToken = String(tokenData['id_token'] ?? '');

      let claims: Record<string, unknown>;
      try {
        claims = await verifyIdToken(idToken, issuerUrl, String(cfg['client_id'])) as unknown as Record<string, unknown>;
      } catch {
        return reply.status(502).send({ message: 'ID token verification failed', code: 'SSO_ERROR' });
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
