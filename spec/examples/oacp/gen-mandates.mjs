// Generates the shared OACP mandate JWT v1 test vectors (synthetic test key only).
// Usage: node gen-mandates.mjs <path-to-canonical.ts> <out.json>
// The private key is generated per run and never written out: the vectors
// carry only the public JWKS, so regenerating changes every signature.
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [, , canonicalPath, outPath] = process.argv;
const { canonicalize } = await import(pathToFileURL(canonicalPath).href);

const b64u = (b) => Buffer.from(b).toString('base64url');
const sha64 = (s) => createHash('sha256').update(s).digest('base64url');
const shaHex = (s) => createHash('sha256').update(s).digest('hex');

const ISSUER = 'https://issuer.example';
const KID = 'oacp-test-2026-10-m';
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pub = publicKey.export({ format: 'jwk' });
const jwk = { kty: 'EC', crv: 'P-256', x: pub.x, y: pub.y, kid: KID, alg: 'ES256', use: 'sig' };
const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

const TYP = { intent: 'oacp-intent-mandate+jwt', cart: 'oacp-cart-mandate+jwt', payment: 'oacp-payment-mandate+jwt' };
const VERIFY_AT = 1792491000; // 2026-10-20T10:10:00Z
const IAT = VERIFY_AT - 60;
const EXP = IAT + 600;
const STATUS_URI = 'https://issuer.example/status/oacp/oacpl_01JTESTSTATUSLIST0000000000';

function jwt(claims, { type, key = privateKey, header } = {}) {
  const h = b64u(JSON.stringify(header ?? { alg: 'ES256', kid: KID, typ: TYP[type] }));
  const p = b64u(JSON.stringify(claims));
  const s = sign('sha256', Buffer.from(`${h}.${p}`, 'ascii'), { key, dsaEncoding: 'ieee-p1363' });
  return `${h}.${p}.${b64u(s)}`;
}

const common = (jti, idx, overrides = {}) => ({
  iss: ISSUER,
  sub: 'buyer_principal_01',
  aud: 'mch_TEST01',
  iat: IAT,
  exp: EXP,
  jti,
  mandate_version: 'oacp.mandate.v1',
  tenant_id: 'cten_TEST01',
  merchant_id: 'mch_TEST01',
  buyer_agent_id: 'cag_TEST01',
  presence: 'human_not_present',
  amr: ['consent', 'otp'],
  passport_ref: 'cpsp_01JTESTPASSPORT000000000000',
  consent_ref: 'crec_01JTESTCONSENT0000000000000',
  status: { status_list: { idx, uri: STATUS_URI } },
  ...overrides,
});

const checkout = {
  id: 'chk_TEST01',
  status: 'ready_for_complete',
  currency: 'INR',
  merchant: { id: 'mch_TEST01', name: 'Synthetic Store' },
  line_items: [
    { id: 'li_1', item: { id: 'sku_kettle', title: 'Kettle', price: 30000 }, quantity: 1, totals: [{ type: 'total', amount: 30000 }] },
    { id: 'li_2', item: { id: 'sku_mug', title: 'Mug', price: 7500 }, quantity: 2, totals: [{ type: 'total', amount: 15000 }] },
  ],
  totals: [{ type: 'subtotal', amount: 45000 }, { type: 'total', amount: 45000 }],
  links: [],
};
const checkoutCanonical = canonicalize(checkout);
const checkoutHash = sha64(checkoutCanonical);

const intentClaims = common('oacp_mnd_01JTESTINTENT00000000000000', 11, {
  intent: {
    description_hash: sha64('Buy a kettle and two mugs under 800 rupees'),
    max_amount: { value: 80000, currency: 'INR' },
    merchants: ['mch_TEST01'],
    expires_at: new Date(EXP * 1000).toISOString(),
    constraints: [
      { type: 'checkout.allowed_merchants', allowed: [{ id: 'mch_TEST01' }] },
      { type: 'payment.amount_range', currency: 'INR', max: 80000 },
    ],
  },
});
const cart = {
  checkout_hash: checkoutHash,
  checkout_id: 'chk_TEST01',
  line_items: checkout.line_items.map((item) => ({ id: item.id, quantity: item.quantity, digest: sha64(canonicalize(item)) })),
  total: { value: 45000, currency: 'INR' },
};
const cartClaims = common('oacp_mnd_01JTESTCART0000000000000000', 12, { cart, intent_mandate_jti: intentClaims.jti });
const webauthn = {
  digest: shaHex('synthetic-webauthn-evidence'),
  rp_id: 'issuer.example',
  origin: 'https://issuer.example',
  challenge: checkoutHash,
  user_verified: true,
  asserted_at: new Date(IAT * 1000).toISOString(),
  credential_ref: shaHex('synthetic-credential-id'),
};
const cartPresentClaims = common('oacp_mnd_01JTESTCARTPRESENT0000000000', 13, {
  presence: 'human_present', amr: ['consent', 'otp', 'passkey'], cart, intent_mandate_jti: intentClaims.jti, webauthn,
});
const paymentClaims = common('oacp_mnd_01JTESTPAYMENT0000000000000', 14, {
  payment: {
    transaction_id: checkoutHash,
    amount: 45000,
    currency: 'INR',
    payee: { id: 'mch_TEST01' },
    rail: 'plural',
    token_binding: { type: 'network_token', id: 'tokref_synthetic_01' },
    cart_mandate_jti: cartClaims.jti,
  },
});

const intent = jwt(intentClaims, { type: 'intent' });
const cartJwt = jwt(cartClaims, { type: 'cart' });
const payment = jwt(paymentClaims, { type: 'payment' });
const [ih, ip, is] = intent.split('.');

const cases = [
  { name: 'valid_intent', mandate: intent, expected_type: 'intent', expect: null },
  { name: 'valid_cart_human_not_present', mandate: cartJwt, expected_type: 'cart', expect: null },
  { name: 'valid_cart_human_present', mandate: jwt(cartPresentClaims, { type: 'cart' }), expected_type: 'cart', expect: null },
  { name: 'valid_payment', mandate: payment, expected_type: 'payment', expect: null },
  { name: 'two_parts', mandate: `${ih}.${ip}`, expect: 'mandate_malformed' },
  { name: 'empty_signature', mandate: `${ih}.${ip}.`, expect: 'mandate_malformed' },
  { name: 'alg_none', mandate: jwt(intentClaims, { header: { alg: 'none', kid: KID, typ: TYP.intent } }), expect: 'mandate_algorithm_unsupported' },
  { name: 'alg_hs256', mandate: jwt(intentClaims, { header: { alg: 'HS256', kid: KID, typ: TYP.intent } }), expect: 'mandate_algorithm_unsupported' },
  { name: 'extra_header_member', mandate: jwt(intentClaims, { header: { alg: 'ES256', kid: KID, typ: TYP.intent, jku: 'https://attacker.example/jwks' } }), expect: 'mandate_malformed' },
  { name: 'typ_jwt', mandate: jwt(intentClaims, { header: { alg: 'ES256', kid: KID, typ: 'JWT' } }), expect: 'mandate_type_mismatch' },
  { name: 'cart_presented_as_payment', mandate: cartJwt, expected_type: 'payment', expect: 'mandate_type_mismatch' },
  { name: 'unknown_kid', mandate: jwt(intentClaims, { header: { alg: 'ES256', kid: 'oacp-test-2026-10-z', typ: TYP.intent } }), expect: 'issuer_key_untrusted' },
  { name: 'non_oacp_kid', mandate: jwt(intentClaims, { header: { alg: 'ES256', kid: 'grantex-2026-05', typ: TYP.intent } }), expect: 'issuer_key_untrusted' },
  { name: 'signed_by_another_key', mandate: jwt(intentClaims, { type: 'intent', key: other.privateKey }), expect: 'mandate_signature_invalid' },
  { name: 'tampered_payload', mandate: `${ih}.${b64u(JSON.stringify({ ...intentClaims, intent: { ...intentClaims.intent, max_amount: { value: 8000000, currency: 'INR' } } }))}.${is}`, expect: 'mandate_signature_invalid' },
  { name: 'der_signature', mandate: (() => { const input = `${ih}.${ip}`; return `${input}.${b64u(sign('sha256', Buffer.from(input), privateKey))}`; })(), expect: 'mandate_signature_invalid' },
  { name: 'wrong_issuer', mandate: jwt({ ...intentClaims, iss: 'https://attacker.example' }, { type: 'intent' }), expect: 'mandate_issuer_mismatch' },
  { name: 'missing_consent_ref', mandate: jwt((({ consent_ref: _c, ...rest }) => rest)(intentClaims), { type: 'intent' }), expect: 'mandate_claims_invalid' },
  { name: 'aud_not_merchant', mandate: jwt({ ...intentClaims, aud: 'mch_OTHER' }, { type: 'intent' }), expect: 'mandate_claims_invalid' },
  { name: 'human_present_cart_without_passkey', mandate: jwt({ ...cartClaims, presence: 'human_present' }, { type: 'cart' }), expect: 'mandate_claims_invalid' },
  { name: 'human_present_cart_passkey_over_other_hash', mandate: jwt({ ...cartPresentClaims, webauthn: { ...webauthn, challenge: sha64('another cart') } }, { type: 'cart' }), expect: 'mandate_claims_invalid' },
  { name: 'payment_payee_not_merchant', mandate: jwt({ ...paymentClaims, payment: { ...paymentClaims.payment, payee: { id: 'mch_OTHER' } } }, { type: 'payment' }), expect: 'mandate_claims_invalid' },
  { name: 'payment_unknown_rail', mandate: jwt({ ...paymentClaims, payment: { ...paymentClaims.payment, rail: 'wire' } }, { type: 'payment' }), expect: 'mandate_claims_invalid' },
  { name: 'not_yet_valid', mandate: jwt({ ...intentClaims, iat: VERIFY_AT + 120, exp: VERIFY_AT + 600 }, { type: 'intent' }), expect: 'mandate_not_yet_valid' },
  { name: 'expired', mandate: jwt({ ...intentClaims, iat: VERIFY_AT - 700, exp: VERIFY_AT - 100 }, { type: 'intent' }), expect: 'mandate_expired' },
  { name: 'lifetime_exceeded', mandate: jwt({ ...intentClaims, exp: IAT + 3600 }, { type: 'intent' }), expect: 'mandate_lifetime_exceeded' },
  { name: 'audience_mismatch', mandate: intent, expected_audience: 'mch_OTHER', expect: 'mandate_audience_mismatch' },
  { name: 'revoked', mandate: intent, status: 1, expect: 'mandate_revoked' },
  { name: 'suspended', mandate: intent, status: 2, expect: 'mandate_suspended' },
  { name: 'status_unavailable', mandate: intent, status: 'unavailable', expect: 'revocation_status_unavailable' },
  { name: 'http_status_list', mandate: jwt(common('oacp_mnd_01JTESTHTTP000000000000000', 15, { intent: intentClaims.intent, status: { status_list: { idx: 15, uri: 'http://issuer.example/status/oacp/x' } } }), { type: 'intent' }), expect: 'revocation_status_unavailable' },
];

const chains = [
  { name: 'valid_chain', intent, cart: cartJwt, payment, expect: null },
  { name: 'payment_for_another_cart', intent, cart: cartJwt, payment: jwt({ ...paymentClaims, payment: { ...paymentClaims.payment, transaction_id: sha64('another cart') } }, { type: 'payment' }), expect: 'mandate_chain_mismatch' },
  { name: 'payment_amount_differs', intent, cart: cartJwt, payment: jwt({ ...paymentClaims, payment: { ...paymentClaims.payment, amount: 44999 } }, { type: 'payment' }), expect: 'mandate_chain_mismatch' },
  { name: 'cart_above_intent_cap', intent: jwt({ ...intentClaims, intent: { ...intentClaims.intent, max_amount: { value: 40000, currency: 'INR' } } }, { type: 'intent' }), cart: cartJwt, expect: 'mandate_chain_mismatch' },
  { name: 'cart_under_another_consent', intent, cart: jwt({ ...cartClaims, consent_ref: 'crec_01JTESTOTHERCONSENT000000000' }, { type: 'cart' }), expect: 'mandate_chain_mismatch' },
];

const out = {
  profile: 'OACP mandate JWT v1 (ES256, typ oacp-intent|cart|payment-mandate+jwt)',
  note: 'Synthetic test vectors. The signing key was generated for this file and discarded; only the public JWK is included. Verify each case at verify_at against jwks with issuer; status is the Token Status List value the relying party read (default 0, VALID). Chains: verify each mandate (all valid), then check the chain.',
  issuer: ISSUER,
  verify_at: VERIFY_AT,
  expected_audience: 'mch_TEST01',
  jwks: { keys: [jwk] },
  checkout,
  checkout_canonical: checkoutCanonical,
  checkout_hash: checkoutHash,
  cases,
  chains,
};
writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${cases.length} cases and ${chains.length} chains to ${outPath}`);
