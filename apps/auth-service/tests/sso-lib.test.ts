import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockRedis, sqlMock } from './setup.js';
import {
  mapGroupsToScopes,
  clearDiscoveryCache,
  clearJwksCache,
} from '../src/lib/sso.js';
import {
  validateOutboundUrl,
  isBlockedPrivateHost,
  resolvePinnedOutboundTarget,
  setSafeFetchForTests,
} from '../src/lib/url-security.js';
import { escapeLdapFilter } from '../src/lib/ldap.js';

beforeEach(() => {
  clearDiscoveryCache();
  clearJwksCache();
  setSafeFetchForTests(null);
  sqlMock.mockReset().mockResolvedValue([]);
});

describe('validateOutboundUrl', () => {
  it('rejects IPv4-mapped IPv6 loopback literals', () => {
    expect(() => validateOutboundUrl('https://[::ffff:127.0.0.1]/metadata', {
      allowedProtocols: ['https:'],
    })).toThrow(/Private/);
  });

  it('rejects loopback hostnames with a trailing dot (FQDN form)', () => {
    expect(() => validateOutboundUrl('http://localhost./api', {
      allowedProtocols: ['http:'],
      allowInsecureHttp: true,
    })).toThrow(/Private/);
  });

  it('rejects loopback IPs with a trailing dot', () => {
    expect(() => validateOutboundUrl('http://127.0.0.1./api', {
      allowedProtocols: ['http:'],
      allowInsecureHttp: true,
    })).toThrow(/Private/);
  });

  it('rejects URLs with empty hostnames', () => {
    // "ldap:///dc=example" parses cleanly via the URL constructor but has
    // no host. Downstream callers would otherwise get ambiguous
    // default-target socket behavior. (Note: schemes like https require a
    // host at parse time, so they fail earlier with "must be absolute and
    // valid" — only schemes that allow empty authority hit this check.)
    expect(() => validateOutboundUrl('ldap:///dc=example,dc=com', {
      allowedProtocols: ['ldap:', 'ldaps:'],
      allowInsecureHttp: true,
    })).toThrow(/hostname/);
  });
});

describe('isBlockedPrivateHost', () => {
  it('treats trailing-dot loopback as private', () => {
    expect(isBlockedPrivateHost('localhost.')).toBe(true);
    expect(isBlockedPrivateHost('LOCALHOST.')).toBe(true);
    expect(isBlockedPrivateHost('localhost..')).toBe(true);
  });

  it('treats trailing-dot private IPs as private', () => {
    expect(isBlockedPrivateHost('127.0.0.1.')).toBe(true);
    expect(isBlockedPrivateHost('10.0.0.1.')).toBe(true);
    expect(isBlockedPrivateHost('192.168.1.1.')).toBe(true);
  });

  it('still allows public hostnames with a trailing dot', () => {
    expect(isBlockedPrivateHost('example.com.')).toBe(false);
    expect(isBlockedPrivateHost('grantex.dev.')).toBe(false);
  });

  it('blocks the full IPv6 link-local range (fe80::/10), not just fe80:', () => {
    // fe80::/10 spans first-group values 0xfe80–0xfebf, so the second hex
    // digit of byte 2 is 8/9/a/b. Earlier check only matched "fe80:" prefix.
    expect(isBlockedPrivateHost('fe80::1')).toBe(true);
    expect(isBlockedPrivateHost('fe90::1')).toBe(true);
    expect(isBlockedPrivateHost('fea0::1')).toBe(true);
    expect(isBlockedPrivateHost('febf::1')).toBe(true);
    expect(isBlockedPrivateHost('FE90::1')).toBe(true); // case-insensitive
  });

  it('does not over-block adjacent IPv6 ranges outside link-local', () => {
    // fec0::/10 (site-local, deprecated per RFC 3879) and fc00::/7 boundaries
    // — make sure we did not accidentally widen the link-local match.
    expect(isBlockedPrivateHost('fec0::1')).toBe(false);
    expect(isBlockedPrivateHost('ff00::1')).toBe(false); // multicast — not private
    expect(isBlockedPrivateHost('2001:db8::1')).toBe(false); // doc range
  });
});

describe('resolvePinnedOutboundTarget', () => {
  it('rejects hostnames that resolve to loopback addresses', async () => {
    await expect(resolvePinnedOutboundTarget('https://attacker.example/metadata', {
      allowedProtocols: ['https:'],
    }, async () => [{ address: '127.0.0.1', family: 4 }])).rejects.toThrow(/Resolved private/);
  });

  it('rejects mixed public and private DNS answers', async () => {
    await expect(resolvePinnedOutboundTarget('https://attacker.example/metadata', {
      allowedProtocols: ['https:'],
    }, async () => [
      { address: '203.0.113.10', family: 4 },
      { address: '10.0.0.8', family: 4 },
    ])).rejects.toThrow(/Resolved private/);
  });

  it('pins to the first public resolved address', async () => {
    const target = await resolvePinnedOutboundTarget('https://idp.example.com/.well-known/openid-configuration', {
      allowedProtocols: ['https:'],
    }, async () => [
      { address: '203.0.113.10', family: 4 },
      { address: '2001:db8::10', family: 6 },
    ]);

    expect(target.url.hostname).toBe('idp.example.com');
    expect(target.address).toBe('203.0.113.10');
    expect(target.family).toBe(4);
  });
});

describe('escapeLdapFilter', () => {
  it('escapes RFC 4515 special characters', () => {
    expect(escapeLdapFilter('alice')).toBe('alice');
    expect(escapeLdapFilter('a*b')).toBe('a\\2ab');
    expect(escapeLdapFilter('a(b)c')).toBe('a\\28b\\29c');
    expect(escapeLdapFilter('a\\b')).toBe('a\\5cb');
    expect(escapeLdapFilter('a\0b')).toBe('a\\00b');
  });

  it('neutralizes filter-injection payloads', () => {
    // Classic injection: "*)(uid=*" — would otherwise widen filter scope.
    expect(escapeLdapFilter('*)(uid=*')).toBe('\\2a\\29\\28uid=\\2a');
  });

  it('preserves valid enterprise identifiers', () => {
    // None of these contain LDAP filter metachars, so they pass through
    // untouched — which proves the previous regex gate was over-restrictive.
    expect(escapeLdapFilter('cn=Jane Doe,ou=Users,dc=example,dc=com'))
      .toBe('cn=Jane Doe,ou=Users,dc=example,dc=com');
    expect(escapeLdapFilter('user@corp.example.com')).toBe('user@corp.example.com');
  });

  it('escapes backslash before other escapes (no double-escape)', () => {
    // If \ were escaped after the others, an input like "a\*b" would become
    // "a\5c\2ab" → reparsed as escaped "*", changing meaning. Backslash-first
    // means "a\*b" → "a\5c\2ab" is the right canonical form.
    expect(escapeLdapFilter('a\\*b')).toBe('a\\5c\\2ab');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// mapGroupsToScopes
// ═══════════════════════════════════════════════════════════════════════════

describe('mapGroupsToScopes', () => {
  const mappings = {
    Engineering: ['read', 'write', 'deploy'],
    Admins: ['admin', 'read', 'write'],
    Marketing: ['read', 'analytics'],
  };

  it('maps a single group to its scopes', () => {
    const result = mapGroupsToScopes(['Engineering'], mappings, ['read']);
    expect(result).toEqual(['read', 'write', 'deploy']);
  });

  it('merges scopes from multiple groups (deduped)', () => {
    const result = mapGroupsToScopes(['Engineering', 'Admins'], mappings, ['read']);
    expect(result.sort()).toEqual(['admin', 'deploy', 'read', 'write']);
  });

  it('returns default scopes when no groups match', () => {
    const result = mapGroupsToScopes(['UnknownGroup'], mappings, ['read', 'basic']);
    expect(result.sort()).toEqual(['basic', 'read']);
  });

  it('returns default scopes when groups array is empty', () => {
    const result = mapGroupsToScopes([], mappings, ['read']);
    expect(result).toEqual(['read']);
  });

  it('returns empty array when no groups and no defaults', () => {
    const result = mapGroupsToScopes([], {}, []);
    expect(result).toEqual([]);
  });

  it('does not use defaults when at least one group matches', () => {
    const result = mapGroupsToScopes(['Marketing'], mappings, ['fallback']);
    expect(result.sort()).toEqual(['analytics', 'read']);
    expect(result).not.toContain('fallback');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// discoverOidcProvider
// ═══════════════════════════════════════════════════════════════════════════

describe('discoverOidcProvider', () => {
  it('fetches and caches the discovery document', async () => {
    const { discoverOidcProvider } = await import('../src/lib/sso.js');
    clearDiscoveryCache();

    const mockDoc = {
      issuer: 'https://idp.example.com',
      authorization_endpoint: 'https://idp.example.com/authorize',
      token_endpoint: 'https://idp.example.com/token',
      jwks_uri: 'https://idp.example.com/.well-known/jwks.json',
    };

    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(mockDoc), { status: 200 }));
    setSafeFetchForTests(async (url, init, policy) => fetchMock(url, init, policy));

    const doc1 = await discoverOidcProvider('https://idp.example.com');
    expect(doc1.issuer).toBe('https://idp.example.com');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second call should use cache
    const doc2 = await discoverOidcProvider('https://idp.example.com');
    expect(doc2.issuer).toBe('https://idp.example.com');
    expect(fetchMock).toHaveBeenCalledTimes(1); // Still 1

    setSafeFetchForTests(null);
  });

  it('throws when discovery fails', async () => {
    const { discoverOidcProvider } = await import('../src/lib/sso.js');
    clearDiscoveryCache();

    setSafeFetchForTests(async () => new Response('', { status: 404 }));

    await expect(discoverOidcProvider('https://bad.example.com')).rejects.toThrow('OIDC discovery failed');

    setSafeFetchForTests(null);
  });

  it('rejects loopback discovery URLs before fetch', async () => {
    const { discoverOidcProvider } = await import('../src/lib/sso.js');
    const fetchMock = vi.fn();
    setSafeFetchForTests(async (url, init, policy) => fetchMock(url, init, policy));

    await expect(discoverOidcProvider('http://127.0.0.1:8080')).rejects.toThrow(/HTTP URLs|Private/);
    expect(fetchMock).not.toHaveBeenCalled();

    setSafeFetchForTests(null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// parseSamlResponse
// ═══════════════════════════════════════════════════════════════════════════

describe('parseSamlResponse', () => {
  const options = {
    connectionId: 'sso_TEST',
    idpCertificate: 'not-a-certificate',
    idpEntityId: 'https://idp.example.com',
    idpSsoUrl: 'https://idp.example.com/sso',
    spEntityId: 'urn:grantex:test',
    spAcsUrl: 'https://app.example.com/sso/callback/saml',
  };

  it('rejects an invalid IdP certificate before parsing assertions', async () => {
    const { parseSamlResponse } = await import('../src/lib/sso.js');
    const b64 = Buffer.from('<Response/>').toString('base64');

    await expect(parseSamlResponse(b64, options)).rejects.toThrow('Invalid IdP certificate');
  });

  it('rejects oversized responses before XML parsing', async () => {
    const { parseSamlResponse } = await import('../src/lib/sso.js');

    await expect(
      parseSamlResponse('A'.repeat(1_048_577), options),
    ).rejects.toThrow('SAML Response exceeds maximum size');
  });

  it('generates a request and persists its one-time request ID', async () => {
    const { generateSamlAuthorizeUrl } = await import('../src/lib/sso.js');

    const url = await generateSamlAuthorizeUrl(options, 'signed-relay-state');

    expect(url).toContain('https://idp.example.com/sso?');
    expect(url).toContain('SAMLRequest=');
    expect(url).toContain('RelayState=signed-relay-state');
    expect(mockRedis.set).toHaveBeenCalledWith(
      expect.stringMatching(/^saml:req:sso_TEST:_/),
      expect.any(String),
      'PX',
      600_000,
      'NX',
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// jitProvision
// ═══════════════════════════════════════════════════════════════════════════

describe('jitProvision', () => {
  it('updates existing user when found by external_id', async () => {
    const { jitProvision } = await import('../src/lib/sso.js');

    // First call: find existing user
    sqlMock.mockResolvedValueOnce([{ id: 'scimuser_EXISTING' }]);
    // Second call: UPDATE
    sqlMock.mockResolvedValueOnce([]);

    const id = await jitProvision('dev_TEST', { sub: 'idp_user_01', email: 'alice@corp.com', name: 'Alice' });
    expect(id).toBe('scimuser_EXISTING');
    expect(sqlMock).toHaveBeenCalledTimes(2);
  });

  it('creates new user when not found', async () => {
    const { jitProvision } = await import('../src/lib/sso.js');

    // First call: no existing user
    sqlMock.mockResolvedValueOnce([]);
    // Second call: INSERT
    sqlMock.mockResolvedValueOnce([]);

    const id = await jitProvision('dev_TEST', { sub: 'idp_user_new', email: 'new@corp.com' });
    expect(id).toMatch(/^scimuser_/);
    expect(sqlMock).toHaveBeenCalledTimes(2);
  });
});
