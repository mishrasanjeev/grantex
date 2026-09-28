// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  PASSPORT_TYP,
  PASSPORT_VCT,
  MAX_PASSPORT_LIFETIME_SECONDS,
  PassportError,
  disclosureDigest,
  encodeDisclosure,
  externalCredentialHash,
  issuePassport,
  jwkThumbprint,
  verifyPassport,
  type Jwk,
  type VerifyPassportOptions,
} from '../src/index.ts';
import { decodeJwsUnverified, signJws } from '../src/jws.ts';
import {
  AGENT_DID,
  IAT,
  ISSUER,
  NOW,
  PROFILE_CLAIMS,
  ed25519KeyPair,
  p256KeyPair,
  passportParams,
  resolverFor,
} from './helpers.ts';

const issuer = p256KeyPair('mock-issuer-2026');
const holder = p256KeyPair();

function options(compact: string, extra: Partial<VerifyPassportOptions> = {}): VerifyPassportOptions {
  return { compact, issuerKeys: resolverFor(issuer.publicJwk), now: NOW, statusResolver: () => 'valid', ...extra };
}

async function refusal(promise: Promise<unknown>): Promise<{ code: string; reason: string }> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(PassportError);
    const e = error as PassportError;
    return { code: e.code, reason: e.reason };
  }
  throw new Error('expected a refusal');
}

/** Re-sign an issued passport after editing its header or payload. */
function resign(
  compact: string,
  edit: (header: Record<string, unknown>, payload: Record<string, unknown>) => void,
  key: Jwk = issuer.privateJwk,
): string {
  const [jwt, ...rest] = compact.split('~');
  const { header, payload } = decodeJwsUnverified(jwt as string);
  edit(header, payload);
  return [signJws(header, payload, key), ...rest].join('~');
}

describe('issuePassport', () => {
  it('issues the SD-JWT VC profile: dc+sd-jwt, ES256, vct, cnf, status and one digest per claim', () => {
    const issued = issuePassport(passportParams(issuer, holder));
    expect(issued.compact.endsWith('~')).toBe(true);
    const { header, payload } = decodeJwsUnverified(issued.issuerJwt);
    expect(header).toEqual({ alg: 'ES256', typ: PASSPORT_TYP, kid: 'mock-issuer-2026' });
    expect(PASSPORT_TYP).toBe('dc+sd-jwt');
    expect(payload.vct).toBe(PASSPORT_VCT);
    expect(payload.vct).toBe('urn:grantex:agent-passport:1');
    expect(payload.iss).toBe(ISSUER);
    expect(payload.sub).toBe(AGENT_DID);
    expect(payload.cnf).toEqual({ jwk: holder.publicJwk });
    expect(payload._sd_alg).toBe('sha-256');
    expect(payload.status).toEqual({ status_list: { uri: 'https://mock-issuer.example/status/1', idx: 42 } });
    // Selectively disclosable claims never appear in the clear.
    for (const name of ['provider', 'agent', 'verification', 'attestation_id']) {
      expect(payload).not.toHaveProperty(name);
    }
    const sd = payload._sd as string[];
    expect(sd).toHaveLength(4);
    expect([...sd].sort()).toEqual(sd);
    expect(issued.disclosures.map((d) => disclosureDigest(d.encoded)).sort()).toEqual(sd);
  });

  it('uses a fresh 128-bit salt for every disclosure', () => {
    const a = issuePassport(passportParams(issuer, holder));
    const b = issuePassport(passportParams(issuer, holder));
    const salts = [...a.disclosures, ...b.disclosures].map((d) => d.salt);
    expect(new Set(salts).size).toBe(salts.length);
    for (const salt of salts) expect(Buffer.from(salt, 'base64url')).toHaveLength(16);
  });

  it('skips a claim whose value is null or undefined, as the Python package skips None', () => {
    const claims = { ...structuredClone(PROFILE_CLAIMS), attestation_id: null, verification: undefined };
    const issued = issuePassport(passportParams(issuer, holder, { claims: claims as unknown as typeof PROFILE_CLAIMS }));
    expect(issued.disclosures.map((d) => d.name)).toEqual(['provider', 'agent']);
  });

  it('refuses a lifetime beyond one year, a private cnf key and a key it cannot sign with', () => {
    expect(() => issuePassport(passportParams(issuer, holder, { exp: IAT + MAX_PASSPORT_LIFETIME_SECONDS + 1 })))
      .toThrow(PassportError);
    expect(() => issuePassport(passportParams(issuer, holder, { cnfJwk: holder.privateJwk }))).toThrow(PassportError);
    expect(() => issuePassport(passportParams(issuer, holder, { issuerKey: issuer.publicJwk }))).toThrow(PassportError);
  });
});

describe('verifyPassport', () => {
  it('returns the disclosed claims, the cnf key and the hash', async () => {
    const issued = issuePassport(passportParams(issuer, holder));
    const result = await verifyPassport(options(issued.compact));
    expect(result.iss).toBe(ISSUER);
    expect(result.sub).toBe(AGENT_DID);
    expect(result.vct).toBe(PASSPORT_VCT);
    expect(result.iat).toBe(IAT);
    expect(result.cnfJwk).toEqual(holder.publicJwk);
    expect(result.cnfThumbprint).toBe(jwkThumbprint(holder.publicJwk));
    expect(result.status).toEqual({ status_list: { uri: 'https://mock-issuer.example/status/1', idx: 42 } });
    expect(result.disclosed).toEqual(PROFILE_CLAIMS);
    expect(result.claims).not.toHaveProperty('_sd');
    expect(result.claims).not.toHaveProperty('_sd_alg');
    expect(result.claims.provider).toEqual(PROFILE_CLAIMS.provider);
    expect(result.externalCredentialHash).toBe(externalCredentialHash(issued.compact));
    expect(result.keyBinding).toBeUndefined();
  });

  it('returns only what the holder chose to disclose', async () => {
    const issued = issuePassport(passportParams(issuer, holder));
    const agentOnly = issued.disclosures.find((d) => d.name === 'agent');
    const compact = `${issued.issuerJwt}~${agentOnly?.encoded}~`;
    const result = await verifyPassport(options(compact));
    expect(result.disclosed).toEqual({ agent: PROFILE_CLAIMS.agent });
    const none = await verifyPassport(options(`${issued.issuerJwt}~`));
    expect(none.disclosed).toEqual({});
  });

  it('accepts an EdDSA issuer only when allowEdDSA is set', async () => {
    const edIssuer = ed25519KeyPair('ed-1');
    const issued = issuePassport(passportParams(edIssuer, holder));
    const opts: VerifyPassportOptions = {
      compact: issued.compact,
      issuerKeys: resolverFor(edIssuer.publicJwk),
      now: NOW,
      statusResolver: () => 'valid',
    };
    expect(await refusal(verifyPassport(opts))).toEqual({ code: 'passport_not_accepted', reason: 'eddsa_not_enabled' });
    const result = await verifyPassport({ ...opts, allowEdDSA: true });
    expect(result.iss).toBe(ISSUER);
  });

  it('refuses a wrong typ, including the pre-rename vc+sd-jwt and a plain JWT', async () => {
    const issued = issuePassport(passportParams(issuer, holder));
    for (const typ of ['vc+sd-jwt', 'JWT', undefined]) {
      const compact = resign(issued.compact, (header) => {
        if (typ === undefined) delete header.typ;
        else header.typ = typ;
      });
      expect(await refusal(verifyPassport(options(compact)))).toEqual({ code: 'passport_malformed', reason: 'wrong_typ' });
    }
  });

  it('refuses a wrong vct, and honours expectedVct', async () => {
    const issued = issuePassport(passportParams(issuer, holder, { vct: 'urn:example:other:1' }));
    expect(await refusal(verifyPassport(options(issued.compact)))).toEqual({
      code: 'passport_not_accepted',
      reason: 'wrong_vct',
    });
    const result = await verifyPassport(options(issued.compact, { expectedVct: 'urn:example:other:1' }));
    expect(result.vct).toBe('urn:example:other:1');
  });

  it('refuses a bad signature with passport_invalid_signature', async () => {
    const issued = issuePassport(passportParams(issuer, holder));
    const other = p256KeyPair('mock-issuer-2026');
    const forged = resign(issued.compact, () => {}, other.privateJwk);
    expect(await refusal(verifyPassport(options(forged)))).toEqual({
      code: 'passport_invalid_signature',
      reason: 'signature_mismatch',
    });
    // Flip one bit of the signature.
    const [jwt, ...rest] = issued.compact.split('~');
    const parts = (jwt as string).split('.');
    const sig = Buffer.from(parts[2] as string, 'base64url');
    sig[5] = (sig[5] as number) ^ 1;
    const flipped = [parts[0], parts[1], sig.toString('base64url')].join('.');
    expect(await refusal(verifyPassport(options([flipped, ...rest].join('~'))))).toEqual({
      code: 'passport_invalid_signature',
      reason: 'signature_mismatch',
    });
  });

  it('accepts the n - s form of an ES256 signature, which has another hash (spec section 6)', async () => {
    // P-256 group order n. JWS does not require low-s, so (r, n - s) also verifies;
    // the spec therefore says the hash names the exact bytes and is not a deny-list key.
    const n = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
    const issued = issuePassport(passportParams(issuer, holder));
    const [jwt, ...rest] = issued.compact.split('~');
    const parts = (jwt as string).split('.');
    const sig = Buffer.from(parts[2] as string, 'base64url');
    const s = BigInt(`0x${sig.subarray(32).toString('hex')}`);
    const other = Buffer.from((n - s).toString(16).padStart(64, '0'), 'hex');
    const mirrored = [parts[0], parts[1], Buffer.concat([sig.subarray(0, 32), other]).toString('base64url')].join('.');
    const compact = [mirrored, ...rest].join('~');
    const result = await verifyPassport(options(compact));
    expect(result.disclosed).toEqual(PROFILE_CLAIMS);
    expect(result.externalCredentialHash).not.toBe(externalCredentialHash(issued.compact));
  });

  it('refuses when the resolver has no key for the issuer or kid, or fails', async () => {
    const issued = issuePassport(passportParams(issuer, holder));
    expect(await refusal(verifyPassport(options(issued.compact, { issuerKeys: () => [] })))).toEqual({
      code: 'passport_invalid_signature',
      reason: 'issuer_key_not_found',
    });
    const otherKid = { ...issuer.publicJwk, kid: 'another' };
    expect(await refusal(verifyPassport(options(issued.compact, { issuerKeys: () => [otherKid] })))).toEqual({
      code: 'passport_invalid_signature',
      reason: 'issuer_key_not_found',
    });
    const failing = async (): Promise<Jwk[]> => {
      throw new Error('registry unavailable');
    };
    const error = await verifyPassport(options(issued.compact, { issuerKeys: failing })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PassportError);
    expect((error as PassportError).code).toBe('passport_invalid_signature');
    expect((error as PassportError).reason).toBe('issuer_key_resolution_failed');
    expect(((error as PassportError).cause as Error).message).toBe('registry unavailable');
    // A private key from the resolver is a misconfiguration: refuse rather than use it.
    expect(await refusal(verifyPassport(options(issued.compact, { issuerKeys: () => [issuer.privateJwk] })))).toEqual({
      code: 'passport_invalid_signature',
      reason: 'issuer_key_invalid',
    });
  });

  it('never takes the issuer key from the token (jku, x5u, jwk, x5c) - PRD section 13', async () => {
    const issued = issuePassport(passportParams(issuer, holder));
    for (const member of ['jku', 'x5u', 'jwk', 'x5c']) {
      const compact = resign(issued.compact, (header) => {
        header[member] =
          member === 'jwk' ? issuer.publicJwk : member === 'x5c' ? ['MIIB'] : 'https://keys.example/jwks.json';
      });
      let resolverCalled = false;
      const resolver = (iss: string): Jwk[] => {
        resolverCalled = true;
        return resolverFor(issuer.publicJwk)(iss);
      };
      expect(await refusal(verifyPassport(options(compact, { issuerKeys: resolver })))).toEqual({
        code: 'passport_malformed',
        reason: 'header_key_not_allowed',
      });
      expect(resolverCalled).toBe(false);
    }
  });

  it('refuses alg none, HS256 and a crit header', async () => {
    const issued = issuePassport(passportParams(issuer, holder));
    const [jwt] = issued.compact.split('~');
    const { payload } = decodeJwsUnverified(jwt as string);
    const unsigned = [
      Buffer.from(JSON.stringify({ alg: 'none', typ: 'dc+sd-jwt' })).toString('base64url'),
      Buffer.from(JSON.stringify(payload)).toString('base64url'),
      '',
    ].join('.');
    expect(await refusal(verifyPassport(options(`${unsigned}~`)))).toEqual({
      code: 'passport_malformed',
      reason: 'alg_not_allowed',
    });
    const hs = resign(issued.compact, (header) => {
      header.alg = 'HS256';
    });
    expect(await refusal(verifyPassport(options(hs)))).toEqual({ code: 'passport_malformed', reason: 'alg_not_allowed' });
    const crit = resign(issued.compact, (header) => {
      header.crit = ['exp'];
    });
    expect(await refusal(verifyPassport(options(crit)))).toEqual({
      code: 'passport_malformed',
      reason: 'crit_not_supported',
    });
  });

  it('refuses an expired passport with passport_expired, and one not yet valid', async () => {
    const issued = issuePassport(passportParams(issuer, holder));
    const exp = IAT + 30 * 86_400;
    expect(await refusal(verifyPassport(options(issued.compact, { now: exp })))).toEqual({
      code: 'passport_expired',
      reason: 'expired',
    });
    expect((await verifyPassport(options(issued.compact, { now: exp - 1 }))).exp).toBe(exp);
    expect((await verifyPassport(options(issued.compact, { now: exp + 30, clockSkewSeconds: 60 }))).exp).toBe(exp);
    expect(await refusal(verifyPassport(options(issued.compact, { now: IAT - 1 })))).toEqual({
      code: 'passport_expired',
      reason: 'not_yet_valid',
    });
    const nbf = resign(issued.compact, (_h, payload) => {
      payload.nbf = NOW + 10;
    });
    expect(await refusal(verifyPassport(options(nbf)))).toEqual({ code: 'passport_expired', reason: 'not_yet_valid' });
  });

  it('refuses exp beyond one year after iat, and exp not after iat', async () => {
    const issued = issuePassport(passportParams(issuer, holder));
    const long = resign(issued.compact, (_h, payload) => {
      payload.exp = IAT + MAX_PASSPORT_LIFETIME_SECONDS + 1;
    });
    expect(await refusal(verifyPassport(options(long)))).toEqual({
      code: 'passport_not_accepted',
      reason: 'lifetime_exceeds_one_year',
    });
    const exact = resign(issued.compact, (_h, payload) => {
      payload.exp = IAT + MAX_PASSPORT_LIFETIME_SECONDS;
    });
    expect((await verifyPassport(options(exact))).exp).toBe(IAT + MAX_PASSPORT_LIFETIME_SECONDS);
    const inverted = resign(issued.compact, (_h, payload) => {
      payload.exp = IAT;
    });
    expect(await refusal(verifyPassport(options(inverted)))).toEqual({ code: 'passport_malformed', reason: 'bad_claim' });
  });

  it('refuses missing or malformed registered claims', async () => {
    const issued = issuePassport(passportParams(issuer, holder));
    const cases: Array<(p: Record<string, unknown>) => void> = [
      (p) => delete p.iss,
      (p) => (p.iss = 'http://mock-issuer.example'),
      (p) => delete p.sub,
      (p) => (p.sub = 'shopper-01'),
      (p) => (p.iat = String(IAT)),
      (p) => delete p.exp,
      (p) => delete p.status,
      (p) => (p.status = { status_list: { uri: 'https://mock-issuer.example/status/1', idx: -1 } }),
      (p) => (p.status = { status_list: { idx: 1 } }),
      (p) => delete p.vct,
    ];
    for (const edit of cases) {
      const compact = resign(issued.compact, (_h, payload) => edit(payload));
      const r = await refusal(verifyPassport(options(compact)));
      expect(r).toEqual({ code: 'passport_malformed', reason: 'bad_claim' });
    }
    const sdAlg = resign(issued.compact, (_h, payload) => {
      payload._sd_alg = 'sha-512';
    });
    expect(await refusal(verifyPassport(options(sdAlg)))).toEqual({
      code: 'passport_malformed',
      reason: 'sd_alg_not_supported',
    });
  });

  it('refuses a disclosure whose digest is not in _sd', async () => {
    const issued = issuePassport(passportParams(issuer, holder));
    const stray = encodeDisclosure('c2FsdHNhbHRzYWx0c2FsdA', 'attestation_id', 'att_forged');
    expect(await refusal(verifyPassport(options(`${issued.compact}${stray}~`)))).toEqual({
      code: 'passport_malformed',
      reason: 'disclosure_not_referenced',
    });
    // Editing a disclosure's value changes its digest, so it is no longer referenced.
    const agent = issued.disclosures.find((d) => d.name === 'agent');
    const edited = encodeDisclosure(agent?.salt as string, 'agent', { ...PROFILE_CLAIMS.agent, software_version: '9.9' });
    expect(await refusal(verifyPassport(options(`${issued.issuerJwt}~${edited}~`)))).toEqual({
      code: 'passport_malformed',
      reason: 'disclosure_not_referenced',
    });
  });

  it('refuses duplicate disclosures and duplicate digests', async () => {
    const issued = issuePassport(passportParams(issuer, holder));
    const first = issued.disclosures[0]?.encoded as string;
    expect(await refusal(verifyPassport(options(`${issued.compact}${first}~`)))).toEqual({
      code: 'passport_malformed',
      reason: 'duplicate_disclosure',
    });
    const dupDigest = resign(issued.compact, (_h, payload) => {
      const sd = payload._sd as string[];
      payload._sd = [...sd, sd[0]];
    });
    expect(await refusal(verifyPassport(options(dupDigest)))).toEqual({
      code: 'passport_malformed',
      reason: 'duplicate_digest',
    });
  });

  it('refuses disclosures of registered claims, of _sd and of a name already present', async () => {
    const issued = issuePassport(passportParams(issuer, holder));
    for (const name of ['iss', 'exp', 'cnf', 'vct', 'status', '_sd', '...', 'sub', 'iat']) {
      const d = encodeDisclosure('c2FsdHNhbHRzYWx0c2FsdA', name, 'x');
      const compact = resign(`${issued.issuerJwt}~${d}~`, (_h, payload) => {
        payload._sd = [...(payload._sd as string[]), disclosureDigest(d)].sort();
      });
      expect(await refusal(verifyPassport(options(compact)))).toEqual({
        code: 'passport_malformed',
        reason: 'disclosure_name_not_allowed',
      });
    }
    // A disclosure that repeats a claim the issuer left in the clear (section 7.1 step 3.3.2.2.3).
    const d = encodeDisclosure('c2FsdHNhbHRzYWx0c2FsdA', 'attestation_id', 'att_2');
    const conflict = resign(`${issued.issuerJwt}~${d}~`, (_h, payload) => {
      payload.attestation_id = 'att_1';
      payload._sd = [...(payload._sd as string[]), disclosureDigest(d)].sort();
    });
    expect(await refusal(verifyPassport(options(conflict)))).toEqual({
      code: 'passport_malformed',
      reason: 'claim_name_conflict',
    });
  });

  it('refuses malformed disclosures and malformed SD-JWT framing', async () => {
    const issued = issuePassport(passportParams(issuer, holder));
    const bad = [
      Buffer.from('not json').toString('base64url'),
      Buffer.from(JSON.stringify(['salt', 'x'])).toString('base64url'),
      Buffer.from(JSON.stringify({ salt: 's' })).toString('base64url'),
      Buffer.from(JSON.stringify([1, 'x', 'y'])).toString('base64url'),
      'has+plus',
    ];
    for (const d of bad) {
      const compact = resign(`${issued.issuerJwt}~${d}~`, (_h, payload) => {
        payload._sd = [...(payload._sd as string[]), disclosureDigest(d)].sort();
      });
      expect(await refusal(verifyPassport(options(compact)))).toEqual({
        code: 'passport_malformed',
        reason: 'disclosure_malformed',
      });
    }
    expect(await refusal(verifyPassport(options(`${issued.issuerJwt}~~`)))).toEqual({
      code: 'passport_malformed',
      reason: 'not_sd_jwt',
    });
    expect(await refusal(verifyPassport(options(issued.issuerJwt)))).toEqual({
      code: 'passport_malformed',
      reason: 'not_sd_jwt',
    });
  });

  it('refuses a missing cnf, a cnf with private members and an unsupported cnf key', async () => {
    const issued = issuePassport(passportParams(issuer, holder));
    const missing = resign(issued.compact, (_h, payload) => {
      delete payload.cnf;
    });
    expect(await refusal(verifyPassport(options(missing)))).toEqual({ code: 'passport_malformed', reason: 'cnf_missing' });
    const noJwk = resign(issued.compact, (_h, payload) => {
      payload.cnf = { kid: 'holder-1' };
    });
    expect(await refusal(verifyPassport(options(noJwk)))).toEqual({ code: 'passport_malformed', reason: 'cnf_missing' });
    const priv = resign(issued.compact, (_h, payload) => {
      payload.cnf = { jwk: holder.privateJwk };
    });
    expect(await refusal(verifyPassport(options(priv)))).toEqual({
      code: 'passport_malformed',
      reason: 'cnf_private_key',
    });
    const rsa = resign(issued.compact, (_h, payload) => {
      payload.cnf = { jwk: { kty: 'RSA', n: 'AQAB', e: 'AQAB' } };
    });
    expect(await refusal(verifyPassport(options(rsa)))).toEqual({
      code: 'passport_malformed',
      reason: 'cnf_unsupported_key',
    });
  });

  it('requires a P-256 cnf key when paymentsRails is set', async () => {
    const edHolder = ed25519KeyPair();
    const issued = issuePassport(passportParams(issuer, edHolder));
    const ok = await verifyPassport(options(issued.compact));
    expect(ok.cnfJwk).toEqual(edHolder.publicJwk);
    expect(await refusal(verifyPassport(options(issued.compact, { paymentsRails: true })))).toEqual({
      code: 'passport_not_accepted',
      reason: 'cnf_not_p256',
    });
    const p256 = issuePassport(passportParams(issuer, holder));
    expect((await verifyPassport(options(p256.compact, { paymentsRails: true }))).cnfJwk.crv).toBe('P-256');
  });

  it('refuses a disclosed profile claim of the wrong shape', async () => {
    const claims = structuredClone(PROFILE_CLAIMS) as Record<string, unknown>;
    claims.agent = { software_name: 'Nimbus Shopper' };
    const issued = issuePassport(passportParams(issuer, holder, { claims: claims as never }));
    expect(await refusal(verifyPassport(options(issued.compact)))).toEqual({
      code: 'passport_malformed',
      reason: 'bad_claim',
    });
  });

  it('refuses a presentation carrying a KB-JWT when no key binding was asked for', async () => {
    const issued = issuePassport(passportParams(issuer, holder));
    expect(await refusal(verifyPassport(options(`${issued.compact}eyJhbGciOiJFUzI1NiJ9.e30.c2ln`)))).toEqual({
      code: 'passport_malformed',
      reason: 'unexpected_key_binding',
    });
  });
});

describe('recursive disclosures (RFC 9901 section 7.1)', () => {
  it('processes nested _sd and array element disclosures from another issuer implementation', async () => {
    const issued = issuePassport(passportParams(issuer, holder));
    const nestedName = encodeDisclosure('bmVzdGVkc2FsdG5lc3RlZA', 'name', 'Provider Example Ltd');
    const element = encodeDisclosure('ZWxlbWVudHNhbHRlbGVtZQ', undefined, 'shopping');
    const provider = encodeDisclosure('cHJvdmlkZXJzYWx0cHJvdg', 'provider', {
      did: 'did:web:provider.example',
      legal_identifiers: [],
      _sd: [disclosureDigest(nestedName)],
    });
    const agent = encodeDisclosure('YWdlbnRzYWx0YWdlbnRzYQ', 'agent', {
      software_name: 'Nimbus Shopper',
      software_version: '2.4',
      categories: [{ '...': disclosureDigest(element) }, 'travel'],
    });
    const compact = resign(`${issued.issuerJwt}~${provider}~${nestedName}~${agent}~${element}~`, (_h, payload) => {
      payload._sd = [disclosureDigest(provider), disclosureDigest(agent)].sort();
    });
    const result = await verifyPassport(options(compact));
    expect(result.disclosed.provider).toEqual({
      did: 'did:web:provider.example',
      legal_identifiers: [],
      name: 'Provider Example Ltd',
    });
    expect(result.disclosed.agent?.categories).toEqual(['shopping', 'travel']);
    // Withholding the element disclosure removes the element (section 7.1 step 3.4).
    const withheld = compact.replace(`${element}~`, '');
    expect((await verifyPassport(options(withheld))).disclosed.agent?.categories).toEqual(['travel']);
  });

  it('refuses an element disclosure referenced as an object property, and the reverse', async () => {
    const issued = issuePassport(passportParams(issuer, holder));
    const element = encodeDisclosure('ZWxlbWVudHNhbHRlbGVtZQ', undefined, 'shopping');
    const asProperty = resign(`${issued.issuerJwt}~${element}~`, (_h, payload) => {
      payload._sd = [...(payload._sd as string[]), disclosureDigest(element)].sort();
    });
    expect(await refusal(verifyPassport(options(asProperty)))).toEqual({
      code: 'passport_malformed',
      reason: 'disclosure_malformed',
    });
    const property = encodeDisclosure('cHJvcGVydHlzYWx0cHJvcA', 'x', 'shopping');
    const agent = encodeDisclosure('YWdlbnRzYWx0YWdlbnRzYQ', 'agent', {
      software_name: 'Nimbus Shopper',
      software_version: '2.4',
      categories: [{ '...': disclosureDigest(property) }],
    });
    const asElement = resign(`${issued.issuerJwt}~${agent}~${property}~`, (_h, payload) => {
      payload._sd = [disclosureDigest(agent)];
    });
    expect(await refusal(verifyPassport(options(asElement)))).toEqual({
      code: 'passport_malformed',
      reason: 'disclosure_malformed',
    });
  });
});

describe('status (draft-ietf-oauth-status-list section 7.1): verifyPassport fails closed', () => {
  const STATUS_URI = 'https://mock-issuer.example/status/1';

  /** The options without any status decision, so each test states its own. */
  function bare(compact: string, extra: Partial<VerifyPassportOptions> = {}): VerifyPassportOptions {
    return { compact, issuerKeys: resolverFor(issuer.publicJwk), now: NOW, ...extra };
  }

  it('refuses to run with neither a status resolver nor statusCheckedBy', async () => {
    const issued = issuePassport(passportParams(issuer, holder));
    const error = await verifyPassport(bare(issued.compact)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TypeError);
    expect(error).not.toBeInstanceOf(PassportError);
    expect((error as Error).message).toMatch(/statusResolver.*statusCheckedBy/);
  });

  it('refuses both a resolver and statusCheckedBy, and any statusCheckedBy other than caller', async () => {
    const issued = issuePassport(passportParams(issuer, holder));
    const both = bare(issued.compact, { statusResolver: () => 'valid', statusCheckedBy: 'caller' });
    await expect(verifyPassport(both)).rejects.toBeInstanceOf(TypeError);
    const other = bare(issued.compact, { statusCheckedBy: 'verifier' as unknown as 'caller' });
    await expect(verifyPassport(other)).rejects.toBeInstanceOf(TypeError);
    const notFunction = bare(issued.compact, { statusResolver: 'valid' as unknown as () => 'valid' });
    await expect(verifyPassport(notFunction)).rejects.toBeInstanceOf(TypeError);
  });

  it('passes the status reference to the resolver and accepts VALID', async () => {
    const issued = issuePassport(passportParams(issuer, holder));
    const calls: unknown[][] = [];
    const result = await verifyPassport(
      bare(issued.compact, {
        statusResolver: async (uri, idx): Promise<'valid'> => {
          calls.push([uri, idx]);
          return 'valid';
        },
      }),
    );
    expect(calls).toEqual([[STATUS_URI, 42]]);
    expect(result.statusCheckedBy).toBe('resolver');
  });

  it('refuses INVALID and SUSPENDED with passport_revoked', async () => {
    const issued = issuePassport(passportParams(issuer, holder));
    expect(await refusal(verifyPassport(bare(issued.compact, { statusResolver: () => 'invalid' })))).toEqual({
      code: 'passport_revoked',
      reason: 'status_invalid',
    });
    expect(await refusal(verifyPassport(bare(issued.compact, { statusResolver: () => 'suspended' })))).toEqual({
      code: 'passport_revoked',
      reason: 'status_suspended',
    });
  });

  it('refuses with status_stale when the resolver fails or answers something unknown', async () => {
    const issued = issuePassport(passportParams(issuer, holder));
    const cause = new Error('status list unreachable');
    const thrown = await verifyPassport(
      bare(issued.compact, {
        statusResolver: () => {
          throw cause;
        },
      }),
    ).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(PassportError);
    expect({ code: (thrown as PassportError).code, reason: (thrown as PassportError).reason }).toEqual({
      code: 'status_stale',
      reason: 'status_unresolved',
    });
    expect((thrown as PassportError).cause).toBe(cause);
    expect(await refusal(verifyPassport(bare(issued.compact, { statusResolver: () => Promise.reject(cause) })))).toEqual({
      code: 'status_stale',
      reason: 'status_unresolved',
    });
    for (const answer of ['unknown', 'VALID', 0, undefined, null, true]) {
      const resolver = (() => answer) as unknown as () => 'valid';
      expect(await refusal(verifyPassport(bare(issued.compact, { statusResolver: resolver })))).toEqual({
        code: 'status_stale',
        reason: 'status_unknown',
      });
    }
  });

  it("accepts statusCheckedBy: 'caller' without a resolver and says so in the result", async () => {
    const issued = issuePassport(passportParams(issuer, holder));
    const result = await verifyPassport(bare(issued.compact, { statusCheckedBy: 'caller' }));
    expect(result.statusCheckedBy).toBe('caller');
    expect(result.status).toEqual({ status_list: { uri: STATUS_URI, idx: 42 } });
  });

  it('does not call the resolver for a passport that is refused on another rule', async () => {
    const issued = issuePassport(passportParams(issuer, holder));
    let called = false;
    const resolver = () => {
      called = true;
      return 'valid' as const;
    };
    expect(await refusal(verifyPassport(bare(issued.compact, { now: IAT + 31 * 86_400, statusResolver: resolver })))).toEqual({
      code: 'passport_expired',
      reason: 'expired',
    });
    expect(called).toBe(false);
  });
});

describe('DID syntax (W3C DID Core section 3.1)', () => {
  const valid = [
    'did:web:provider.example',
    'did:web:provider.example:agents:shopper-01',
    'did:web:provider.example%3A8443:agents:shopper-01',
    'did:example:123456789abcdefghi',
    'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
    'did:example:a::b',
    'did:example:A.b-c_d',
  ];
  const invalid = [
    'xdid:web:provider.example',
    'did:web:provider.example agent',
    'did:web:provider.example\n',
    'did:web:provider.example/agents',
    'did:web:provider.example?service=x',
    'did:web:provider.example#key-1',
    'did:web:',
    'did:web:provider.example:',
    'did:Web:provider.example',
    'did::provider.example',
    'did:web',
    'did:web:provider%2',
    'did:web:provider%zz',
    'did:web:café.example',
  ];

  it('issues and verifies a passport for every DID the ABNF allows', async () => {
    for (const sub of valid) {
      const issued = issuePassport(passportParams(issuer, holder, { sub }));
      expect((await verifyPassport(options(issued.compact))).sub).toBe(sub);
    }
  });

  it('refuses a sub that is not a DID in full, at issue and at verify', async () => {
    const issued = issuePassport(passportParams(issuer, holder));
    for (const sub of invalid) {
      expect(() => issuePassport(passportParams(issuer, holder, { sub }))).toThrow(PassportError);
      const compact = resign(issued.compact, (_h, payload) => {
        payload.sub = sub;
      });
      expect(await refusal(verifyPassport(options(compact)))).toEqual({ code: 'passport_malformed', reason: 'bad_claim' });
    }
  });

  it('refuses a provider.did that is not a DID in full', async () => {
    for (const did of invalid) {
      const claims = { ...structuredClone(PROFILE_CLAIMS), provider: { ...PROFILE_CLAIMS.provider, did } };
      const issued = issuePassport(passportParams(issuer, holder, { claims }));
      expect(await refusal(verifyPassport(options(issued.compact)))).toEqual({ code: 'passport_malformed', reason: 'bad_claim' });
    }
  });
});
