import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/client.js', () => ({
  requireClient: vi.fn(),
}));

import { requireClient } from '../src/client.js';
import { ssoCommand } from '../src/commands/sso.js';
import { setJsonMode } from '../src/format.js';

// ── Fixtures ─────────────────────────────────────────────────────────────

const ssoConfig = {
  issuerUrl: 'https://accounts.google.com',
  clientId: 'abc',
  redirectUri: 'https://app.com/cb',
  updatedAt: '2026-01-01T00:00:00Z',
};

const ssoConnection = {
  id: 'sso_conn_1',
  developerId: 'dev_1',
  name: 'Okta OIDC',
  protocol: 'oidc' as const,
  status: 'active' as const,
  issuerUrl: 'https://myorg.okta.com',
  clientId: 'okta_client',
  domains: ['myorg.com', 'myorg.io'],
  jitProvisioning: true,
  enforce: false,
  groupAttribute: 'groups',
  groupMappings: { admins: ['admin:*'], devs: ['read:*', 'write:*'] },
  defaultScopes: ['openid', 'profile'],
  createdAt: '2026-03-01T00:00:00Z',
  updatedAt: '2026-03-15T00:00:00Z',
};

const ssoSession = {
  id: 'ssn_1',
  connectionId: 'sso_conn_1',
  principalId: 'usr_1',
  email: 'alice@myorg.com',
  name: 'Alice',
  idpSubject: 'sub_abc',
  groups: ['admins'],
  mappedScopes: ['admin:*'],
  expiresAt: '2026-03-30T00:00:00Z',
  createdAt: '2026-03-29T00:00:00Z',
};

const mockClient = {
  sso: {
    // Enterprise methods
    listConnections: vi.fn(),
    createConnection: vi.fn(),
    getConnection: vi.fn(),
    updateConnection: vi.fn(),
    deleteConnection: vi.fn(),
    testConnection: vi.fn(),
    setEnforcement: vi.fn(),
    listSessions: vi.fn(),
    revokeSession: vi.fn(),
    // Legacy methods
    getConfig: vi.fn(),
    createConfig: vi.fn(),
    deleteConfig: vi.fn(),
    getLoginUrl: vi.fn(),
    handleCallback: vi.fn(),
  },
};

describe('ssoCommand()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (requireClient as ReturnType<typeof vi.fn>).mockResolvedValue(mockClient);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setJsonMode(false);
  });

  it('registers the "sso" command', () => {
    const cmd = ssoCommand();
    expect(cmd.name()).toBe('sso');
  });

  it('has connections, sessions, enforce, and legacy subcommands', () => {
    const cmd = ssoCommand();
    const names = cmd.commands.map((c) => c.name());
    expect(names).toContain('connections');
    expect(names).toContain('sessions');
    expect(names).toContain('enforce');
    // Legacy
    expect(names).toContain('get');
    expect(names).toContain('configure');
    expect(names).toContain('delete');
    expect(names).toContain('login-url');
    expect(names).toContain('callback');
  });

  // ── connections list ────────────────────────────────────────────────────

  describe('connections list', () => {
    it('calls sso.listConnections and prints table', async () => {
      mockClient.sso.listConnections.mockResolvedValue({ connections: [ssoConnection] });
      const cmd = ssoCommand();
      cmd.exitOverride();
      await cmd.parseAsync(['node', 'test', 'connections', 'list']);
      expect(mockClient.sso.listConnections).toHaveBeenCalledOnce();
      expect(console.log).toHaveBeenCalled();
      const allOutput = (console.log as ReturnType<typeof vi.fn>).mock.calls
        .map((c: unknown[]) => c.join(' '))
        .join('\n');
      expect(allOutput).toContain('sso_conn_1');
      expect(allOutput).toContain('Okta OIDC');
    });

    it('prints empty table when no connections', async () => {
      mockClient.sso.listConnections.mockResolvedValue({ connections: [] });
      const cmd = ssoCommand();
      cmd.exitOverride();
      await cmd.parseAsync(['node', 'test', 'connections', 'list']);
      const allOutput = (console.log as ReturnType<typeof vi.fn>).mock.calls
        .map((c: unknown[]) => c.join(' '))
        .join('\n');
      expect(allOutput).toContain('no results');
    });

    it('outputs JSON in json mode', async () => {
      mockClient.sso.listConnections.mockResolvedValue({ connections: [ssoConnection] });
      setJsonMode(true);
      const cmd = ssoCommand();
      cmd.exitOverride();
      await cmd.parseAsync(['node', 'test', 'connections', 'list']);
      const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      const parsed = JSON.parse(output);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed[0].id).toBe('sso_conn_1');
    });
  });

  // ── connections create ──────────────────────────────────────────────────

  describe('connections create', () => {
    it('creates an OIDC connection with all options', async () => {
      mockClient.sso.createConnection.mockResolvedValue(ssoConnection);
      const cmd = ssoCommand();
      cmd.exitOverride();
      await cmd.parseAsync([
        'node', 'test', 'connections', 'create',
        '--name', 'Okta OIDC',
        '--protocol', 'oidc',
        '--issuer-url', 'https://myorg.okta.com',
        '--client-id', 'okta_client',
        '--client-secret', 'secret123',
        '--domains', 'myorg.com,myorg.io',
        '--jit-provisioning',
        '--enforce',
        '--group-attribute', 'groups',
        '--group-mappings', '{"admins":["admin:*"]}',
        '--default-scopes', 'openid,profile',
      ]);
      expect(mockClient.sso.createConnection).toHaveBeenCalledWith({
        name: 'Okta OIDC',
        protocol: 'oidc',
        issuerUrl: 'https://myorg.okta.com',
        clientId: 'okta_client',
        clientSecret: 'secret123',
        domains: ['myorg.com', 'myorg.io'],
        jitProvisioning: true,
        enforce: true,
        groupAttribute: 'groups',
        groupMappings: { admins: ['admin:*'] },
        defaultScopes: ['openid', 'profile'],
      });
      const allOutput = (console.log as ReturnType<typeof vi.fn>).mock.calls
        .map((c: unknown[]) => c.join(' '))
        .join('\n');
      expect(allOutput).toContain('SSO connection created');
    });

    it('creates a SAML connection with SAML-specific options', async () => {
      const samlConn = { ...ssoConnection, protocol: 'saml' as const, id: 'sso_conn_2' };
      mockClient.sso.createConnection.mockResolvedValue(samlConn);
      const cmd = ssoCommand();
      cmd.exitOverride();
      await cmd.parseAsync([
        'node', 'test', 'connections', 'create',
        '--name', 'Okta SAML',
        '--protocol', 'saml',
        '--idp-entity-id', 'urn:okta:entity',
        '--idp-sso-url', 'https://okta.com/sso/saml',
        '--idp-certificate', 'MIICert...',
        '--sp-entity-id', 'urn:grantex:sp',
        '--sp-acs-url', 'https://auth.grantex.dev/sso/callback/saml',
      ]);
      expect(mockClient.sso.createConnection).toHaveBeenCalledWith({
        name: 'Okta SAML',
        protocol: 'saml',
        idpEntityId: 'urn:okta:entity',
        idpSsoUrl: 'https://okta.com/sso/saml',
        idpCertificate: 'MIICert...',
        spEntityId: 'urn:grantex:sp',
        spAcsUrl: 'https://auth.grantex.dev/sso/callback/saml',
      });
    });

    it('creates an LDAP connection with all LDAP options', async () => {
      const ldapConn = { ...ssoConnection, protocol: 'ldap' as const, id: 'sso_conn_3', name: 'Corp LDAP' };
      mockClient.sso.createConnection.mockResolvedValue(ldapConn);
      const cmd = ssoCommand();
      cmd.exitOverride();
      await cmd.parseAsync([
        'node', 'test', 'connections', 'create',
        '--name', 'Corp LDAP',
        '--protocol', 'ldap',
        '--ldap-url', 'ldap://ldap.corp.com:389',
        '--ldap-bind-dn', 'cn=admin,dc=corp,dc=com',
        '--ldap-bind-password', 'secret123',
        '--ldap-search-base', 'ou=users,dc=corp,dc=com',
        '--ldap-search-filter', '(uid={{username}})',
        '--ldap-group-search-base', 'ou=groups,dc=corp,dc=com',
        '--ldap-group-search-filter', '(member={{dn}})',
        '--ldap-tls-enabled',
        '--domains', 'corp.com',
        '--jit-provisioning',
        '--enforce',
      ]);
      expect(mockClient.sso.createConnection).toHaveBeenCalledWith({
        name: 'Corp LDAP',
        protocol: 'ldap',
        ldapUrl: 'ldap://ldap.corp.com:389',
        ldapBindDn: 'cn=admin,dc=corp,dc=com',
        ldapBindPassword: 'secret123',
        ldapSearchBase: 'ou=users,dc=corp,dc=com',
        ldapSearchFilter: '(uid={{username}})',
        ldapGroupSearchBase: 'ou=groups,dc=corp,dc=com',
        ldapGroupSearchFilter: '(member={{dn}})',
        ldapTlsEnabled: true,
        domains: ['corp.com'],
        jitProvisioning: true,
        enforce: true,
      });
      const allOutput = (console.log as ReturnType<typeof vi.fn>).mock.calls
        .map((c: unknown[]) => c.join(' '))
        .join('\n');
      expect(allOutput).toContain('SSO connection created');
    });

    it('includes LDAP-specific options in the payload', async () => {
      const ldapConn = { ...ssoConnection, protocol: 'ldap' as const, id: 'sso_conn_4' };
      mockClient.sso.createConnection.mockResolvedValue(ldapConn);
      const cmd = ssoCommand();
      cmd.exitOverride();
      await cmd.parseAsync([
        'node', 'test', 'connections', 'create',
        '--name', 'Minimal LDAP',
        '--protocol', 'ldap',
        '--ldap-url', 'ldaps://ldap.corp.com:636',
        '--ldap-bind-dn', 'cn=svc,dc=corp,dc=com',
        '--ldap-bind-password', 'pw',
        '--ldap-search-base', 'dc=corp,dc=com',
      ]);
      const payload = mockClient.sso.createConnection.mock.calls[0][0];
      expect(payload.ldapUrl).toBe('ldaps://ldap.corp.com:636');
      expect(payload.ldapBindDn).toBe('cn=svc,dc=corp,dc=com');
      expect(payload.ldapBindPassword).toBe('pw');
      expect(payload.ldapSearchBase).toBe('dc=corp,dc=com');
      // optional LDAP fields should not be present
      expect(payload.ldapSearchFilter).toBeUndefined();
      expect(payload.ldapGroupSearchBase).toBeUndefined();
      expect(payload.ldapGroupSearchFilter).toBeUndefined();
      expect(payload.ldapTlsEnabled).toBeUndefined();
    });

    it('outputs JSON in json mode', async () => {
      mockClient.sso.createConnection.mockResolvedValue(ssoConnection);
      setJsonMode(true);
      const cmd = ssoCommand();
      cmd.exitOverride();
      await cmd.parseAsync([
        'node', 'test', 'connections', 'create',
        '--name', 'Okta OIDC',
        '--protocol', 'oidc',
      ]);
      const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      const parsed = JSON.parse(output);
      expect(parsed.id).toBe('sso_conn_1');
      expect(parsed.name).toBe('Okta OIDC');
    });

    it('requires --name and --protocol', () => {
      const cmd = ssoCommand();
      const connCmd = cmd.commands.find((c) => c.name() === 'connections')!;
      const createCmd = connCmd.commands.find((c) => c.name() === 'create')!;
      const required = createCmd.options.filter((o) => o.required).map((o) => o.long);
      expect(required).toContain('--name');
      expect(required).toContain('--protocol');
    });
  });

  // ── connections get ─────────────────────────────────────────────────────

  describe('connections get', () => {
    it('calls sso.getConnection and prints record', async () => {
      mockClient.sso.getConnection.mockResolvedValue(ssoConnection);
      const cmd = ssoCommand();
      cmd.exitOverride();
      await cmd.parseAsync(['node', 'test', 'connections', 'get', 'sso_conn_1']);
      expect(mockClient.sso.getConnection).toHaveBeenCalledWith('sso_conn_1');
      expect(console.log).toHaveBeenCalled();
      const allOutput = (console.log as ReturnType<typeof vi.fn>).mock.calls
        .map((c: unknown[]) => c.join(' '))
        .join('\n');
      expect(allOutput).toContain('sso_conn_1');
    });

    it('outputs JSON in json mode', async () => {
      mockClient.sso.getConnection.mockResolvedValue(ssoConnection);
      setJsonMode(true);
      const cmd = ssoCommand();
      cmd.exitOverride();
      await cmd.parseAsync(['node', 'test', 'connections', 'get', 'sso_conn_1']);
      const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      const parsed = JSON.parse(output);
      expect(parsed.id).toBe('sso_conn_1');
      expect(parsed.protocol).toBe('oidc');
    });
  });

  // ── connections update ──────────────────────────────────────────────────

  describe('connections update', () => {
    it('calls sso.updateConnection with provided fields', async () => {
      mockClient.sso.updateConnection.mockResolvedValue({ ...ssoConnection, name: 'Updated Name' });
      const cmd = ssoCommand();
      cmd.exitOverride();
      await cmd.parseAsync([
        'node', 'test', 'connections', 'update', 'sso_conn_1',
        '--name', 'Updated Name',
        '--status', 'inactive',
        '--domains', 'new.com,new.io',
        '--jit-provisioning', 'false',
        '--enforce', 'true',
        '--default-scopes', 'openid',
      ]);
      expect(mockClient.sso.updateConnection).toHaveBeenCalledWith('sso_conn_1', {
        name: 'Updated Name',
        status: 'inactive',
        domains: ['new.com', 'new.io'],
        jitProvisioning: false,
        enforce: true,
        defaultScopes: ['openid'],
      });
      const allOutput = (console.log as ReturnType<typeof vi.fn>).mock.calls
        .map((c: unknown[]) => c.join(' '))
        .join('\n');
      expect(allOutput).toContain('SSO connection sso_conn_1 updated');
    });

    it('outputs JSON in json mode', async () => {
      mockClient.sso.updateConnection.mockResolvedValue({ ...ssoConnection, name: 'Updated' });
      setJsonMode(true);
      const cmd = ssoCommand();
      cmd.exitOverride();
      await cmd.parseAsync([
        'node', 'test', 'connections', 'update', 'sso_conn_1',
        '--name', 'Updated',
      ]);
      const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      const parsed = JSON.parse(output);
      expect(parsed.name).toBe('Updated');
    });

    it('errors when no fields are provided', async () => {
      const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
      const cmd = ssoCommand();
      cmd.exitOverride();
      await expect(
        cmd.parseAsync(['node', 'test', 'connections', 'update', 'sso_conn_1']),
      ).rejects.toThrow('exit');
      const allOutput = (console.error as ReturnType<typeof vi.fn>).mock.calls
        .map((c: unknown[]) => c.join(' '))
        .join('\n');
      expect(allOutput).toContain('at least one field to update');
      mockExit.mockRestore();
    });
  });

  // ── connections delete ──────────────────────────────────────────────────

  describe('connections delete', () => {
    it('calls sso.deleteConnection', async () => {
      mockClient.sso.deleteConnection.mockResolvedValue(undefined);
      const cmd = ssoCommand();
      cmd.exitOverride();
      await cmd.parseAsync(['node', 'test', 'connections', 'delete', 'sso_conn_1']);
      expect(mockClient.sso.deleteConnection).toHaveBeenCalledWith('sso_conn_1');
      const allOutput = (console.log as ReturnType<typeof vi.fn>).mock.calls
        .map((c: unknown[]) => c.join(' '))
        .join('\n');
      expect(allOutput).toContain('SSO connection sso_conn_1 deleted');
    });

    it('outputs JSON in json mode', async () => {
      mockClient.sso.deleteConnection.mockResolvedValue(undefined);
      setJsonMode(true);
      const cmd = ssoCommand();
      cmd.exitOverride();
      await cmd.parseAsync(['node', 'test', 'connections', 'delete', 'sso_conn_1']);
      const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      const parsed = JSON.parse(output);
      expect(parsed.deleted).toBe('sso_conn_1');
    });
  });

  // ── connections test ────────────────────────────────────────────────────

  describe('connections test', () => {
    it('calls sso.testConnection and prints success', async () => {
      mockClient.sso.testConnection.mockResolvedValue({
        success: true,
        protocol: 'oidc',
        issuer: 'https://myorg.okta.com',
        authorizationEndpoint: 'https://myorg.okta.com/authorize',
        tokenEndpoint: 'https://myorg.okta.com/token',
        jwksUri: 'https://myorg.okta.com/keys',
      });
      const cmd = ssoCommand();
      cmd.exitOverride();
      await cmd.parseAsync(['node', 'test', 'connections', 'test', 'sso_conn_1']);
      expect(mockClient.sso.testConnection).toHaveBeenCalledWith('sso_conn_1');
      const allOutput = (console.log as ReturnType<typeof vi.fn>).mock.calls
        .map((c: unknown[]) => c.join(' '))
        .join('\n');
      expect(allOutput).toContain('test passed');
    });

    it('prints failure with error message', async () => {
      mockClient.sso.testConnection.mockResolvedValue({
        success: false,
        protocol: 'oidc',
        error: 'IdP unreachable',
      });
      const cmd = ssoCommand();
      cmd.exitOverride();
      await cmd.parseAsync(['node', 'test', 'connections', 'test', 'sso_conn_1']);
      const allOutput = (console.log as ReturnType<typeof vi.fn>).mock.calls
        .map((c: unknown[]) => c.join(' '))
        .join('\n');
      expect(allOutput).toContain('test failed');
      expect(allOutput).toContain('IdP unreachable');
    });

    it('outputs JSON in json mode', async () => {
      const testResult = {
        success: true,
        protocol: 'oidc',
        issuer: 'https://myorg.okta.com',
      };
      mockClient.sso.testConnection.mockResolvedValue(testResult);
      setJsonMode(true);
      const cmd = ssoCommand();
      cmd.exitOverride();
      await cmd.parseAsync(['node', 'test', 'connections', 'test', 'sso_conn_1']);
      const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      const parsed = JSON.parse(output);
      expect(parsed.success).toBe(true);
      expect(parsed.protocol).toBe('oidc');
    });
  });

  // ── enforce ─────────────────────────────────────────────────────────────

  describe('enforce', () => {
    it('enables SSO enforcement', async () => {
      mockClient.sso.setEnforcement.mockResolvedValue({ enforce: true, developerId: 'dev_1' });
      const cmd = ssoCommand();
      cmd.exitOverride();
      await cmd.parseAsync(['node', 'test', 'enforce', '--enable']);
      expect(mockClient.sso.setEnforcement).toHaveBeenCalledWith({ enforce: true });
      const allOutput = (console.log as ReturnType<typeof vi.fn>).mock.calls
        .map((c: unknown[]) => c.join(' '))
        .join('\n');
      expect(allOutput).toContain('enforcement enabled');
    });

    it('disables SSO enforcement', async () => {
      mockClient.sso.setEnforcement.mockResolvedValue({ enforce: false, developerId: 'dev_1' });
      const cmd = ssoCommand();
      cmd.exitOverride();
      await cmd.parseAsync(['node', 'test', 'enforce', '--disable']);
      expect(mockClient.sso.setEnforcement).toHaveBeenCalledWith({ enforce: false });
      const allOutput = (console.log as ReturnType<typeof vi.fn>).mock.calls
        .map((c: unknown[]) => c.join(' '))
        .join('\n');
      expect(allOutput).toContain('enforcement disabled');
    });

    it('errors when neither --enable nor --disable is given', async () => {
      const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
      const cmd = ssoCommand();
      cmd.exitOverride();
      await expect(
        cmd.parseAsync(['node', 'test', 'enforce']),
      ).rejects.toThrow('exit');
      const allOutput = (console.error as ReturnType<typeof vi.fn>).mock.calls
        .map((c: unknown[]) => c.join(' '))
        .join('\n');
      expect(allOutput).toContain('--enable or --disable');
      mockExit.mockRestore();
    });

    it('outputs JSON in json mode', async () => {
      mockClient.sso.setEnforcement.mockResolvedValue({ enforce: true, developerId: 'dev_1' });
      setJsonMode(true);
      const cmd = ssoCommand();
      cmd.exitOverride();
      await cmd.parseAsync(['node', 'test', 'enforce', '--enable']);
      const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      const parsed = JSON.parse(output);
      expect(parsed.enforce).toBe(true);
      expect(parsed.developerId).toBe('dev_1');
    });
  });

  // ── sessions list ───────────────────────────────────────────────────────

  describe('sessions list', () => {
    it('calls sso.listSessions and prints table', async () => {
      mockClient.sso.listSessions.mockResolvedValue({ sessions: [ssoSession] });
      const cmd = ssoCommand();
      cmd.exitOverride();
      await cmd.parseAsync(['node', 'test', 'sessions', 'list']);
      expect(mockClient.sso.listSessions).toHaveBeenCalledOnce();
      const allOutput = (console.log as ReturnType<typeof vi.fn>).mock.calls
        .map((c: unknown[]) => c.join(' '))
        .join('\n');
      expect(allOutput).toContain('ssn_1');
      expect(allOutput).toContain('alice@myorg.com');
    });

    it('prints empty table when no sessions', async () => {
      mockClient.sso.listSessions.mockResolvedValue({ sessions: [] });
      const cmd = ssoCommand();
      cmd.exitOverride();
      await cmd.parseAsync(['node', 'test', 'sessions', 'list']);
      const allOutput = (console.log as ReturnType<typeof vi.fn>).mock.calls
        .map((c: unknown[]) => c.join(' '))
        .join('\n');
      expect(allOutput).toContain('no results');
    });

    it('outputs JSON in json mode', async () => {
      mockClient.sso.listSessions.mockResolvedValue({ sessions: [ssoSession] });
      setJsonMode(true);
      const cmd = ssoCommand();
      cmd.exitOverride();
      await cmd.parseAsync(['node', 'test', 'sessions', 'list']);
      const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      const parsed = JSON.parse(output);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed[0].id).toBe('ssn_1');
    });
  });

  // ── sessions revoke ─────────────────────────────────────────────────────

  describe('sessions revoke', () => {
    it('calls sso.revokeSession', async () => {
      mockClient.sso.revokeSession.mockResolvedValue(undefined);
      const cmd = ssoCommand();
      cmd.exitOverride();
      await cmd.parseAsync(['node', 'test', 'sessions', 'revoke', 'ssn_1']);
      expect(mockClient.sso.revokeSession).toHaveBeenCalledWith('ssn_1');
      const allOutput = (console.log as ReturnType<typeof vi.fn>).mock.calls
        .map((c: unknown[]) => c.join(' '))
        .join('\n');
      expect(allOutput).toContain('SSO session ssn_1 revoked');
    });

    it('outputs JSON in json mode', async () => {
      mockClient.sso.revokeSession.mockResolvedValue(undefined);
      setJsonMode(true);
      const cmd = ssoCommand();
      cmd.exitOverride();
      await cmd.parseAsync(['node', 'test', 'sessions', 'revoke', 'ssn_1']);
      const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      const parsed = JSON.parse(output);
      expect(parsed.revoked).toBe('ssn_1');
    });
  });

  // ── Legacy: get ─────────────────────────────────────────────────────────

  describe('legacy: get', () => {
    it('calls sso.getConfig and prints record', async () => {
      mockClient.sso.getConfig.mockResolvedValue(ssoConfig);
      const cmd = ssoCommand();
      cmd.exitOverride();
      await cmd.parseAsync(['node', 'test', 'get']);
      expect(mockClient.sso.getConfig).toHaveBeenCalledOnce();
      expect(console.log).toHaveBeenCalled();
    });
  });

  // ── Legacy: configure ───────────────────────────────────────────────────

  describe('legacy: configure', () => {
    it('"configure" has --issuer-url, --client-id, --client-secret, --redirect-uri options', () => {
      const cmd = ssoCommand();
      const configureCmd = cmd.commands.find((c) => c.name() === 'configure')!;
      const optNames = configureCmd.options.map((o) => o.long);
      expect(optNames).toContain('--issuer-url');
      expect(optNames).toContain('--client-id');
      expect(optNames).toContain('--client-secret');
      expect(optNames).toContain('--redirect-uri');
    });

    it('calls sso.createConfig with all options', async () => {
      mockClient.sso.createConfig.mockResolvedValue(undefined);
      const cmd = ssoCommand();
      cmd.exitOverride();
      await cmd.parseAsync([
        'node', 'test', 'configure',
        '--issuer-url', 'https://accounts.google.com',
        '--client-id', 'abc',
        '--client-secret', 'secret',
        '--redirect-uri', 'https://app.com/cb',
      ]);
      expect(mockClient.sso.createConfig).toHaveBeenCalledWith({
        issuerUrl: 'https://accounts.google.com',
        clientId: 'abc',
        clientSecret: 'secret',
        redirectUri: 'https://app.com/cb',
      });
      const allOutput = (console.log as ReturnType<typeof vi.fn>).mock.calls
        .map((c: unknown[]) => c.join(' '))
        .join('\n');
      expect(allOutput).toContain('SSO configuration saved');
    });
  });

  // ── Legacy: delete ──────────────────────────────────────────────────────

  describe('legacy: delete', () => {
    it('calls sso.deleteConfig', async () => {
      mockClient.sso.deleteConfig.mockResolvedValue(undefined);
      const cmd = ssoCommand();
      cmd.exitOverride();
      await cmd.parseAsync(['node', 'test', 'delete']);
      expect(mockClient.sso.deleteConfig).toHaveBeenCalledOnce();
      const allOutput = (console.log as ReturnType<typeof vi.fn>).mock.calls
        .map((c: unknown[]) => c.join(' '))
        .join('\n');
      expect(allOutput).toContain('SSO configuration deleted');
    });
  });

  // ── Legacy: login-url ───────────────────────────────────────────────────

  describe('legacy: login-url', () => {
    it('calls sso.getLoginUrl and prints URL', async () => {
      mockClient.sso.getLoginUrl.mockResolvedValue({
        authorizeUrl: 'https://accounts.google.com/authorize?state=abc',
      });
      const cmd = ssoCommand();
      cmd.exitOverride();
      await cmd.parseAsync(['node', 'test', 'login-url', 'my-org']);
      expect(mockClient.sso.getLoginUrl).toHaveBeenCalledWith('my-org');
      const allOutput = (console.log as ReturnType<typeof vi.fn>).mock.calls
        .map((c: unknown[]) => c.join(' '))
        .join('\n');
      expect(allOutput).toContain('https://accounts.google.com/authorize');
    });

    it('outputs JSON in json mode', async () => {
      mockClient.sso.getLoginUrl.mockResolvedValue({
        authorizeUrl: 'https://accounts.google.com/authorize?state=abc',
      });
      setJsonMode(true);
      const cmd = ssoCommand();
      cmd.exitOverride();
      await cmd.parseAsync(['node', 'test', 'login-url', 'my-org']);
      const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      const parsed = JSON.parse(output);
      expect(parsed.authorizeUrl).toContain('https://accounts.google.com/authorize');
    });
  });

  // ── Legacy: callback ────────────────────────────────────────────────────

  describe('legacy: callback', () => {
    it('calls sso.handleCallback and prints record', async () => {
      mockClient.sso.handleCallback.mockResolvedValue({
        email: 'test@co.com',
        name: 'Test',
        sub: 'sub_1',
        developerId: 'dev_1',
      });
      const cmd = ssoCommand();
      cmd.exitOverride();
      await cmd.parseAsync([
        'node', 'test', 'callback',
        '--code', 'auth_code_1',
        '--state', 'state_abc',
      ]);
      expect(mockClient.sso.handleCallback).toHaveBeenCalledWith('auth_code_1', 'state_abc');
      expect(console.log).toHaveBeenCalled();
    });

    it('outputs JSON in json mode', async () => {
      mockClient.sso.handleCallback.mockResolvedValue({
        email: 'test@co.com',
        name: 'Test',
        sub: 'sub_1',
        developerId: 'dev_1',
      });
      setJsonMode(true);
      const cmd = ssoCommand();
      cmd.exitOverride();
      await cmd.parseAsync([
        'node', 'test', 'callback',
        '--code', 'auth_code_1',
        '--state', 'state_abc',
      ]);
      const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      const parsed = JSON.parse(output);
      expect(parsed.email).toBe('test@co.com');
      expect(parsed.developerId).toBe('dev_1');
    });

    it('handles null email and name', async () => {
      mockClient.sso.handleCallback.mockResolvedValue({
        email: null,
        name: null,
        sub: null,
        developerId: 'dev_1',
      });
      const cmd = ssoCommand();
      cmd.exitOverride();
      await cmd.parseAsync([
        'node', 'test', 'callback',
        '--code', 'auth_code_1',
        '--state', 'state_abc',
      ]);
      expect(mockClient.sso.handleCallback).toHaveBeenCalledWith('auth_code_1', 'state_abc');
    });
  });
});
