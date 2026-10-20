// Generates additional OACP mandate JWT v1 test vectors (synthetic test key only):
// cases added after oacp-mandates-v1.json was published, in a file of their own so
// the first file (and its secret-scan baseline) stays byte-identical.
// Usage: node gen-mandates-extra.mjs <out.json>
// The private key is generated per run and never written out.
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const [, , outPath] = process.argv;
const b64u = (b) => Buffer.from(b).toString('base64url');
const sha64 = (s) => createHash('sha256').update(s).digest('base64url');

const ISSUER = 'https://issuer.example';
const KID = 'oacp-test-2026-10-n';
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pub = publicKey.export({ format: 'jwk' });
const jwk = { kty: 'EC', crv: 'P-256', x: pub.x, y: pub.y, kid: KID, alg: 'ES256', use: 'sig' };
const VERIFY_AT = 1792491000; // 2026-10-20T10:10:00Z
const IAT = VERIFY_AT - 60;
const EXP = IAT + 600;

// Header and claims are given as JSON text, so a member name can repeat.
function jwtFromText(headerText, claimsText) {
  const input = `${b64u(headerText)}.${b64u(claimsText)}`;
  const s = sign('sha256', Buffer.from(input, 'ascii'), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${input}.${b64u(s)}`;
}

const claims = {
  iss: ISSUER,
  sub: 'buyer_principal_01',
  aud: 'mch_TEST01',
  iat: IAT,
  exp: EXP,
  jti: 'oacp_mnd_01JTESTEXTRAINTENT000000000',
  mandate_version: 'oacp.mandate.v1',
  tenant_id: 'cten_TEST01',
  merchant_id: 'mch_TEST01',
  buyer_agent_id: 'cag_TEST01',
  presence: 'human_not_present',
  amr: ['consent', 'otp'],
  passport_ref: 'cpsp_01JTESTPASSPORT000000000000',
  consent_ref: 'crec_01JTESTCONSENT0000000000000',
  status: { status_list: { idx: 21, uri: 'https://issuer.example/status/oacp/oacpl_01JTESTSTATUSLIST0000000000' } },
  intent: {
    description_hash: sha64('Buy a kettle under 800 rupees'),
    max_amount: { value: 80000, currency: 'INR' },
    merchants: ['mch_TEST01'],
    expires_at: new Date(EXP * 1000).toISOString(),
    constraints: [{ type: 'payment.amount_range', currency: 'INR', max: 80000 }],
  },
};
const header = { alg: 'ES256', kid: KID, typ: 'oacp-intent-mandate+jwt' };
const headerText = JSON.stringify(header);
const claimsText = JSON.stringify(claims);

const cases = [
  { name: 'valid_intent', mandate: jwtFromText(headerText, claimsText), expected_type: 'intent', expect: null },
  {
    name: 'duplicate_header_member',
    // `typ` twice: a parser keeping the last value would read a cart mandate.
    mandate: jwtFromText(`{"alg":"ES256","kid":"${KID}","typ":"oacp-intent-mandate+jwt","typ":"oacp-cart-mandate+jwt"}`, claimsText),
    expect: 'mandate_malformed',
  },
  {
    name: 'duplicate_claim_member',
    // `aud` twice, validly signed: refused before any claim is read.
    mandate: jwtFromText(headerText, claimsText.replace('"aud":"mch_TEST01"', '"aud":"mch_OTHER","aud":"mch_TEST01"')),
    expect: 'mandate_malformed',
  },
  {
    name: 'duplicate_nested_member',
    mandate: jwtFromText(headerText, claimsText.replace('"max_amount":{"value":80000', '"max_amount":{"value":8000000,"value":80000')),
    expect: 'mandate_malformed',
  },
];

const out = {
  profile: 'OACP mandate JWT v1 (ES256, typ oacp-intent|cart|payment-mandate+jwt): additional cases',
  note: 'Synthetic test vectors, same format and rules as oacp-mandates-v1.json. The signing key was generated for this file and discarded; only the public JWK is included. A JSON object that repeats a member name, in the header or the claims at any depth, is refused as mandate_malformed.',
  issuer: ISSUER,
  verify_at: VERIFY_AT,
  expected_audience: 'mch_TEST01',
  jwks: { keys: [jwk] },
  cases,
  chains: [],
};
writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${cases.length} cases to ${outPath}`);
