import { describe, it, expect, beforeAll } from 'vitest';
import { buildTestApp, seedAuth, authHeader, sqlMock, TEST_DEVELOPER, TEST_AGENT } from './helpers.js';
import type { FastifyInstance } from 'fastify';
import { initKeys, getKeyPair } from '../src/lib/crypto.js';
import { SignJWT, decodeJwt, generateKeyPair } from 'jose';
import { createHash } from 'node:crypto';
import {
  issueSDJWT,
  verifySDJWT,
  createPresentation,
} from '../src/lib/sd-jwt.js';

let app: FastifyInstance;

beforeAll(async () => {
  await initKeys();
  app = await buildTestApp();
});

// ── Helpers ─────────────────────────────────────────────────────────────────

const future = new Date(Date.now() + 86400_000);

const defaultParams = {
  grantId: 'grnt_SDJWT01',
  agentDid: 'did:grantex:ag_SDJWT01',
  principalId: 'user_sd_123',
  developerId: 'dev_TEST',
  scopes: ['read', 'write'],
  expiresAt: future,
};

function decodeDisclosure(encoded: string): { salt: string; claimName: string; claimValue: unknown } {
  const json = Buffer.from(encoded, 'base64url').toString('utf-8');
  const [salt, claimName, claimValue] = JSON.parse(json) as [string, string, unknown];
  return { salt, claimName, claimValue };
}

function hashDisclosure(encoded: string): string {
  return createHash('sha256').update(encoded, 'ascii').digest().toString('base64url');
}

// ── SD-JWT Issuance ─────────────────────────────────────────────────────────

describe('issueSDJWT', () => {
  it('creates a valid SD-JWT with default selective fields', async () => {
    const { vcId, sdJwt, disclosures } = await issueSDJWT(defaultParams);

    expect(vcId).toMatch(/^vc_/);
    expect(typeof sdJwt).toBe('string');

    // SD-JWT format: <issuer-jwt>~<d1>~<d2>~...~
    const parts = sdJwt.split('~');
    expect(parts.length).toBeGreaterThanOrEqual(3); // jwt + at least 1 disclosure + trailing empty

    // Default selective fields: principalId, developerId, scopes, delegationDepth
    expect(disclosures).toHaveLength(4);

    // Decode the issuer JWT
    const issuerJwt = parts[0]!;
    const payload = decodeJwt(issuerJwt);

    expect(payload.iss).toBe('did:web:grantex.dev');
    expect(payload.sub).toBe('did:grantex:ag_SDJWT01');
    expect(payload.jti).toBe(vcId);
    expect(payload['_sd_alg']).toBe('sha-256');

    // Check vc claim
    const vc = payload['vc'] as Record<string, unknown>;
    expect(vc['@context']).toContain('https://www.w3.org/ns/credentials/v2');
    expect(vc['type']).toContain('AgentGrantCredential');

    // Credential subject should have _sd array and visible claims
    const subject = vc['credentialSubject'] as Record<string, unknown>;
    expect(subject['id']).toBe('did:grantex:ag_SDJWT01');
    expect(subject['type']).toBe('AIAgent');
    expect(subject['grantId']).toBe('grnt_SDJWT01');
    expect(subject['_sd']).toBeDefined();
    expect(Array.isArray(subject['_sd'])).toBe(true);
    expect((subject['_sd'] as string[]).length).toBe(4);

    // Selective fields should NOT be in the visible credentialSubject
    expect(subject['principalId']).toBeUndefined();
    expect(subject['developerId']).toBeUndefined();
    expect(subject['scopes']).toBeUndefined();
    expect(subject['delegationDepth']).toBeUndefined();
  });

  it('creates SD-JWT with custom selective fields', async () => {
    const { disclosures } = await issueSDJWT({
      ...defaultParams,
      selectiveFields: ['principalId', 'scopes'],
    });

    expect(disclosures).toHaveLength(2);

    // Decode disclosures
    const decoded = disclosures.map(decodeDisclosure);
    const claimNames = decoded.map((d) => d.claimName).sort();
    expect(claimNames).toEqual(['principalId', 'scopes']);
  });

  it('includes delegation depth in selective fields by default', async () => {
    const { sdJwt, disclosures } = await issueSDJWT({
      ...defaultParams,
      delegationDepth: 2,
    });

    const decoded = disclosures.map(decodeDisclosure);
    const depthDisclosure = decoded.find((d) => d.claimName === 'delegationDepth');
    expect(depthDisclosure).toBeDefined();
    expect(depthDisclosure!.claimValue).toBe(2);
  });

  it('sets correct JWT header type', async () => {
    const { sdJwt } = await issueSDJWT(defaultParams);
    const issuerJwt = sdJwt.split('~')[0]!;

    // Decode the protected header
    const headerB64 = issuerJwt.split('.')[0]!;
    const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf-8'));
    expect(header.typ).toBe('vc+sd-jwt');
    expect(header.alg).toBe('RS256');
    expect(header.kid).toBeDefined();
  });

  it('disclosure hashes match the _sd array in the JWT', async () => {
    const { sdJwt, disclosures } = await issueSDJWT(defaultParams);
    const issuerJwt = sdJwt.split('~')[0]!;
    const payload = decodeJwt(issuerJwt);

    const vc = payload['vc'] as Record<string, unknown>;
    const subject = vc['credentialSubject'] as Record<string, unknown>;
    const sdArray = subject['_sd'] as string[];

    // Each disclosure's hash should appear in the _sd array
    for (const disc of disclosures) {
      const hash = hashDisclosure(disc);
      expect(sdArray).toContain(hash);
    }
  });
});

// ── SD-JWT Verification (Full Disclosure) ───────────────────────────────────

describe('verifySDJWT', () => {
  it('succeeds with full disclosure', async () => {
    const { sdJwt } = await issueSDJWT(defaultParams);

    const result = await verifySDJWT(sdJwt);

    expect(result.valid).toBe(true);
    expect(result.vcId).toMatch(/^vc_/);
    expect(result.disclosedClaims).toBeDefined();

    // All claims should be disclosed
    const claims = result.disclosedClaims!;
    expect(claims['id']).toBe('did:grantex:ag_SDJWT01');
    expect(claims['type']).toBe('AIAgent');
    expect(claims['grantId']).toBe('grnt_SDJWT01');
    expect(claims['principalId']).toBe('user_sd_123');
    expect(claims['developerId']).toBe('dev_TEST');
    expect(claims['scopes']).toEqual(['read', 'write']);
    expect(claims['delegationDepth']).toBe(0);
  });

  it('succeeds with partial disclosure', async () => {
    const { sdJwt } = await issueSDJWT(defaultParams);

    // Create a presentation with only some disclosures
    const presentation = createPresentation(sdJwt, ['principalId', 'scopes']);
    const result = await verifySDJWT(presentation);

    expect(result.valid).toBe(true);
    expect(result.disclosedClaims).toBeDefined();

    const claims = result.disclosedClaims!;
    // Visible (non-selective) claims should always be present
    expect(claims['id']).toBe('did:grantex:ag_SDJWT01');
    expect(claims['type']).toBe('AIAgent');
    expect(claims['grantId']).toBe('grnt_SDJWT01');

    // Only the selected disclosures should appear
    expect(claims['principalId']).toBe('user_sd_123');
    expect(claims['scopes']).toEqual(['read', 'write']);

    // Non-disclosed selective fields should NOT appear
    expect(claims['developerId']).toBeUndefined();
    expect(claims['delegationDepth']).toBeUndefined();
  });

  it('succeeds with zero disclosures', async () => {
    const { sdJwt } = await issueSDJWT(defaultParams);

    // Create a presentation with no disclosures
    const presentation = createPresentation(sdJwt, []);
    const result = await verifySDJWT(presentation);

    expect(result.valid).toBe(true);
    expect(result.disclosedClaims).toBeDefined();

    const claims = result.disclosedClaims!;
    // Only visible claims
    expect(claims['id']).toBe('did:grantex:ag_SDJWT01');
    expect(claims['type']).toBe('AIAgent');
    expect(claims['grantId']).toBe('grnt_SDJWT01');

    // No selective claims disclosed
    expect(claims['principalId']).toBeUndefined();
    expect(claims['developerId']).toBeUndefined();
    expect(claims['scopes']).toBeUndefined();
    expect(claims['delegationDepth']).toBeUndefined();
  });

  it('returns invalid for invalid SD-JWT format', async () => {
    const result = await verifySDJWT('not-valid');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Invalid SD-JWT format');
  });

  it('returns invalid for garbage JWT', async () => {
    const result = await verifySDJWT('a.b.c~disclosure~');
    expect(result.valid).toBe(false);
  });

  it('returns invalid for wrong signature', async () => {
    const { privateKey: fakeKey } = await generateKeyPair('RS256');
    const fakeJwt = await new SignJWT({
      vc: {
        '@context': ['https://www.w3.org/ns/credentials/v2'],
        type: ['VerifiableCredential'],
        credentialSubject: { _sd: [] },
      },
      _sd_alg: 'sha-256',
    })
      .setProtectedHeader({ alg: 'RS256', typ: 'vc+sd-jwt' })
      .setIssuer('did:web:fake.dev')
      .setSubject('did:fake:agent')
      .setJti('vc_FAKE')
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(fakeKey);

    const result = await verifySDJWT(fakeJwt + '~');
    expect(result.valid).toBe(false);
    expect(result.vcId).toBe('vc_FAKE');
  });

  it('returns invalid for expired SD-JWT', async () => {
    const { privateKey, kid } = getKeyPair();
    const expiredJwt = await new SignJWT({
      vc: {
        '@context': ['https://www.w3.org/ns/credentials/v2'],
        type: ['VerifiableCredential'],
        credentialSubject: { _sd: [] },
      },
      _sd_alg: 'sha-256',
    })
      .setProtectedHeader({ alg: 'RS256', kid, typ: 'vc+sd-jwt' })
      .setIssuer('did:web:grantex.dev')
      .setSubject('did:test:agent')
      .setJti('vc_EXPIRED')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(privateKey);

    const result = await verifySDJWT(expiredJwt + '~');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('SD-JWT expired');
  });

  it('returns invalid for tampered disclosure', async () => {
    const { sdJwt } = await issueSDJWT(defaultParams);

    // Tamper with a disclosure — modify the base64url content
    const parts = sdJwt.split('~');
    const issuerJwt = parts[0]!;
    const disclosures = parts.slice(1).filter((p) => p.length > 0);

    // Create a fake disclosure that does not match any _sd hash
    const fakeDisclosure = Buffer.from(
      JSON.stringify(['fakesalt', 'principalId', 'hacker']),
      'utf-8',
    ).toString('base64url');

    const tamperedSdJwt = issuerJwt + '~' + fakeDisclosure + '~';
    const result = await verifySDJWT(tamperedSdJwt);

    expect(result.valid).toBe(false);
    expect(result.error).toContain('Disclosure hash not found');
  });

  it('returns invalid for unsupported _sd_alg', async () => {
    const { privateKey, kid } = getKeyPair();
    const jwt = await new SignJWT({
      vc: {
        '@context': ['https://www.w3.org/ns/credentials/v2'],
        type: ['VerifiableCredential'],
        credentialSubject: { _sd: [] },
      },
      _sd_alg: 'sha-384',
    })
      .setProtectedHeader({ alg: 'RS256', kid, typ: 'vc+sd-jwt' })
      .setIssuer('did:web:grantex.dev')
      .setSubject('did:test:agent')
      .setJti('vc_BADALG')
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(privateKey);

    const result = await verifySDJWT(jwt + '~');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Unsupported _sd_alg');
  });

  it('returns invalid for missing vc claim', async () => {
    const { privateKey, kid } = getKeyPair();
    const jwt = await new SignJWT({ notVc: 'something', _sd_alg: 'sha-256' })
      .setProtectedHeader({ alg: 'RS256', kid, typ: 'vc+sd-jwt' })
      .setIssuer('did:web:grantex.dev')
      .setSubject('did:test:agent')
      .setJti('vc_NOVC')
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(privateKey);

    const result = await verifySDJWT(jwt + '~');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Missing vc claim');
  });

  it('returns invalid for missing credentialSubject', async () => {
    const { privateKey, kid } = getKeyPair();
    const jwt = await new SignJWT({
      vc: {
        '@context': ['https://www.w3.org/ns/credentials/v2'],
        type: ['VerifiableCredential'],
      },
      _sd_alg: 'sha-256',
    })
      .setProtectedHeader({ alg: 'RS256', kid, typ: 'vc+sd-jwt' })
      .setIssuer('did:web:grantex.dev')
      .setSubject('did:test:agent')
      .setJti('vc_NOSUB')
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(privateKey);

    const result = await verifySDJWT(jwt + '~');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Missing credentialSubject');
  });

  it('returns invalid for malformed disclosure (non-JSON)', async () => {
    const { sdJwt } = await issueSDJWT(defaultParams);
    const issuerJwt = sdJwt.split('~')[0]!;

    // Add a disclosure that is not valid base64url JSON
    const badDisclosure = Buffer.from('not-json', 'utf-8').toString('base64url');
    const badSdJwt = issuerJwt + '~' + badDisclosure + '~';

    const result = await verifySDJWT(badSdJwt);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Invalid disclosure format');
  });

  it('returns invalid for KB-JWT missing nonce and aud', async () => {
    const { sdJwt } = await issueSDJWT(defaultParams);

    // Create a KB-JWT with typ=kb+jwt but no nonce or aud
    const kbHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'kb+jwt' })).toString('base64url');
    const kbPayload = Buffer.from(JSON.stringify({ iat: 12345 })).toString('base64url');
    const kbJwt = `${kbHeader}.${kbPayload}.`;

    // Append KB-JWT to SD-JWT
    const withKb = sdJwt.replace(/~$/, '') + '~' + kbJwt + '~';
    const result = await verifySDJWT(withKb);

    expect(result.valid).toBe(false);
    expect(result.error).toBe('KB-JWT missing nonce or aud');
  });

  it('returns invalid for malformed KB-JWT', async () => {
    const { sdJwt } = await issueSDJWT(defaultParams);

    // Create something that has a kb+jwt header but invalid JWT payload
    const kbHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'kb+jwt' })).toString('base64url');
    const kbJwt = `${kbHeader}.!!!invalid!!!.`;

    const withKb = sdJwt.replace(/~$/, '') + '~' + kbJwt + '~';
    const result = await verifySDJWT(withKb);

    expect(result.valid).toBe(false);
    expect(result.error).toBe('Invalid KB-JWT format');
  });

  it('accepts valid KB-JWT with nonce', async () => {
    const { sdJwt } = await issueSDJWT(defaultParams);

    // Create a valid KB-JWT with nonce
    const kbHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'kb+jwt' })).toString('base64url');
    const kbPayload = Buffer.from(JSON.stringify({ nonce: 'test-nonce-123', iat: Math.floor(Date.now() / 1000) })).toString('base64url');
    const kbJwt = `${kbHeader}.${kbPayload}.`;

    const withKb = sdJwt.replace(/~$/, '') + '~' + kbJwt + '~';
    const result = await verifySDJWT(withKb);

    expect(result.valid).toBe(true);
    expect(result.disclosedClaims).toBeDefined();
  });

  it('accepts valid KB-JWT with aud', async () => {
    const { sdJwt } = await issueSDJWT(defaultParams);

    // Create a valid KB-JWT with aud
    const kbHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'kb+jwt' })).toString('base64url');
    const kbPayload = Buffer.from(JSON.stringify({ aud: 'https://verifier.example.com', iat: Math.floor(Date.now() / 1000) })).toString('base64url');
    const kbJwt = `${kbHeader}.${kbPayload}.`;

    const withKb = sdJwt.replace(/~$/, '') + '~' + kbJwt + '~';
    const result = await verifySDJWT(withKb);

    expect(result.valid).toBe(true);
  });

  it('treats parts with 2 dots but invalid JWT header as disclosures during verify', async () => {
    const { sdJwt } = await issueSDJWT(defaultParams);
    const issuerJwt = sdJwt.split('~')[0]!;

    // Create a part that has 2 dots but is NOT a valid JWT (invalid base64url header)
    // decodeProtectedHeader will throw, triggering the catch on line 220-221
    const fakeJwtLikePart = '!!!.not.valid';
    const withFake = issuerJwt + '~' + fakeJwtLikePart + '~';

    // It should be treated as a disclosure (not a KB-JWT), and then fail
    // because it's not a valid disclosure either
    const result = await verifySDJWT(withFake);
    expect(result.valid).toBe(false);
    // It should fail with disclosure error since it's parsed as disclosure
    expect(result.error).toBe('Invalid disclosure format');
  });

  it('returns invalid for disclosure with wrong array length', async () => {
    const { sdJwt } = await issueSDJWT(defaultParams);
    const issuerJwt = sdJwt.split('~')[0]!;

    // A valid JSON array but with wrong length (2 instead of 3)
    const badDisclosure = Buffer.from(
      JSON.stringify(['salt', 'claimName']),
      'utf-8',
    ).toString('base64url');
    const badSdJwt = issuerJwt + '~' + badDisclosure + '~';

    const result = await verifySDJWT(badSdJwt);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Invalid disclosure format');
  });
});

// ── SD-JWT Presentation ─────────────────────────────────────────────────────

describe('createPresentation', () => {
  it('creates a presentation with selected fields', async () => {
    const { sdJwt } = await issueSDJWT(defaultParams);

    const presentation = createPresentation(sdJwt, ['principalId']);

    // Should have issuer JWT + 1 disclosure + trailing ~
    const parts = presentation.split('~');
    const nonEmptyDisclosures = parts.slice(1).filter((p) => p.length > 0);
    expect(nonEmptyDisclosures).toHaveLength(1);

    // Decode the only disclosure
    const decoded = decodeDisclosure(nonEmptyDisclosures[0]!);
    expect(decoded.claimName).toBe('principalId');
    expect(decoded.claimValue).toBe('user_sd_123');
  });

  it('creates a presentation with multiple fields', async () => {
    const { sdJwt } = await issueSDJWT(defaultParams);

    const presentation = createPresentation(sdJwt, ['principalId', 'scopes']);
    const parts = presentation.split('~');
    const nonEmptyDisclosures = parts.slice(1).filter((p) => p.length > 0);
    expect(nonEmptyDisclosures).toHaveLength(2);

    const decoded = nonEmptyDisclosures.map(decodeDisclosure);
    const names = decoded.map((d) => d.claimName).sort();
    expect(names).toEqual(['principalId', 'scopes']);
  });

  it('creates a presentation with no fields (empty)', async () => {
    const { sdJwt } = await issueSDJWT(defaultParams);

    const presentation = createPresentation(sdJwt, []);
    const parts = presentation.split('~');
    const nonEmptyDisclosures = parts.slice(1).filter((p) => p.length > 0);
    expect(nonEmptyDisclosures).toHaveLength(0);
  });

  it('preserves the issuer JWT unchanged', async () => {
    const { sdJwt } = await issueSDJWT(defaultParams);
    const originalIssuerJwt = sdJwt.split('~')[0]!;

    const presentation = createPresentation(sdJwt, ['principalId']);
    const presentationIssuerJwt = presentation.split('~')[0]!;

    expect(presentationIssuerJwt).toBe(originalIssuerJwt);
  });

  it('throws for invalid SD-JWT format', () => {
    expect(() => createPresentation('not-valid', ['field'])).toThrow('Invalid SD-JWT format');
  });

  it('ignores fields not present in disclosures', async () => {
    const { sdJwt } = await issueSDJWT(defaultParams);

    const presentation = createPresentation(sdJwt, ['nonExistentField']);
    const parts = presentation.split('~');
    const nonEmptyDisclosures = parts.slice(1).filter((p) => p.length > 0);
    expect(nonEmptyDisclosures).toHaveLength(0);
  });

  it('strips KB-JWT (typ=kb+jwt) from the SD-JWT during presentation', async () => {
    const { sdJwt } = await issueSDJWT(defaultParams);

    // Craft a fake KB-JWT with typ=kb+jwt
    const kbHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'kb+jwt' })).toString('base64url');
    const kbPayload = Buffer.from(JSON.stringify({ nonce: 'n', aud: 'a' })).toString('base64url');
    const kbJwt = `${kbHeader}.${kbPayload}.`;

    // Append the KB-JWT before the trailing ~
    const withKb = sdJwt.replace(/~$/, '') + '~' + kbJwt + '~';

    const presentation = createPresentation(withKb, ['principalId']);
    const presentationParts = presentation.split('~').filter((p) => p.length > 0);

    // KB-JWT should not be in the presentation
    for (const part of presentationParts.slice(1)) {
      const dots = part.split('.').length - 1;
      if (dots === 2) {
        // Should not have kb+jwt type
        try {
          const header = JSON.parse(Buffer.from(part.split('.')[0]!, 'base64url').toString('utf-8'));
          expect(header.typ).not.toBe('kb+jwt');
        } catch {
          // Not a JWT, that's fine
        }
      }
    }
  });

  it('treats parts with 2 dots but non-JWT header as disclosures', async () => {
    const { sdJwt } = await issueSDJWT(defaultParams);

    // Add a disclosure that happens to have 2 dots but is not a valid JWT
    const fakePartWithDots = 'not.a.jwt';
    const withFakePart = sdJwt.replace(/~$/, '') + '~' + fakePartWithDots + '~';

    // Should not throw — the part should be treated as a disclosure (and will fail verification since hash won't match)
    const presentation = createPresentation(withFakePart, ['principalId']);
    expect(typeof presentation).toBe('string');
  });
});

// ── Roundtrip: Issue → Present → Verify ─────────────────────────────────────

describe('SD-JWT roundtrip', () => {
  it('issue → full verify → all claims present', async () => {
    const { sdJwt } = await issueSDJWT(defaultParams);
    const result = await verifySDJWT(sdJwt);

    expect(result.valid).toBe(true);
    expect(result.disclosedClaims!['principalId']).toBe('user_sd_123');
    expect(result.disclosedClaims!['developerId']).toBe('dev_TEST');
    expect(result.disclosedClaims!['scopes']).toEqual(['read', 'write']);
    expect(result.disclosedClaims!['delegationDepth']).toBe(0);
    expect(result.disclosedClaims!['grantId']).toBe('grnt_SDJWT01');
  });

  it('issue → partial present → verify only disclosed claims', async () => {
    const { sdJwt } = await issueSDJWT(defaultParams);
    const presentation = createPresentation(sdJwt, ['principalId']);
    const result = await verifySDJWT(presentation);

    expect(result.valid).toBe(true);
    expect(result.disclosedClaims!['principalId']).toBe('user_sd_123');
    expect(result.disclosedClaims!['developerId']).toBeUndefined();
    expect(result.disclosedClaims!['scopes']).toBeUndefined();
    // Visible claims always present
    expect(result.disclosedClaims!['grantId']).toBe('grnt_SDJWT01');
  });

  it('issue → present with nonce/audience → verify succeeds', async () => {
    const { sdJwt } = await issueSDJWT(defaultParams);
    const presentation = createPresentation(sdJwt, ['principalId'], {
      nonce: 'test-nonce-123',
      audience: 'https://verifier.example.com',
    });
    const result = await verifySDJWT(presentation);

    expect(result.valid).toBe(true);
    expect(result.disclosedClaims!['principalId']).toBe('user_sd_123');
  });
});

// ── POST /v1/credentials/present (route tests) ─────────────────────────────

describe('POST /v1/credentials/present', () => {
  it('returns valid for a properly issued SD-JWT', async () => {
    const { sdJwt } = await issueSDJWT(defaultParams);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/credentials/present',
      payload: { sdJwt },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.valid).toBe(true);
    expect(body.vcId).toBeDefined();
    expect(body.disclosedClaims).toBeDefined();
    expect(body.disclosedClaims.principalId).toBe('user_sd_123');
  });

  it('returns valid for a partial presentation', async () => {
    const { sdJwt } = await issueSDJWT(defaultParams);
    const presentation = createPresentation(sdJwt, ['scopes']);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/credentials/present',
      payload: { sdJwt: presentation },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.valid).toBe(true);
    expect(body.disclosedClaims.scopes).toEqual(['read', 'write']);
    expect(body.disclosedClaims.principalId).toBeUndefined();
  });

  it('returns invalid for tampered SD-JWT', async () => {
    const { sdJwt } = await issueSDJWT(defaultParams);
    const issuerJwt = sdJwt.split('~')[0]!;

    const fakeDisclosure = Buffer.from(
      JSON.stringify(['fakesalt', 'principalId', 'tampered']),
      'utf-8',
    ).toString('base64url');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/credentials/present',
      payload: { sdJwt: issuerJwt + '~' + fakeDisclosure + '~' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.valid).toBe(false);
    expect(body.error).toContain('Disclosure hash not found');
  });

  it('returns 400 when sdJwt is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/credentials/present',
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BAD_REQUEST');
  });

  it('does not require authentication (skipAuth)', async () => {
    const { sdJwt } = await issueSDJWT(defaultParams);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/credentials/present',
      payload: { sdJwt },
      // No auth header
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().valid).toBe(true);
  });

  it('returns invalid for expired SD-JWT presentation', async () => {
    const { privateKey, kid } = getKeyPair();
    const expiredJwt = await new SignJWT({
      vc: {
        '@context': ['https://www.w3.org/ns/credentials/v2'],
        type: ['VerifiableCredential'],
        credentialSubject: { _sd: [] },
      },
      _sd_alg: 'sha-256',
    })
      .setProtectedHeader({ alg: 'RS256', kid, typ: 'vc+sd-jwt' })
      .setIssuer('did:web:grantex.dev')
      .setSubject('did:test:agent')
      .setJti('vc_EXPIRED')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(privateKey);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/credentials/present',
      payload: { sdJwt: expiredJwt + '~' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.valid).toBe(false);
    expect(body.error).toBe('SD-JWT expired');
  });
});

// ── Token exchange with credentialFormat=sd-jwt ─────────────────────────────

const validAuthRequest = {
  id: 'areq_SDJWT_TEST',
  agent_id: TEST_AGENT.id,
  principal_id: 'user_sd_456',
  developer_id: TEST_DEVELOPER.id,
  scopes: ['read', 'write'],
  expires_in: '24h',
  expires_at: new Date(Date.now() + 86400_000).toISOString(),
  status: 'approved',
  agent_did: TEST_AGENT.did,
  code_challenge: null,
};

describe('POST /v1/token with credentialFormat=sd-jwt', () => {
  it('returns sdJwtCredential when credentialFormat=sd-jwt', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([validAuthRequest]);  // Auth request lookup
    sqlMock.mockResolvedValueOnce([]);  // INSERT grants
    sqlMock.mockResolvedValueOnce([]);  // INSERT grant_tokens
    sqlMock.mockResolvedValueOnce([]);  // INSERT refresh_tokens
    sqlMock.mockResolvedValueOnce([]);  // UPDATE auth_requests
    sqlMock.mockResolvedValueOnce([]);  // Budget check

    const res = await app.inject({
      method: 'POST',
      url: '/v1/token',
      headers: authHeader(),
      payload: { code: 'code-sdjwt', agentId: TEST_AGENT.id, credentialFormat: 'sd-jwt' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.grantToken).toBeDefined();
    expect(body.sdJwtCredential).toBeDefined();
    expect(typeof body.sdJwtCredential).toBe('string');

    // Verify the SD-JWT structure
    const sdJwtParts = (body.sdJwtCredential as string).split('~');
    expect(sdJwtParts.length).toBeGreaterThanOrEqual(3);

    // Should not have verifiableCredential (that's for vc-jwt)
    expect(body.verifiableCredential).toBeUndefined();

    // Verify it can be verified
    const verifyResult = await verifySDJWT(body.sdJwtCredential as string);
    expect(verifyResult.valid).toBe(true);
    expect(verifyResult.disclosedClaims!['principalId']).toBe('user_sd_456');
  });

  it('does not return sdJwtCredential for credentialFormat=vc-jwt', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([validAuthRequest]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([]);

    // VC issuance SQL calls
    sqlMock.mockResolvedValueOnce([{ id: 'vcsl_NTSDJWT', next_index: 0 }]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/token',
      headers: authHeader(),
      payload: { code: 'code-vcjwt', agentId: TEST_AGENT.id, credentialFormat: 'vc-jwt' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.verifiableCredential).toBeDefined();
    expect(body.sdJwtCredential).toBeUndefined();
  });
});
