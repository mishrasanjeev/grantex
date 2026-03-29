import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sqlMock } from './setup.js';
import {
  mapGroupsToScopes,
  clearDiscoveryCache,
  clearJwksCache,
} from '../src/lib/sso.js';

beforeEach(() => {
  clearDiscoveryCache();
  clearJwksCache();
  sqlMock.mockReset().mockResolvedValue([]);
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

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockDoc),
    });
    vi.stubGlobal('fetch', fetchMock);

    const doc1 = await discoverOidcProvider('https://idp.example.com');
    expect(doc1.issuer).toBe('https://idp.example.com');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second call should use cache
    const doc2 = await discoverOidcProvider('https://idp.example.com');
    expect(doc2.issuer).toBe('https://idp.example.com');
    expect(fetchMock).toHaveBeenCalledTimes(1); // Still 1

    vi.unstubAllGlobals();
  });

  it('throws when discovery fails', async () => {
    const { discoverOidcProvider } = await import('../src/lib/sso.js');
    clearDiscoveryCache();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));

    await expect(discoverOidcProvider('https://bad.example.com')).rejects.toThrow('OIDC discovery failed');

    vi.unstubAllGlobals();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// parseSamlResponse
// ═══════════════════════════════════════════════════════════════════════════

describe('parseSamlResponse', () => {
  it('throws when NameID is missing', async () => {
    const { parseSamlResponse } = await import('../src/lib/sso.js');
    const samlXml = '<Response><Assertion></Assertion></Response>';
    const b64 = Buffer.from(samlXml).toString('base64');

    expect(() => parseSamlResponse(b64, 'cert')).toThrow('SAML Response missing NameID');
  });

  it('throws when signature is missing', async () => {
    const { parseSamlResponse } = await import('../src/lib/sso.js');
    const samlXml = '<Response><Assertion><saml:NameID>user@test.com</saml:NameID></Assertion></Response>';
    const b64 = Buffer.from(samlXml).toString('base64');

    expect(() => parseSamlResponse(b64, 'cert')).toThrow('SAML Response missing signature');
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
