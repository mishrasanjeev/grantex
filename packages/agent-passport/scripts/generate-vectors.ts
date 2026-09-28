// SPDX-License-Identifier: Apache-2.0
//
// Writes spec/examples/agent-passport-vectors.json: synthetic keys are
// generated here, used to sign, and discarded. Only public keys and signed
// outputs are written. Run from packages/agent-passport:
//
//   npm run vectors
//
// Both packages' test suites check every vector (tests/vectors.test.ts,
// packages/agent-passport-py/tests/test_vectors.py).

import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createKeyBindingJwt,
  disclosureDigest,
  encodeDisclosure,
  externalCredentialHash,
  issuePassport,
  jwkThumbprint,
  selectDisclosures,
  type IssuePassportParams,
  type Jwk,
} from '../src/index.ts';
import { decodeJwsUnverified, signJws } from '../src/jws.ts';

interface KeyPair {
  privateJwk: Jwk;
  publicJwk: Jwk;
}

function keyPair(type: 'ec' | 'ed25519', kid?: string): KeyPair {
  const { privateKey, publicKey } =
    type === 'ec' ? generateKeyPairSync('ec', { namedCurve: 'P-256' }) : generateKeyPairSync('ed25519');
  const privateJwk = privateKey.export({ format: 'jwk' }) as Jwk;
  const publicJwk = publicKey.export({ format: 'jwk' }) as Jwk;
  if (kid !== undefined) {
    privateJwk.kid = kid;
    publicJwk.kid = kid;
  }
  return { privateJwk, publicJwk };
}

const ISSUER = 'https://mock-issuer.example';
const IAT = 1_790_000_000;
const EXP = IAT + 30 * 86_400;
const NOW = IAT + 3_600;
const AUD = 'https://merchant.example';
const NONCE = 'vector-nonce-01';

const issuerEs = keyPair('ec', 'mock-issuer-es256');
const issuerEd = keyPair('ed25519', 'mock-issuer-eddsa');
const holder = keyPair('ec');
const holderEd = keyPair('ed25519');
const stranger = keyPair('ec', 'mock-issuer-es256');

const claims = {
  provider: {
    did: 'did:web:provider.example',
    legal_identifiers: [{ scheme: 'registration_number', value: 'EX-0000001' }],
    name: 'Provider Example Ltd',
  },
  agent: {
    software_name: 'Nimbus Shopper',
    software_version: '2.4',
    cimd_uri: 'https://provider.example/agents/shopper-01/client-metadata.json',
    categories: ['shopping'],
    declared_limits: { max_transaction: { amount: '500.00', currency: 'USD' } },
  },
  verification: { level: 'standard', types: ['business_registry', 'domain_control'], performed_at: IAT - 86_400 },
  attestation_id: 'att_01J00000000000000000000000',
};

function params(overrides: Partial<IssuePassportParams> = {}): IssuePassportParams {
  return {
    issuerKey: issuerEs.privateJwk,
    iss: ISSUER,
    sub: 'did:web:provider.example:agents:shopper-01',
    cnfJwk: holder.publicJwk,
    iat: IAT,
    exp: EXP,
    status: { status_list: { uri: 'https://mock-issuer.example/status/1', idx: 42 } },
    claims: structuredClone(claims),
    ...overrides,
  };
}

function resign(
  compact: string,
  edit: (header: Record<string, unknown>, payload: Record<string, unknown>) => void,
  key: Jwk = issuerEs.privateJwk,
): string {
  const [jwt, ...rest] = compact.split('~');
  const { header, payload } = decodeJwsUnverified(jwt as string);
  edit(header, payload);
  return [signJws(header, payload, key), ...rest].join('~');
}

function addDigest(d: string) {
  return (_h: Record<string, unknown>, payload: Record<string, unknown>) => {
    payload._sd = [...(payload._sd as string[]), disclosureDigest(d)].sort();
  };
}

type Options = Record<string, unknown>;
const verify: unknown[] = [];

function ok(name: string, compact: string, cnf: Jwk, disclosed: Record<string, unknown>, options: Options = {}, keyBinding?: unknown) {
  verify.push({
    name,
    compact,
    options: { now: NOW, ...options },
    expect: {
      ok: true,
      disclosed,
      cnfThumbprint: jwkThumbprint(cnf),
      externalCredentialHash: externalCredentialHash(compact),
      ...(keyBinding === undefined ? {} : { keyBinding }),
    },
  });
}

function refused(name: string, compact: string, code: string, reason: string, options: Options = {}) {
  verify.push({ name, compact, options: { now: NOW, ...options }, expect: { ok: false, code, reason } });
}

const kbOptions = { keyBinding: { aud: AUD, nonce: NONCE } };
const full = issuePassport(params());
const pick = (name: string) => full.disclosures.find((d) => d.name === name)?.encoded as string;
const presentation = createKeyBindingJwt({
  sdJwt: selectDisclosures(full.compact, ['provider', 'agent']),
  holderKey: holder.privateJwk,
  aud: AUD,
  nonce: NONCE,
  iat: NOW - 10,
});

// Accepted.
ok('every claim disclosed', full.compact, holder.publicJwk, claims);
ok('agent claim only', `${full.issuerJwt}~${pick('agent')}~`, holder.publicJwk, { agent: claims.agent });
ok('no claim disclosed', `${full.issuerJwt}~`, holder.publicJwk, {});
ok(
  'disclosures in another order',
  `${full.issuerJwt}~${pick('attestation_id')}~${pick('provider')}~`,
  holder.publicJwk,
  { provider: claims.provider, attestation_id: claims.attestation_id },
);
const edIssued = issuePassport(params({ issuerKey: issuerEd.privateJwk }));
ok('EdDSA issuer with allowEdDSA', edIssued.compact, holder.publicJwk, claims, { allowEdDSA: true });
const edHolderPassport = issuePassport(params({ cnfJwk: holderEd.publicJwk }));
ok('Ed25519 cnf key without payments rails', edHolderPassport.compact, holderEd.publicJwk, claims);
ok('P-256 cnf key on payments rails', full.compact, holder.publicJwk, claims, { paymentsRails: true });
ok(
  'SD-JWT+KB presentation',
  presentation,
  holder.publicJwk,
  { provider: claims.provider, agent: claims.agent },
  kbOptions,
  { aud: AUD, nonce: NONCE, iat: NOW - 10 },
);
ok('expired one second ago, within clock skew', full.compact, holder.publicJwk, claims, { now: EXP + 1, clockSkewSeconds: 5 });
{
  const nested = encodeDisclosure('bmVzdGVkc2FsdG5lc3RlZA', 'name', 'Provider Example Ltd');
  const element = encodeDisclosure('ZWxlbWVudHNhbHRlbGVtZQ', undefined, 'shopping');
  const provider = encodeDisclosure('cHJvdmlkZXJzYWx0cHJvdg', 'provider', {
    did: 'did:web:provider.example',
    legal_identifiers: [],
    _sd: [disclosureDigest(nested)],
  });
  const agent = encodeDisclosure('YWdlbnRzYWx0YWdlbnRzYQ', 'agent', {
    software_name: 'Nimbus Shopper',
    software_version: '2.4',
    categories: [{ '...': disclosureDigest(element) }, 'travel'],
  });
  const compact = resign(`${full.issuerJwt}~${provider}~${nested}~${agent}~${element}~`, (_h, payload) => {
    payload._sd = [disclosureDigest(provider), disclosureDigest(agent)].sort();
  });
  ok('nested and array element disclosures (RFC 9901 section 7.1)', compact, holder.publicJwk, {
    provider: { did: 'did:web:provider.example', legal_identifiers: [], name: 'Provider Example Ltd' },
    agent: { software_name: 'Nimbus Shopper', software_version: '2.4', categories: ['shopping', 'travel'] },
  });
  ok(
    'array element withheld',
    compact.replace(`${element}~`, ''),
    holder.publicJwk,
    {
      provider: { did: 'did:web:provider.example', legal_identifiers: [], name: 'Provider Example Ltd' },
      agent: { software_name: 'Nimbus Shopper', software_version: '2.4', categories: ['travel'] },
    },
  );
}

{
  // A member named __proto__ is data, not the object's prototype, in both libraries.
  const agent = JSON.parse(
    '{"software_name":"Nimbus Shopper","software_version":"2.4","__proto__":{"software_version":"9.9"}}',
  ) as Record<string, unknown>;
  const d = encodeDisclosure('cHJvdG9zYWx0cHJvdG9zYQ', 'agent', agent);
  ok('claim member named __proto__', resign(`${full.issuerJwt}~${d}~`, (_h, p) => (p._sd = [disclosureDigest(d)])), holder.publicJwk, {
    agent,
  });
}

// Refused: framing and header.
refused('no tilde', full.issuerJwt, 'passport_malformed', 'not_sd_jwt');
refused('empty disclosure', `${full.issuerJwt}~~`, 'passport_malformed', 'not_sd_jwt');
refused('issuer JWT not a JWS', 'not-a-jws~', 'passport_malformed', 'bad_encoding');
refused('typ vc+sd-jwt', resign(full.compact, (h) => (h.typ = 'vc+sd-jwt')), 'passport_malformed', 'wrong_typ');
refused('typ JWT', resign(full.compact, (h) => (h.typ = 'JWT')), 'passport_malformed', 'wrong_typ');
{
  const { payload } = decodeJwsUnverified(full.issuerJwt);
  const none = [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'dc+sd-jwt' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    '',
  ].join('.');
  refused('alg none', `${none}~`, 'passport_malformed', 'alg_not_allowed');
}
refused('alg HS256', resign(full.compact, (h) => (h.alg = 'HS256')), 'passport_malformed', 'alg_not_allowed');
refused('EdDSA issuer without allowEdDSA', edIssued.compact, 'passport_not_accepted', 'eddsa_not_enabled');
refused(
  'issuer key URL in the header (jku)',
  resign(full.compact, (h) => (h.jku = 'https://keys.example/jwks.json')),
  'passport_malformed',
  'header_key_not_allowed',
);
refused(
  'issuer key in the header (jwk)',
  resign(full.compact, (h) => (h.jwk = issuerEs.publicJwk)),
  'passport_malformed',
  'header_key_not_allowed',
);
refused('crit header', resign(full.compact, (h) => (h.crit = ['exp'])), 'passport_malformed', 'crit_not_supported');

// Refused: signature and keys.
refused('signed by another key with the same kid', resign(full.compact, () => {}, stranger.privateJwk), 'passport_invalid_signature', 'signature_mismatch');
refused('unknown kid', resign(full.compact, (h) => (h.kid = 'retired-key')), 'passport_invalid_signature', 'issuer_key_not_found');
refused(
  'unknown issuer',
  resign(full.compact, (_h, p) => (p.iss = 'https://issuer.example')),
  'passport_invalid_signature',
  'issuer_key_not_found',
);

// Refused: registered claims and time.
refused('wrong vct', issuePassport(params({ vct: 'urn:example:other:1' })).compact, 'passport_not_accepted', 'wrong_vct');
refused('sub not a DID', resign(full.compact, (_h, p) => (p.sub = 'shopper-01')), 'passport_malformed', 'bad_claim');
refused('status missing', resign(full.compact, (_h, p) => delete p.status), 'passport_malformed', 'bad_claim');
refused('_sd_alg sha-512', resign(full.compact, (_h, p) => (p._sd_alg = 'sha-512')), 'passport_malformed', 'sd_alg_not_supported');
refused('expired', full.compact, 'passport_expired', 'expired', { now: EXP });
refused('not yet valid', full.compact, 'passport_expired', 'not_yet_valid', { now: IAT - 1 });
refused(
  'exp more than one year after iat',
  resign(full.compact, (_h, p) => (p.exp = IAT + 365 * 86_400 + 1)),
  'passport_not_accepted',
  'lifetime_exceeds_one_year',
);

// Refused: cnf.
refused('cnf missing', resign(full.compact, (_h, p) => delete p.cnf), 'passport_malformed', 'cnf_missing');
refused(
  'cnf with a private member',
  // A synthetic placeholder, not key material: the rule refuses any private member.
  resign(full.compact, (_h, p) => (p.cnf = { jwk: { ...holder.publicJwk, d: 'synthetic-placeholder-not-a-key' } })),
  'passport_malformed',
  'cnf_private_key',
);
refused(
  'cnf RSA key',
  resign(full.compact, (_h, p) => (p.cnf = { jwk: { kty: 'RSA', n: 'AQAB', e: 'AQAB' } })),
  'passport_malformed',
  'cnf_unsupported_key',
);
refused('Ed25519 cnf key on payments rails', edHolderPassport.compact, 'passport_not_accepted', 'cnf_not_p256', {
  paymentsRails: true,
});

// Refused: disclosures.
{
  const stray = encodeDisclosure('c2FsdHNhbHRzYWx0c2FsdA', 'attestation_id', 'att_forged');
  refused('disclosure not in _sd', `${full.compact}${stray}~`, 'passport_malformed', 'disclosure_not_referenced');
  refused('duplicate disclosure', `${full.compact}${pick('agent')}~`, 'passport_malformed', 'duplicate_disclosure');
  refused(
    'duplicate digest',
    resign(full.compact, (_h, p) => (p._sd = [...(p._sd as string[]), (p._sd as string[])[0]])),
    'passport_malformed',
    'duplicate_digest',
  );
  const cnfDisclosure = encodeDisclosure('c2FsdHNhbHRzYWx0c2FsdA', 'cnf', { jwk: holderEd.publicJwk });
  refused(
    'cnf as a disclosure',
    resign(`${full.issuerJwt}~${cnfDisclosure}~`, addDigest(cnfDisclosure)),
    'passport_malformed',
    'disclosure_name_not_allowed',
  );
  const clash = encodeDisclosure('c2FsdHNhbHRzYWx0c2FsdA', 'attestation_id', 'att_2');
  refused(
    'disclosure repeats a clear claim',
    resign(`${full.issuerJwt}~${clash}~`, (h, p) => {
      p.attestation_id = 'att_1';
      addDigest(clash)(h, p);
    }),
    'passport_malformed',
    'claim_name_conflict',
  );
  const notJson = Buffer.from('not json').toString('base64url');
  refused(
    'disclosure not JSON',
    resign(`${full.issuerJwt}~${notJson}~`, addDigest(notJson)),
    'passport_malformed',
    'disclosure_malformed',
  );
  const badShape = issuePassport(params({ claims: { ...structuredClone(claims), agent: { software_name: 'Nimbus Shopper' } as never } }));
  refused('agent claim without software_version', badShape.compact, 'passport_malformed', 'bad_claim');
}

// Refused: key binding.
refused('KB-JWT present but not requested', presentation, 'passport_malformed', 'unexpected_key_binding');
refused('KB-JWT required but absent', full.compact, 'key_unproven', 'key_binding_missing', kbOptions);
refused('KB-JWT for another audience', presentation, 'audience_mismatch', 'audience_mismatch', {
  keyBinding: { aud: 'https://other.example', nonce: NONCE },
});
refused('KB-JWT with another nonce', presentation, 'key_unproven', 'nonce_mismatch', {
  keyBinding: { aud: AUD, nonce: 'other-nonce' },
});
refused('KB-JWT too old', presentation, 'key_unproven', 'kb_stale', { now: NOW + 301, keyBinding: { aud: AUD, nonce: NONCE } });
refused('KB-JWT older than maxAgeSeconds', presentation, 'key_unproven', 'kb_stale', {
  keyBinding: { aud: AUD, nonce: NONCE, maxAgeSeconds: 5 },
});
{
  const parts = presentation.split('~');
  refused(
    'disclosure removed after the KB-JWT',
    [parts[0], parts[2], parts[3]].join('~'),
    'key_binding_mismatch',
    'sd_hash_mismatch',
    kbOptions,
  );
  const otherHolder = keyPair('ec');
  const wrongKey = createKeyBindingJwt({
    sdJwt: selectDisclosures(full.compact, ['agent']),
    holderKey: otherHolder.privateJwk,
    aud: AUD,
    nonce: NONCE,
    iat: NOW,
  });
  refused('KB-JWT signed by a key other than cnf', wrongKey, 'key_binding_mismatch', 'kb_signature_mismatch', kbOptions);
  const sdJwt = selectDisclosures(full.compact, ['agent']);
  const badTyp = signJws({ alg: 'ES256', typ: 'JWT' }, { iat: NOW, aud: AUD, nonce: NONCE, sd_hash: 'x' }, holder.privateJwk);
  refused('KB-JWT typ JWT', `${sdJwt}${badTyp}`, 'key_unproven', 'kb_malformed', kbOptions);
}

// Hash rule: every presentation of one passport has the hash of its issuer-signed JWT.
const hashOfFull = externalCredentialHash(full.compact);
const hash = [
  { name: 'all disclosures', input: full.compact, hash: hashOfFull },
  { name: 'no disclosures', input: `${full.issuerJwt}~`, hash: hashOfFull },
  { name: 'reordered disclosures', input: `${full.issuerJwt}~${[...full.disclosures].reverse().map((d) => `${d.encoded}~`).join('')}`, hash: hashOfFull },
  { name: 'SD-JWT+KB presentation', input: presentation, hash: hashOfFull },
  { name: 'another passport with the same claims', input: edHolderPassport.compact, hash: externalCredentialHash(edHolderPassport.compact) },
];

const rsaExample: Jwk = {
  kty: 'RSA',
  n: '0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw',
  e: 'AQAB',
  alg: 'RS256',
  kid: '2011-04-29',
};
const okpExample: Jwk = { kty: 'OKP', crv: 'Ed25519', x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo' };
const thumbprints = [
  { name: 'RFC 7638 section 3.1 RSA example', jwk: rsaExample, thumbprint: 'NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs' },
  { name: 'RFC 8037 appendix A.3 Ed25519 example', jwk: okpExample, thumbprint: 'kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k' },
  { name: 'P-256 holder key', jwk: holder.publicJwk, thumbprint: jwkThumbprint(holder.publicJwk) },
  { name: 'P-256 issuer key with kid', jwk: issuerEs.publicJwk, thumbprint: jwkThumbprint(issuerEs.publicJwk) },
];
for (const t of thumbprints) {
  if (jwkThumbprint(t.jwk) !== t.thumbprint) throw new Error(`thumbprint mismatch: ${t.name}`);
}
const decorated: Jwk = { alg: 'ES256', use: 'sig', kid: 'holder-1', y: holder.publicJwk.y as string, x: holder.publicJwk.x as string, crv: 'P-256', kty: 'EC' };
const keysEqual = [
  { name: 'same key with kid, alg, use and another member order', a: holder.publicJwk, b: decorated, equal: true },
  { name: 'different P-256 keys', a: holder.publicJwk, b: issuerEs.publicJwk, equal: false },
  { name: 'P-256 key and Ed25519 key', a: holder.publicJwk, b: holderEd.publicJwk, equal: false },
];

// Status (draft-ietf-oauth-status-list section 7.1). The verify vectors are
// checked with a status resolver that answers from statusLists; each status
// vector re-checks an accepted verify vector with a resolver that answers from
// its own lists. An entry that is not there makes the resolver fail.
const STATUS_URI = 'https://mock-issuer.example/status/1';
const statusLists = { [STATUS_URI]: { '42': 'valid' } };
const statusCase = (name: string, vector: string, value: string | undefined, expect: Record<string, unknown>) => ({
  name,
  vector,
  statusLists: value === undefined ? {} : { [STATUS_URI]: { '42': value } },
  expect,
});
const status = [
  statusCase('status VALID', 'every claim disclosed', 'valid', { ok: true }),
  statusCase('status INVALID (revoked)', 'every claim disclosed', 'invalid', {
    ok: false,
    code: 'passport_revoked',
    reason: 'status_invalid',
  }),
  statusCase('status SUSPENDED', 'every claim disclosed', 'suspended', {
    ok: false,
    code: 'passport_revoked',
    reason: 'status_suspended',
  }),
  statusCase('status INVALID on an SD-JWT+KB presentation', 'SD-JWT+KB presentation', 'invalid', {
    ok: false,
    code: 'passport_revoked',
    reason: 'status_invalid',
  }),
  statusCase('status value outside section 7.1', 'every claim disclosed', 'unknown', {
    ok: false,
    code: 'status_stale',
    reason: 'status_unknown',
  }),
  statusCase('status resolver fails (no status list entry)', 'every claim disclosed', undefined, {
    ok: false,
    code: 'status_stale',
    reason: 'status_unresolved',
  }),
];

const vectors = {
  description:
    'Shared test vectors for the Agent Passport SD-JWT VC profile (spec/agent-passport-1.0.md). ' +
    'Synthetic: the keys were generated for this file and their private halves discarded; ' +
    'only public keys and signed outputs are stored. Regenerate with `npm run vectors` in packages/agent-passport.',
  profile: { typ: 'dc+sd-jwt', vct: 'urn:grantex:agent-passport:1', sdAlg: 'sha-256' },
  issuers: { [ISSUER]: [issuerEs.publicJwk, issuerEd.publicJwk] },
  statusLists,
  verify,
  status,
  hash,
  thumbprints,
  keysEqual,
};

const out = fileURLToPath(new URL('../../../spec/examples/agent-passport-vectors.json', import.meta.url));
writeFileSync(out, `${JSON.stringify(vectors, null, 2)}\n`);
console.log(`wrote ${verify.length} verify, ${status.length} status, ${hash.length} hash, ${thumbprints.length} thumbprint and ${keysEqual.length} key vectors`);
