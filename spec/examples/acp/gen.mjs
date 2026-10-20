// Regenerates merchant-signature-v1.json: ACP 2026-04-17 webhook
// `Merchant-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + raw_body)>`.
// Synthetic secret and data only. Run: node spec/examples/acp/gen.mjs
import { createHmac } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const secret = 'synthetic-acp-webhook-secret-for-tests-only';
const body = JSON.stringify({
  type: 'order_create',
  data: {
    type: 'order',
    id: 'cord_01EXAMPLE',
    checkout_session_id: 'ccart_01EXAMPLE',
    permalink_url: 'https://merchant.example/orders/cord_01EXAMPLE',
    status: 'confirmed',
    line_items: [{
      id: 'cvar_01EXAMPLE',
      title: 'Ceramic mug',
      product_id: 'cprd_01EXAMPLE',
      quantity: { ordered: 2, current: 2, fulfilled: 0 },
      unit_price: 45000,
      subtotal: 90000,
      status: 'processing',
    }],
    totals: [
      { type: 'subtotal', display_text: 'Subtotal', amount: 90000 },
      { type: 'total', display_text: 'Total', amount: 90000 },
    ],
  },
});
const t = 1792483200;
const v1 = createHmac('sha256', secret).update(`${t}.${body}`, 'utf8').digest('hex');
const header = `t=${t},v1=${v1}`;

const doc = {
  description: 'ACP 2026-04-17 Merchant-Signature vectors: v1 = hex(HMAC-SHA256(secret, t + "." + raw_body)). Synthetic secret and data; not a real credential.',
  secret,
  cases: [
    { name: 'valid', raw_body: body, t, now: t + 10, header, valid: true },
    { name: 'valid_at_tolerance_edge', raw_body: body, t, now: t + 300, header, valid: true },
    { name: 'stale', raw_body: body, t, now: t + 301, header, valid: false },
    { name: 'body_changed', raw_body: body.replace('Ceramic', 'Glass'), t, now: t + 10, header, valid: false },
    { name: 'uppercase_hex', raw_body: body, t, now: t + 10, header: `t=${t},v1=${v1.toUpperCase()}`, valid: true },
    { name: 'malformed_header', raw_body: body, t, now: t + 10, header: `v1=${v1},t=${t}`, valid: false },
    { name: 'short_mac', raw_body: body, t, now: t + 10, header: `t=${t},v1=${v1.slice(0, 63)}`, valid: false },
  ],
};

writeFileSync(join(dirname(fileURLToPath(import.meta.url)), 'merchant-signature-v1.json'), `${JSON.stringify(doc, null, 2)}\n`);
