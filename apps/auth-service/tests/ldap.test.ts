import { describe, expect, it } from 'vitest';
import { resolveLdapTransport } from '../src/lib/ldap.js';

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
