/**
 * Enterprise SSO library — OIDC Discovery, ID-token verification (JWKS),
 * SAML 2.0 response parsing/verification, JIT provisioning, group→scope
 * mapping, domain-based connection resolution, and session management.
 */
import * as jose from 'jose';
import { X509Certificate } from 'node:crypto';
import {
  SAML,
  ValidateInResponseTo,
  type CacheItem,
  type CacheProvider,
  type Profile,
} from '@node-saml/node-saml';
import { getSql } from '../db/client.js';
import { getRedis } from '../redis/client.js';
import { newSsoSessionId, newScimUserId } from './ids.js';
import { config } from '../config.js';
import { safeFetch, validateOutboundUrl } from './url-security.js';

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

  const issuer = validateOutboundUrl(issuerUrl, {
    allowedProtocols: ['https:', 'http:'],
    allowInsecureHttp: config.allowInsecureSsoUrls,
    allowPrivateHosts: config.allowPrivateSsoHosts,
  });
  const url = `${issuer.toString().replace(/\/$/, '')}/.well-known/openid-configuration`;
  const res = await safeFetch(url, {}, {
    allowedProtocols: ['https:', 'http:'],
    allowInsecureHttp: config.allowInsecureSsoUrls,
    allowPrivateHosts: config.allowPrivateSsoHosts,
  });
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
    const res = await safeFetch(jwksUri, {}, {
      allowedProtocols: ['https:', 'http:'],
      allowInsecureHttp: config.allowInsecureSsoUrls,
      allowPrivateHosts: config.allowPrivateSsoHosts,
    });
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

const SAML_REQUEST_TTL_MS = 10 * 60_000;
const SAML_RESPONSE_MAX_BASE64_BYTES = 1_048_576;
const SAML_BEARER_CONFIRMATION = 'urn:oasis:names:tc:SAML:2.0:cm:bearer';

export interface SamlConnectionOptions {
  connectionId: string;
  idpCertificate: string;
  idpEntityId: string;
  idpSsoUrl: string;
  spEntityId: string;
  spAcsUrl: string;
  groupAttribute?: string;
}

/**
 * Redis-backed, consume-on-read request cache for SAML InResponseTo checks.
 * Node-SAML reads the request ID twice during validation, so the value is
 * consumed atomically from Redis and retained only in this validator instance.
 */
class RedisSamlRequestCache implements CacheProvider {
  readonly #prefix: string;
  readonly #consumed = new Map<string, string>();

  constructor(connectionId: string) {
    this.#prefix = 'saml:req:' + connectionId + ':';
  }

  async saveAsync(key: string, value: string): Promise<CacheItem | null> {
    if (!isSafeSamlRequestId(key)) {
      throw new Error('Refusing to cache an invalid SAML request ID');
    }
    const stored = await getRedis().set(
      this.#prefix + key,
      value,
      'PX',
      SAML_REQUEST_TTL_MS,
      'NX',
    );
    if (stored !== 'OK') throw new Error('Unable to persist SAML request state');
    return { value, createdAt: Date.now() };
  }

  async getAsync(key: string): Promise<string | null> {
    if (!isSafeSamlRequestId(key)) return null;
    const consumed = this.#consumed.get(key);
    if (consumed !== undefined) return consumed;
    const value = await getRedis().getdel(this.#prefix + key);
    if (value !== null) this.#consumed.set(key, value);
    return value;
  }

  async removeAsync(key: string | null): Promise<string | null> {
    if (key === null || !isSafeSamlRequestId(key)) return null;
    const consumed = this.#consumed.get(key);
    if (consumed !== undefined) {
      this.#consumed.delete(key);
      return consumed;
    }
    return getRedis().getdel(this.#prefix + key);
  }
}

function isSafeSamlRequestId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,256}$/.test(value);
}

function normalizeIdpCertificate(idpCertificate: string): string {
  if (idpCertificate.includes('BEGIN CERTIFICATE')) return idpCertificate;
  const compact = idpCertificate.replace(/\s/g, '');
  return '-----BEGIN CERTIFICATE-----\n' + compact + '\n-----END CERTIFICATE-----';
}

function validateIdpCertificate(idpCertificate: string): void {
  let x509: X509Certificate;
  try {
    x509 = new X509Certificate(normalizeIdpCertificate(idpCertificate));
  } catch {
    throw new Error('Invalid IdP certificate');
  }
  const now = Date.now();
  if (Date.parse(x509.validFrom) > now) throw new Error('IdP certificate is not yet valid');
  if (Date.parse(x509.validTo) <= now) throw new Error('IdP certificate has expired');
}

function createSamlClient(options: SamlConnectionOptions): SAML {
  return new SAML({
    callbackUrl: options.spAcsUrl,
    entryPoint: options.idpSsoUrl,
    issuer: options.spEntityId,
    audience: options.spEntityId,
    idpCert: normalizeIdpCertificate(options.idpCertificate),
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    validateInResponseTo: ValidateInResponseTo.always,
    requestIdExpirationPeriodMs: SAML_REQUEST_TTL_MS,
    cacheProvider: new RedisSamlRequestCache(options.connectionId),
    acceptedClockSkewMs: 60_000,
    maxAssertionAgeMs: SAML_REQUEST_TTL_MS,
    identifierFormat: null,
    signatureAlgorithm: 'sha256',
    digestAlgorithm: 'sha256',
  });
}

/** Generate a standards-compliant Redirect-binding AuthnRequest. */
export async function generateSamlAuthorizeUrl(
  options: SamlConnectionOptions,
  relayState: string,
): Promise<string> {
  return createSamlClient(options).getAuthorizeUrlAsync(relayState, undefined, {});
}

/**
 * Validate a POST-binding SAML response and extract attributes only from the
 * verified assertion. Request IDs are one-time Redis values, preventing replay
 * across service replicas.
 */
export async function parseSamlResponse(
  samlResponseB64: string,
  options: SamlConnectionOptions,
): Promise<SamlAttributes> {
  if (samlResponseB64.length > SAML_RESPONSE_MAX_BASE64_BYTES) {
    throw new Error('SAML Response exceeds maximum size');
  }
  validateIdpCertificate(options.idpCertificate);

  const { profile, loggedOut } = await createSamlClient(options)
    .validatePostResponseAsync({ SAMLResponse: samlResponseB64 });
  if (loggedOut || profile === null) throw new Error('SAML Response missing assertion');
  if (profile.issuer !== options.idpEntityId) throw new Error('SAML issuer mismatch');
  if (!profile.nameID) throw new Error('SAML Response missing NameID');
  if (!hasExpectedBearerRecipient(profile, options.spAcsUrl)) {
    throw new Error('SAML assertion recipient mismatch');
  }

  const email = firstProfileString(profile, [
    'email',
    'mail',
    'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
    'urn:oid:0.9.2342.19200300.100.1.3',
  ]);
  const name = firstProfileString(profile, [
    'displayName',
    'name',
    'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name',
  ]);
  const groupKeys = [
    ...(options.groupAttribute ? [options.groupAttribute] : []),
    'group',
    'groups',
    'http://schemas.microsoft.com/ws/2008/06/identity/claims/group',
    'http://schemas.microsoft.com/ws/2008/06/identity/claims/groups',
  ];
  const groups = [...new Set(groupKeys.flatMap((key) => profileStrings(profile[key])))];

  return {
    sub: profile.nameID,
    ...(email !== undefined ? { email } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(groups.length > 0 ? { groups } : {}),
  };
}

function firstProfileString(profile: Profile, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = profileStrings(profile[key])[0];
    if (value !== undefined) return value;
  }
  return undefined;
}

function profileStrings(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function hasExpectedBearerRecipient(profile: Profile, expectedRecipient: string): boolean {
  const assertionDocument = profile.getAssertion?.();
  const assertion = asRecord(assertionDocument?.['Assertion']);
  for (const subjectValue of asArray(assertion?.['Subject'])) {
    const subject = asRecord(subjectValue);
    for (const confirmationValue of asArray(subject?.['SubjectConfirmation'])) {
      const confirmation = asRecord(confirmationValue);
      const confirmationAttributes = asRecord(confirmation?.['$']);
      if (confirmationAttributes?.['Method'] !== SAML_BEARER_CONFIRMATION) continue;
      for (const dataValue of asArray(confirmation?.['SubjectConfirmationData'])) {
        const data = asRecord(dataValue);
        const attributes = asRecord(data?.['$']);
        if (
          attributes?.['Recipient'] === expectedRecipient
          && typeof attributes['InResponseTo'] === 'string'
          && attributes['InResponseTo'].length > 0
        ) return true;
      }
    }
  }
  return false;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
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
