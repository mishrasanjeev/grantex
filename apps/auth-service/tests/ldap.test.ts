import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import {
  createDefaultLdapClient,
  escapeLdapDnValue,
  resolveLdapTransport,
  resolveLdapUserDn,
  type LdapConfig,
} from '../src/lib/ldap.js';

const LDAP_CONFIG: LdapConfig = {
  ldapUrl: 'ldaps://directory.example.com',
  bindDn: 'cn=service,dc=example,dc=com',
  bindPassword: 'service-secret',
  searchBase: 'ou=people,dc=example,dc=com',
  searchFilter: '(uid={{username}})',
  tlsEnabled: true,
};

function createBindSocket(
  resultCode = 0,
  splitAt?: number,
): { socket: Socket; writes: Buffer[] } {
  const emitter = new EventEmitter();
  const writes: Buffer[] = [];
  const response = Buffer.from([
    0x30, 0x0c, 0x02, 0x01, 0x01, 0x61, 0x07,
    0x0a, 0x01, resultCode, 0x04, 0x00, 0x04, 0x00,
  ]);

  const socket = Object.assign(emitter, {
    write: vi.fn((data: Uint8Array) => {
      writes.push(Buffer.from(data));
      const chunks = splitAt === undefined
        ? [response]
        : [response.subarray(0, splitAt), response.subarray(splitAt)];
      queueMicrotask(() => {
        for (const chunk of chunks) emitter.emit('data', chunk);
      });
      return true;
    }),
    destroy: vi.fn(),
  }) as unknown as Socket;

  return { socket, writes };
}

describe('resolveLdapTransport', () => {
  it('always enables TLS for ldaps URLs even when the stored flag is false', () => {
    expect(resolveLdapTransport(new URL('ldaps://directory.example.com'), false))
      .toEqual({ tls: true, port: 636 });
  });

  it('uses direct TLS for ldap URLs when explicitly enabled', () => {
    expect(resolveLdapTransport(new URL('ldap://directory.example.com'), true))
      .toEqual({ tls: true, port: 636 });
  });

  it('preserves explicit ports without downgrading the scheme', () => {
    expect(resolveLdapTransport(new URL('ldaps://directory.example.com:1636'), false))
      .toEqual({ tls: true, port: 1636 });
    expect(resolveLdapTransport(new URL('ldap://directory.example.com:1389'), false))
      .toEqual({ tls: false, port: 1389 });
  });
});

describe('LDAP user-DN templates', () => {
  it('escapes untrusted usernames as RFC 4514 DN values', () => {
    expect(escapeLdapDnValue(' Smith,Admin ')).toBe('\\ Smith\\,Admin\\ ');
    expect(escapeLdapDnValue('DOMAIN\\alice')).toBe('DOMAIN\\\\alice');
    expect(escapeLdapDnValue('a+b')).toBe('a\\+b');
    expect(escapeLdapDnValue(`a${String.fromCharCode(0)}b`)).toBe('a\\00b');
  });

  it('constructs a DN only from a supported simple equality template', () => {
    expect(resolveLdapUserDn(LDAP_CONFIG, ' Smith,Admin ')).toBe(
      'uid=\\ Smith\\,Admin\\ ,ou=people,dc=example,dc=com',
    );
  });

  it('rejects compound or missing-placeholder search filters', () => {
    expect(() => resolveLdapUserDn({
      ...LDAP_CONFIG,
      searchFilter: '(&(uid={{username}})(objectClass=person))',
    }, 'alice')).toThrow(/simple user-DN template/);
    expect(() => resolveLdapUserDn({
      ...LDAP_CONFIG,
      searchFilter: '(uid=alice)',
    }, 'alice')).toThrow(/directory search filters are not supported/);
  });
});

describe('default LDAP bind client', () => {
  it('tests connectivity by binding the configured service account', async () => {
    const bind = createBindSocket();
    const connector = vi.fn(async () => bind.socket) as unknown as NonNullable<
      Parameters<typeof createDefaultLdapClient>[0]
    >;
    const client = createDefaultLdapClient(connector);

    await expect(client.testConnection(LDAP_CONFIG)).resolves.toEqual({ success: true });
    expect(connector).toHaveBeenCalledOnce();
    expect(bind.writes).toHaveLength(1);
    expect(bind.writes[0]?.includes(Buffer.from(LDAP_CONFIG.bindDn))).toBe(true);
    expect(bind.writes[0]?.includes(Buffer.from(LDAP_CONFIG.bindPassword))).toBe(true);
  });

  it('fails the connection test when the service-account bind is rejected', async () => {
    const bind = createBindSocket(49);
    const connector = vi.fn(async () => bind.socket) as unknown as NonNullable<
      Parameters<typeof createDefaultLdapClient>[0]
    >;
    const client = createDefaultLdapClient(connector);

    await expect(client.testConnection(LDAP_CONFIG)).resolves.toEqual({
      success: false,
      error: 'LDAP service-account bind failed',
    });
  });

  it('accumulates fragmented TCP data until the complete BER bind response arrives', async () => {
    const bind = createBindSocket(0, 6);
    const connector = vi.fn(async () => bind.socket) as unknown as NonNullable<
      Parameters<typeof createDefaultLdapClient>[0]
    >;
    const client = createDefaultLdapClient(connector);

    await expect(client.testConnection(LDAP_CONFIG)).resolves.toEqual({ success: true });
  });

  it('returns only bind-derived identity data and does not invent attributes or groups', async () => {
    const serviceBind = createBindSocket();
    const userBind = createBindSocket();
    const connector = vi.fn()
      .mockResolvedValueOnce(serviceBind.socket)
      .mockResolvedValueOnce(userBind.socket) as unknown as NonNullable<
        Parameters<typeof createDefaultLdapClient>[0]
      >;
    const client = createDefaultLdapClient(connector);

    const result = await client.authenticate(LDAP_CONFIG, 'alice', 'user-secret');

    expect(result).toEqual({
      dn: 'uid=alice,ou=people,dc=example,dc=com',
      uid: 'alice',
      groups: [],
    });
    expect(result).not.toHaveProperty('email');
    expect(result).not.toHaveProperty('displayName');
    expect(userBind.writes[0]?.includes(Buffer.from(result.dn))).toBe(true);
    expect(userBind.writes[0]?.includes(Buffer.from('user-secret'))).toBe(true);
  });
});
