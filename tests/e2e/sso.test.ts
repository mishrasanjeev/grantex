/**
 * E2E Tests: SSO Connection Management
 *
 * Tests SSO connection CRUD for OIDC, SAML, and LDAP protocols,
 * connection updates, status changes, and validation.
 * Run: npx vitest run tests/e2e/sso.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { Grantex } from '@grantex/sdk';

const BASE_URL = process.env.E2E_BASE_URL ?? 'https://grantex-auth-dd4mtrt2gq-uc.a.run.app';

let grantex: Grantex;
let apiKey: string;

beforeAll(async () => {
  const account = await Grantex.signup({ name: `e2e-sso-${Date.now()}`, mode: 'sandbox' }, { baseUrl: BASE_URL });
  apiKey = account.apiKey;
  grantex = new Grantex({ apiKey, baseUrl: BASE_URL });
});

describe('E2E: SSO OIDC Connection', () => {
  let connectionId: string;

  it('creates an OIDC connection', async () => {
    const conn = await grantex.sso.createConnection({
      name: 'test-oidc',
      protocol: 'oidc',
      issuerUrl: 'https://accounts.google.com',
      clientId: 'test-client-id',
      clientSecret: 'test-secret',
      domains: ['example.com'],
      jitProvisioning: true,
      defaultScopes: ['openid', 'email', 'profile'],
    });
    connectionId = conn.id;

    expect(conn.id).toBeDefined();
    expect(typeof conn.id).toBe('string');
    expect(conn.name).toBe('test-oidc');
    expect(conn.protocol).toBe('oidc');
    expect(conn.status).toBeDefined();
    expect(conn.issuerUrl).toBe('https://accounts.google.com');
    expect(conn.clientId).toBe('test-client-id');
    expect(conn.domains).toEqual(['example.com']);
    expect(conn.jitProvisioning).toBe(true);
    expect(conn.defaultScopes).toEqual(['openid', 'email', 'profile']);
    expect(conn.createdAt).toBeDefined();
  });

  it('gets a connection by ID', async () => {
    const conn = await grantex.sso.getConnection(connectionId);

    expect(conn.id).toBe(connectionId);
    expect(conn.name).toBe('test-oidc');
    expect(conn.protocol).toBe('oidc');
    expect(conn.issuerUrl).toBe('https://accounts.google.com');
  });

  it('updates the connection name and status', async () => {
    const updated = await grantex.sso.updateConnection(connectionId, {
      name: 'updated-oidc',
      status: 'active',
    });

    expect(updated.name).toBe('updated-oidc');
    expect(updated.protocol).toBe('oidc');
  });

  it('updates connection domains', async () => {
    const updated = await grantex.sso.updateConnection(connectionId, {
      domains: ['example.com', 'example.org'],
    });

    expect(updated.domains).toEqual(['example.com', 'example.org']);
  });

  it('lists SSO connections', async () => {
    const result = await grantex.sso.listConnections();

    expect(result).toBeDefined();
    expect(result.connections).toBeDefined();
    expect(Array.isArray(result.connections)).toBe(true);
    expect(result.connections.length).toBeGreaterThanOrEqual(1);

    const found = result.connections.find((c: any) => c.id === connectionId);
    expect(found).toBeDefined();
    expect(found!.name).toBe('updated-oidc');
  });

  it('deletes the OIDC connection', async () => {
    await grantex.sso.deleteConnection(connectionId);
    const result = await grantex.sso.listConnections();
    const found = result.connections.find((c: any) => c.id === connectionId);
    expect(found).toBeUndefined();
  });
});

describe('E2E: SSO SAML Connection', () => {
  let connectionId: string;

  it('creates a SAML connection', async () => {
    const conn = await grantex.sso.createConnection({
      name: 'test-saml',
      protocol: 'saml',
      idpEntityId: 'https://idp.example.com/metadata',
      idpSsoUrl: 'https://idp.example.com/sso',
      idpCertificate: 'MIIC...base64cert',
      spEntityId: 'https://app.grantex.dev/saml',
      spAcsUrl: 'https://app.grantex.dev/saml/acs',
      domains: ['saml.example.com'],
    });
    connectionId = conn.id;

    expect(conn.name).toBe('test-saml');
    expect(conn.protocol).toBe('saml');
    expect(conn.idpEntityId).toBe('https://idp.example.com/metadata');
    expect(conn.idpSsoUrl).toBe('https://idp.example.com/sso');
    expect(conn.domains).toEqual(['saml.example.com']);
  });

  it('gets the SAML connection', async () => {
    const conn = await grantex.sso.getConnection(connectionId);
    expect(conn.protocol).toBe('saml');
    expect(conn.spEntityId).toBe('https://app.grantex.dev/saml');
    expect(conn.spAcsUrl).toBe('https://app.grantex.dev/saml/acs');
  });

  it('deletes the SAML connection', async () => {
    await grantex.sso.deleteConnection(connectionId);
    await expect(grantex.sso.getConnection(connectionId)).rejects.toThrow();
  });
});

describe('E2E: SSO LDAP Connection', () => {
  let connectionId: string;

  it('creates an LDAP connection', async () => {
    const conn = await grantex.sso.createConnection({
      name: 'test-ldap',
      protocol: 'ldap',
      ldapUrl: 'ldap://ldap.example.com:389',
      ldapBindDn: 'cn=admin,dc=example,dc=com',
      ldapBindPassword: 'admin-password',
      ldapSearchBase: 'ou=users,dc=example,dc=com',
      ldapSearchFilter: '(uid={{username}})',
      ldapTlsEnabled: false,
      domains: ['ldap.example.com'],
    });
    connectionId = conn.id;

    expect(conn.name).toBe('test-ldap');
    expect(conn.protocol).toBe('ldap');
    expect(conn.ldapUrl).toBe('ldap://ldap.example.com:389');
    expect(conn.ldapBindDn).toBe('cn=admin,dc=example,dc=com');
    expect(conn.ldapSearchBase).toBe('ou=users,dc=example,dc=com');
    expect(conn.ldapTlsEnabled).toBe(false);
  });

  it('deletes the LDAP connection', async () => {
    await grantex.sso.deleteConnection(connectionId);
  });
});

describe('E2E: SSO Validation', () => {
  it('rejects connection without name', async () => {
    await expect(
      grantex.sso.createConnection({
        name: '',
        protocol: 'oidc',
        issuerUrl: 'https://example.com',
        clientId: 'id',
        clientSecret: 'secret',
      } as any),
    ).rejects.toThrow();
  });

  it('rejects OIDC connection without required fields', async () => {
    await expect(
      grantex.sso.createConnection({
        name: 'incomplete-oidc',
        protocol: 'oidc',
        issuerUrl: 'https://example.com',
        // Missing clientId and clientSecret
      } as any),
    ).rejects.toThrow();
  });

  it('rejects SAML connection without required fields', async () => {
    await expect(
      grantex.sso.createConnection({
        name: 'incomplete-saml',
        protocol: 'saml',
        idpEntityId: 'https://idp.example.com',
        // Missing idpSsoUrl and idpCertificate
      } as any),
    ).rejects.toThrow();
  });

  it('rejects LDAP connection without required fields', async () => {
    await expect(
      grantex.sso.createConnection({
        name: 'incomplete-ldap',
        protocol: 'ldap',
        ldapUrl: 'ldap://example.com',
        // Missing ldapBindDn, ldapBindPassword, ldapSearchBase
      } as any),
    ).rejects.toThrow();
  });

  it('returns 404 for non-existent connection', async () => {
    await expect(grantex.sso.getConnection('sso_nonexistent_000')).rejects.toThrow();
  });

  it('returns 404 when deleting non-existent connection', async () => {
    await expect(grantex.sso.deleteConnection('sso_nonexistent_000')).rejects.toThrow();
  });
});

describe('E2E: SSO Group Mappings', () => {
  it('creates a connection with group mappings', async () => {
    const conn = await grantex.sso.createConnection({
      name: 'test-group-mappings',
      protocol: 'oidc',
      issuerUrl: 'https://accounts.google.com',
      clientId: 'group-test-id',
      clientSecret: 'group-test-secret',
      groupAttribute: 'groups',
      groupMappings: {
        admin: ['files:write', 'admin:manage'],
        viewer: ['files:read'],
      },
      defaultScopes: ['files:read'],
    });

    expect(conn.groupAttribute).toBe('groups');
    expect(conn.groupMappings).toBeDefined();
    expect(conn.defaultScopes).toEqual(['files:read']);

    // Cleanup
    await grantex.sso.deleteConnection(conn.id);
  });
});
