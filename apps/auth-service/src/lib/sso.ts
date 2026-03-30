/**
 * Enterprise SSO library — OIDC Discovery, ID-token verification (JWKS),
 * SAML 2.0 response parsing/verification, JIT provisioning, group→scope
 * mapping, domain-based connection resolution, and session management.
 */
import * as jose from 'jose';
import { createVerify } from 'node:crypto';
import crypto from 'node:crypto';
import { getSql } from '../db/client.js';
import { newSsoSessionId, newScimUserId } from './ids.js';

// ── Types ─────────────────────────────────────────────────────────────────

export interface OidcDiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
}

export interface SsoConnectionRow {
  id: string;
  developer_id: string;
  name: string;
  protocol: 'oidc' | 'saml' | 'ldap';
  status: 'active' | 'inactive' | 'testing';
  issuer_url: string | null;
  client_id: string | null;
  client_secret: string | null;
  idp_entity_id: string | null;
  idp_sso_url: string | null;
  idp_certificate: string | null;
  sp_entity_id: string | null;
  sp_acs_url: string | null;
  ldap_url: string | null;
  ldap_bind_dn: string | null;
  ldap_bind_password: string | null;
  ldap_search_base: string | null;
  ldap_search_filter: string | null;
  ldap_group_search_base: string | null;
  ldap_group_search_filter: string | null;
  ldap_tls_enabled: boolean;
  domains: string[];
  jit_provisioning: boolean;
  enforce: boolean;
  group_attribute: string | null;
  group_mappings: Record<string, string[]>;
  default_scopes: string[];
  created_at: string;
  updated_at: string;
}

export interface IdTokenClaims {
  sub: string;
  email?: string;
  name?: string;
  groups?: string[];
  [key: string]: unknown;
}

export interface SamlAttributes {
  sub: string;
  email?: string;
  name?: string;
  groups?: string[];
}

export interface SsoSessionRow {
  id: string;
  developer_id: string;
  connection_id: string;
  principal_id: string | null;
  email: string | null;
  name: string | null;
  idp_subject: string;
  groups: string[];
  mapped_scopes: string[];
  expires_at: string;
  created_at: string;
}

// ── Discovery cache (in-memory, 1 hour TTL) ──────────────────────────────

const discoveryCache = new Map<string, { doc: OidcDiscoveryDocument; fetchedAt: number }>();
const DISCOVERY_TTL_MS = 3600_000;

/**
 * Fetch and cache the OIDC Discovery document from the issuer's
 * `.well-known/openid-configuration` endpoint.
 */
export async function discoverOidcProvider(issuerUrl: string): Promise<OidcDiscoveryDocument> {
  const cached = discoveryCache.get(issuerUrl);
  if (cached && Date.now() - cached.fetchedAt < DISCOVERY_TTL_MS) {
    return cached.doc;
  }

  const url = `${issuerUrl.replace(/\/$/, '')}/.well-known/openid-configuration`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`OIDC discovery failed for ${issuerUrl}: ${res.status}`);
  }

  const doc = (await res.json()) as OidcDiscoveryDocument;
  discoveryCache.set(issuerUrl, { doc, fetchedAt: Date.now() });
  return doc;
}

/** Clear the discovery cache (useful in tests). */
export function clearDiscoveryCache(): void {
  discoveryCache.clear();
}

// ── OIDC ID-token verification ────────────────────────────────────────────

const jwksCache = new Map<string, { keySet: jose.JSONWebKeySet; fetchedAt: number }>();
const JWKS_TTL_MS = 3600_000;

/**
 * Verify an OIDC ID token's signature using the IdP's JWKS, and return the
 * payload claims. Rejects if the token is expired, malformed, or the
 * signature doesn't match.
 */
export async function verifyIdToken(
  idToken: string,
  issuerUrl: string,
  clientId: string,
): Promise<IdTokenClaims> {
  const discovery = await discoverOidcProvider(issuerUrl);
  const jwksUri = discovery.jwks_uri;

  // Fetch or use cached JWKS
  let jwks = jwksCache.get(jwksUri);
  if (!jwks || Date.now() - jwks.fetchedAt > JWKS_TTL_MS) {
    const res = await fetch(jwksUri);
    if (!res.ok) {
      throw new Error(`Failed to fetch JWKS from ${jwksUri}: ${res.status}`);
    }
    const keySet = (await res.json()) as jose.JSONWebKeySet;
    jwks = { keySet, fetchedAt: Date.now() };
    jwksCache.set(jwksUri, jwks);
  }

  const JWKS = jose.createLocalJWKSet(jwks.keySet);

  const { payload } = await jose.jwtVerify(idToken, JWKS, {
    issuer: discovery.issuer,
    audience: clientId,
  });

  return payload as unknown as IdTokenClaims;
}

/** Clear JWKS cache (useful in tests). */
export function clearJwksCache(): void {
  jwksCache.clear();
}

// ── SAML 2.0 Response parsing ─────────────────────────────────────────────

/**
 * Parse a base64-encoded SAML Response, verify the signature against the
 * IdP certificate, and extract user attributes.
 *
 * Supports the most common SAML assertion format with X.509 certificate-based
 * signatures.
 */
export function parseSamlResponse(
  samlResponseB64: string,
  idpCertificate: string,
): SamlAttributes {
  // Limit input size to prevent ReDoS on large payloads (1 MB max)
  if (samlResponseB64.length > 1_048_576) {
    throw new Error('SAML Response exceeds maximum size');
  }

  const xml = Buffer.from(samlResponseB64, 'base64').toString('utf-8');

  // Extract NameID (subject) — linear regex, no backtracking risk
  const nameIdMatch = xml.match(/<(?:saml2?:)?NameID[^>]*>([^<]+)<\/(?:saml2?:)?NameID>/);
  if (!nameIdMatch) {
    throw new Error('SAML Response missing NameID');
  }

  // Verify the signature exists — linear regex
  const sigValueMatch = xml.match(
    /<(?:ds:)?SignatureValue[^>]*>([^<]+)<\/(?:ds:)?SignatureValue>/,
  );
  if (!sigValueMatch) {
    throw new Error('SAML Response missing signature');
  }

  // Verify signature using the IdP certificate
  const certPem = idpCertificate.includes('BEGIN CERTIFICATE')
    ? idpCertificate
    : `-----BEGIN CERTIFICATE-----\n${idpCertificate}\n-----END CERTIFICATE-----`;

  try {
    const x509 = new crypto.X509Certificate(certPem);
    if (new Date(x509.validTo) < new Date()) {
      throw new Error('IdP certificate has expired');
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('expired')) throw err;
    throw new Error('Invalid IdP certificate');
  }

  // Verify the SignedInfo digest using the IdP certificate
  // Use indexOf+indexOf instead of regex with [\s\S]*? to avoid ReDoS
  const signedInfoStart = xml.indexOf('<SignedInfo');
  const dsSignedInfoStart = xml.indexOf('<ds:SignedInfo');
  const siStart = signedInfoStart >= 0 ? signedInfoStart : dsSignedInfoStart;

  if (siStart >= 0) {
    const siEndTag = xml.indexOf('</SignedInfo>', siStart);
    const dsSiEndTag = xml.indexOf('</ds:SignedInfo>', siStart);
    const siEnd = siEndTag >= 0 ? siEndTag + '</SignedInfo>'.length : (dsSiEndTag >= 0 ? dsSiEndTag + '</ds:SignedInfo>'.length : -1);

    if (siEnd > siStart) {
      const signedInfoXml = xml.slice(siStart, siEnd);
      const signatureValue = Buffer.from(sigValueMatch[1]!.replace(/\s/g, ''), 'base64');
      const verifier = createVerify('RSA-SHA256');
      verifier.update(signedInfoXml);
      const valid = verifier.verify(certPem, signatureValue);
      if (!valid) {
        throw new Error('SAML Response signature verification failed');
      }
    }
  }

  // Extract attributes
  const attributes: SamlAttributes = {
    sub: nameIdMatch[1]!,
  };

  // Use a helper to extract SAML attribute values by name — avoids ReDoS-prone [\s\S]*? patterns
  const extractAttrValue = (attrName: string): string | undefined => {
    const idx = xml.indexOf(`Name="${attrName}"`);
    if (idx < 0) return undefined;
    const afterAttr = xml.indexOf('<', idx + attrName.length + 7);
    if (afterAttr < 0) return undefined;
    const valueTagEnd = xml.indexOf('>', afterAttr);
    if (valueTagEnd < 0) return undefined;
    const valueStart = valueTagEnd + 1;
    const valueEnd = xml.indexOf('<', valueStart);
    if (valueEnd < 0) return undefined;
    const value = xml.slice(valueStart, valueEnd).trim();
    return value || undefined;
  };

  // Extract email
  const email = extractAttrValue('email')
    ?? extractAttrValue('http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress');
  if (email) attributes.email = email;

  // Extract name / displayName
  const name = extractAttrValue('displayName')
    ?? extractAttrValue('http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name');
  if (name) attributes.name = name;

  // Extract groups — use indexOf-based iteration instead of regex with [\s\S]*?
  const groups: string[] = [];
  for (const groupAttrName of [
    'group', 'groups',
    'http://schemas.microsoft.com/ws/2008/06/identity/claims/group',
    'http://schemas.microsoft.com/ws/2008/06/identity/claims/groups',
  ]) {
    let searchFrom = 0;
    while (true) {
      const idx = xml.indexOf(`Name="${groupAttrName}"`, searchFrom);
      if (idx < 0) break;
      const val = extractAttrValue(groupAttrName);
      if (val) groups.push(val);
      searchFrom = idx + 1;
    }
  }
  if (groups.length > 0) attributes.groups = groups;

  // Check assertion conditions (NotOnOrAfter) — linear regex
  const conditionsMatch = xml.match(/NotOnOrAfter="([^"]+)"/);
  if (conditionsMatch) {
    const notOnOrAfter = new Date(conditionsMatch[1]!);
    if (notOnOrAfter < new Date()) {
      throw new Error('SAML assertion has expired');
    }
  }

  return attributes;
}

// ── Domain-based connection resolution ────────────────────────────────────

/**
 * Find the active SSO connection for a developer, optionally filtered by
 * email domain. If a domain is provided, returns the connection whose
 * `domains` array contains that domain.
 */
export async function resolveConnection(
  developerId: string,
  domain?: string,
): Promise<SsoConnectionRow | null> {
  const sql = getSql();

  if (domain) {
    const rows = await sql<SsoConnectionRow[]>`
      SELECT * FROM sso_connections
      WHERE developer_id = ${developerId}
        AND status = 'active'
        AND ${domain} = ANY(domains)
      LIMIT 1
    `;
    if (rows[0]) return rows[0];
  }

  // Fall back to first active connection for the org
  const rows = await sql<SsoConnectionRow[]>`
    SELECT * FROM sso_connections
    WHERE developer_id = ${developerId}
      AND status = 'active'
    ORDER BY created_at ASC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

// ── Group → scope mapping ─────────────────────────────────────────────────

/**
 * Map IdP groups to Grantex scopes using the connection's group_mappings.
 * Returns the union of all matched scopes + default_scopes as a fallback.
 */
export function mapGroupsToScopes(
  groups: string[],
  groupMappings: Record<string, string[]>,
  defaultScopes: string[],
): string[] {
  const scopes = new Set<string>();

  for (const group of groups) {
    const mapped = groupMappings[group];
    if (mapped) {
      for (const scope of mapped) scopes.add(scope);
    }
  }

  // If no groups matched, fall back to default scopes
  if (scopes.size === 0) {
    for (const scope of defaultScopes) scopes.add(scope);
  }

  return [...scopes];
}

// ── JIT provisioning ──────────────────────────────────────────────────────

/**
 * Just-in-Time provisioning: create or update a principal (SCIM user) when
 * they authenticate via SSO for the first time. Returns the principal ID.
 */
export async function jitProvision(
  developerId: string,
  userInfo: { sub: string; email?: string; name?: string },
): Promise<string> {
  const sql = getSql();

  // Check if the user already exists (by external_id = IdP subject)
  const existing = await sql<Array<{ id: string }>>`
    SELECT id FROM scim_users
    WHERE developer_id = ${developerId}
      AND external_id = ${userInfo.sub}
    LIMIT 1
  `;

  if (existing[0]) {
    // Update existing user
    await sql`
      UPDATE scim_users
      SET display_name = ${userInfo.name ?? null},
          user_name    = ${userInfo.email ?? userInfo.sub},
          updated_at   = NOW()
      WHERE id = ${existing[0].id}
    `;
    return existing[0].id;
  }

  // Create new user
  const id = newScimUserId();
  await sql`
    INSERT INTO scim_users (id, developer_id, external_id, user_name, display_name, active)
    VALUES (${id}, ${developerId}, ${userInfo.sub}, ${userInfo.email ?? userInfo.sub}, ${userInfo.name ?? null}, true)
  `;
  return id;
}

// ── Session management ────────────────────────────────────────────────────

export interface CreateSsoSessionParams {
  developerId: string;
  connectionId: string;
  principalId?: string;
  email?: string;
  name?: string;
  idpSubject: string;
  groups: string[];
  mappedScopes: string[];
  expiresInSeconds?: number;
}

/**
 * Create an SSO session record for tracking and audit purposes.
 * Default session duration: 8 hours.
 */
export async function createSsoSession(params: CreateSsoSessionParams): Promise<SsoSessionRow> {
  const sql = getSql();
  const id = newSsoSessionId();
  const expiresAt = new Date(
    Date.now() + (params.expiresInSeconds ?? 28800) * 1000,
  ).toISOString();

  const rows = await sql<SsoSessionRow[]>`
    INSERT INTO sso_sessions (
      id, developer_id, connection_id, principal_id, email, name,
      idp_subject, groups, mapped_scopes, expires_at
    ) VALUES (
      ${id}, ${params.developerId}, ${params.connectionId},
      ${params.principalId ?? null}, ${params.email ?? null}, ${params.name ?? null},
      ${params.idpSubject}, ${params.groups}, ${params.mappedScopes}, ${expiresAt}
    )
    RETURNING *
  `;

  return rows[0]!;
}
