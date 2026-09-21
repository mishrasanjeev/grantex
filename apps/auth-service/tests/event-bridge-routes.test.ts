import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey } from 'jose';
import { buildTestApp, authHeader, sqlMock, TEST_DEVELOPER } from './helpers.js';
import { encryptWithContext } from '../src/lib/vault-crypto.js';
import { computeWebhookSignature } from '../src/lib/event-bridge/webhook-verify.js';
import {
  eventBridgeVerificationFailuresTotal,
  eventBridgeEventsVerifiedTotal,
} from '../src/lib/event-bridge/metrics.js';
import type { EventSourceRow } from '../src/lib/event-bridge/sources.js';

let app: FastifyInstance;

const WEBHOOK_ID = 'evsrc_01K5AAAAAAAAAAAAAAAAAAAAAA';
const SSF_ID = 'evsrc_01K5BBBBBBBBBBBBBBBBBBBBBB';
const SECRET = 'gxevs_placeholder_route_test_secret';
const ISSUER = 'https://transmitter.example.com';
const AUDIENCE = `https://grantex.dev/v1/event-bridge/ssf/${SSF_ID}`;
const EVENT = 'https://schemas.openid.net/secevent/caep/event-type/session-revoked';

function webhookRow(overrides: Partial<EventSourceRow> = {}): EventSourceRow {
  return {
    id: WEBHOOK_ID, developer_id: TEST_DEVELOPER.id, kind: 'webhook', name: 'provider events', status: 'active',
    issuer: null, audience: null, jwks_uri: null, jwks: null, algorithms: ['RS256', 'ES256'], max_age_seconds: 300,
    encrypted_secret: encryptWithContext(SECRET, `event-bridge-source:${WEBHOOK_ID}`),
    encrypted_previous_secret: null, previous_secret_expires_at: null, secret_rotated_at: new Date(),
    tolerance_seconds: 300, created_at: new Date(), updated_at: new Date(),
    ...overrides,
  };
}

let ssfKey: CryptoKey;
let ssfRow: EventSourceRow;

interface SqlState {
  source: EventSourceRow | null;
  receiptInsert: boolean;
  existingHash: string | null;
  statements: string[];
}

let state: SqlState;

function installSql(): void {
  sqlMock.mockImplementation(async (strings: TemplateStringsArray | string, ..._values: unknown[]) => {
    const text = Array.isArray(strings) ? strings.join('?') : String(strings);
    state.statements.push(text.replace(/\s+/g, ' ').trim());
    if (text.includes('FROM developers d')) return [TEST_DEVELOPER];
    if (text.includes('FROM event_bridge_sources WHERE id =')) return state.source ? [state.source] : [];
    if (text.includes('INSERT INTO event_bridge_receipts')) return state.receiptInsert ? [{ event_id: 'x' }] : [];
    if (text.includes("SET status = 'processing'")) return [];
    if (text.includes('SELECT body_sha256')) return state.existingHash ? [{ body_sha256: state.existingHash }] : [];
    return [];
  });
}

function signedWebhook(body: Record<string, unknown>, secret = SECRET, timestamp = Math.floor(Date.now() / 1000)) {
  const payload = JSON.stringify(body);
  return {
    payload,
    headers: {
      'content-type': 'application/json',
      'x-grantex-timestamp': String(timestamp),
      'x-grantex-signature': computeWebhookSignature(secret, String(timestamp), Buffer.from(payload)),
    },
  };
}

async function signedSet(claims: Record<string, unknown> = {}, key: CryptoKey = ssfKey): Promise<string> {
  return new SignJWT({
    iss: ISSUER, aud: AUDIENCE, iat: Math.floor(Date.now() / 1000), jti: 'set-route-1',
    sub_id: { format: 'opaque', id: 'business:00000001' }, events: { [EVENT]: {} }, ...claims,
  }).setProtectedHeader({ alg: 'ES256', typ: 'secevent+jwt', kid: 'k1' }).sign(key);
}

beforeAll(async () => {
  app = await buildTestApp();
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  ssfKey = privateKey as CryptoKey;
  ssfRow = webhookRow({
    id: SSF_ID, kind: 'ssf', issuer: ISSUER, audience: AUDIENCE, encrypted_secret: null,
    jwks: { keys: [{ ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256' }] },
  });
});

beforeEach(() => {
  state = { source: webhookRow(), receiptInsert: true, existingHash: null, statements: [] };
  installSql();
  vi.mocked(eventBridgeVerificationFailuresTotal.inc).mockClear();
  vi.mocked(eventBridgeEventsVerifiedTotal.inc).mockClear();
  vi.stubEnv('EVENT_BRIDGE_ENABLED', 'true');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const webhookEvent = { id: 'evt_route_1', type: 'business.dissolved', subject: { business_ref: 'gb:00000001' } };

describe('event bridge flag', () => {
  it('hides ingestion (404) and refuses registration (403) when EVENT_BRIDGE_ENABLED is not true', async () => {
    vi.stubEnv('EVENT_BRIDGE_ENABLED', 'false');
    const delivery = signedWebhook(webhookEvent);
    const ingest = await app.inject({ method: 'POST', url: `/v1/event-bridge/webhooks/${WEBHOOK_ID}`, ...delivery });
    expect(ingest.statusCode).toBe(404);
    expect(state.statements).toEqual([]);

    const list = await app.inject({ method: 'GET', url: '/v1/event-sources', headers: authHeader() });
    expect(list.statusCode).toBe(403);
    expect(list.json()).toMatchObject({ code: 'FEATURE_DISABLED' });
  });

  it('treats a developer outside EVENT_BRIDGE_DEVELOPER_IDS as not enabled', async () => {
    vi.stubEnv('EVENT_BRIDGE_DEVELOPER_IDS', 'dev_SOMEONE_ELSE');
    const delivery = signedWebhook(webhookEvent);
    const res = await app.inject({ method: 'POST', url: `/v1/event-bridge/webhooks/${WEBHOOK_ID}`, ...delivery });
    expect(res.statusCode).toBe(404);
    expect(state.statements.some((s) => s.includes('event_bridge_receipts'))).toBe(false);
  });
});

describe('POST /v1/event-bridge/webhooks/:sourceId', () => {
  it('accepts a correctly signed event, records the receipt, and ignores it as unmapped', async () => {
    const delivery = signedWebhook(webhookEvent);
    const res = await app.inject({ method: 'POST', url: `/v1/event-bridge/webhooks/${WEBHOOK_ID}`, ...delivery });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ status: 'unmapped' });
    expect(eventBridgeEventsVerifiedTotal.inc).toHaveBeenCalledWith({ source_type: 'webhook' });
    expect(state.statements.some((s) => s.includes('INSERT INTO event_bridge_receipts'))).toBe(true);
    expect(state.statements.some((s) => s.includes('processed_at = NOW()'))).toBe(true);
  });

  it('refuses a forged webhook with 401, counts it, and never touches the replay store', async () => {
    const delivery = signedWebhook(webhookEvent, 'gxevs_attacker_guess');
    const res = await app.inject({ method: 'POST', url: `/v1/event-bridge/webhooks/${WEBHOOK_ID}`, ...delivery });
    expect(res.statusCode).toBe(401);
    // One opaque code for the sender; the reason is in the counter and the log.
    expect(res.json()).toMatchObject({ err: 'unverifiable', code: 'EVENT_UNVERIFIABLE' });
    expect(eventBridgeVerificationFailuresTotal.inc).toHaveBeenCalledWith({ source_type: 'webhook', reason: 'signature_invalid' });
    expect(state.statements.some((s) => s.includes('event_bridge_receipts'))).toBe(false);
  });

  it('refuses a replayed delivery outside the window with 401', async () => {
    const delivery = signedWebhook(webhookEvent, SECRET, Math.floor(Date.now() / 1000) - 3_600);
    const res = await app.inject({ method: 'POST', url: `/v1/event-bridge/webhooks/${WEBHOOK_ID}`, ...delivery });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ err: 'unverifiable' });
    expect(eventBridgeVerificationFailuresTotal.inc)
      .toHaveBeenCalledWith({ source_type: 'webhook', reason: 'timestamp_out_of_window' });
  });

  it('does not act again on a replayed delivery inside the window (duplicate)', async () => {
    const delivery = signedWebhook(webhookEvent);
    const { createHash } = await import('node:crypto');
    state.receiptInsert = false;
    state.existingHash = createHash('sha256').update(delivery.payload).digest('hex');
    const res = await app.inject({ method: 'POST', url: `/v1/event-bridge/webhooks/${WEBHOOK_ID}`, ...delivery });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ status: 'duplicate' });
    expect(state.statements.some((s) => s.includes('SET status =') && s.includes('processed_at = NOW()'))).toBe(false);
  });

  it('refuses a different payload that reuses an event id', async () => {
    state.receiptInsert = false;
    state.existingHash = 'f'.repeat(64);
    const res = await app.inject({ method: 'POST', url: `/v1/event-bridge/webhooks/${WEBHOOK_ID}`, ...signedWebhook(webhookEvent) });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ err: 'unverifiable' });
    expect(eventBridgeVerificationFailuresTotal.inc)
      .toHaveBeenCalledWith({ source_type: 'webhook', reason: 'event_id_reused' });
  });

  it('refuses unknown and disabled sources with 401 and a wrong media type with 415', async () => {
    state.source = null;
    const unknown = await app.inject({ method: 'POST', url: `/v1/event-bridge/webhooks/${WEBHOOK_ID}`, ...signedWebhook(webhookEvent) });
    expect(unknown.statusCode).toBe(401);

    state.source = webhookRow({ status: 'disabled' });
    const disabled = await app.inject({ method: 'POST', url: `/v1/event-bridge/webhooks/${WEBHOOK_ID}`, ...signedWebhook(webhookEvent) });
    expect(disabled.statusCode).toBe(401);

    // An unknown source and a disabled one are indistinguishable to the
    // sender: the endpoint is not an oracle for which source ids exist.
    expect(unknown.json()).toEqual({ ...disabled.json(), requestId: unknown.json<{ requestId: string }>().requestId });
    expect(eventBridgeVerificationFailuresTotal.inc)
      .toHaveBeenCalledWith({ source_type: 'webhook', reason: 'source_unknown' });
    expect(eventBridgeVerificationFailuresTotal.inc)
      .toHaveBeenCalledWith({ source_type: 'webhook', reason: 'source_disabled' });

    state.source = webhookRow();
    const delivery = signedWebhook(webhookEvent);
    const media = await app.inject({
      method: 'POST', url: `/v1/event-bridge/webhooks/${WEBHOOK_ID}`,
      payload: delivery.payload, headers: { ...delivery.headers, 'content-type': 'text/plain' },
    });
    expect(media.statusCode).toBe(415);
  });

  it('refuses a webhook delivered to an SSF source id', async () => {
    state.source = ssfRow;
    const res = await app.inject({ method: 'POST', url: `/v1/event-bridge/webhooks/${SSF_ID}`, ...signedWebhook(webhookEvent) });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ err: 'unverifiable' });
  });

  it('answers 5xx and leaves a failed receipt when processing throws, so a retransmission is retried', async () => {
    // Finalising the receipt fails after the insert: the sender sees a 5xx and retries.
    sqlMock.mockImplementation(async (strings: TemplateStringsArray | string) => {
      const text = Array.isArray(strings) ? strings.join('?') : String(strings);
      if (text.includes('FROM event_bridge_sources WHERE id =')) return [webhookRow()];
      if (text.includes('INSERT INTO event_bridge_receipts')) return [{ event_id: 'x' }];
      if (text.includes('processed_at = NOW()')) throw new Error('database unavailable');
      return [];
    });
    const res = await app.inject({ method: 'POST', url: `/v1/event-bridge/webhooks/${WEBHOOK_ID}`, ...signedWebhook(webhookEvent) });
    expect(res.statusCode).toBe(500);
  });
});

describe('POST /v1/event-bridge/ssf/:sourceId', () => {
  it('accepts a SET from the registered transmitter', async () => {
    state.source = ssfRow;
    const res = await app.inject({
      method: 'POST', url: `/v1/event-bridge/ssf/${SSF_ID}`,
      headers: { 'content-type': 'application/secevent+jwt' }, payload: await signedSet(),
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ status: 'unmapped' });
  });

  it('refuses a forged SET, a wrong audience and a stale SET with 401', async () => {
    state.source = ssfRow;
    const attacker = await generateKeyPair('ES256');
    const cases: Array<[string, string]> = [
      [await signedSet({}, attacker.privateKey as CryptoKey), 'signature_invalid'],
      [await signedSet({ aud: 'https://another-receiver.example.com' }), 'audience_mismatch'],
      [await signedSet({ iat: Math.floor(Date.now() / 1000) - 3_600 }), 'stale'],
    ];
    for (const [token, reason] of cases) {
      const res = await app.inject({
        method: 'POST', url: `/v1/event-bridge/ssf/${SSF_ID}`,
        headers: { 'content-type': 'application/secevent+jwt' }, payload: token,
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ err: 'unverifiable' });
      expect(eventBridgeVerificationFailuresTotal.inc).toHaveBeenCalledWith({ source_type: 'ssf', reason });
    }
    expect(state.statements.some((s) => s.includes('event_bridge_receipts'))).toBe(false);
  });
});

describe('/v1/event-sources', () => {
  it('registers a webhook source, returns the secret once and stores it encrypted', async () => {
    let insertValues: unknown[] = [];
    sqlMock.mockImplementation(async (strings: TemplateStringsArray | string, ...values: unknown[]) => {
      const text = Array.isArray(strings) ? strings.join('?') : String(strings);
      if (text.includes('FROM developers d')) return [TEST_DEVELOPER];
      if (text.includes('INSERT INTO event_bridge_sources')) {
        insertValues = values;
        return [webhookRow({ id: values[0] as string, encrypted_secret: values[3] as string })];
      }
      return [];
    });
    const res = await app.inject({
      method: 'POST', url: '/v1/event-sources', headers: authHeader(),
      payload: { kind: 'webhook', name: 'provider events' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<Record<string, unknown>>();
    expect(body['secret']).toMatch(/^gxevs_/);
    expect(body['ingestUrl']).toMatch(/\/v1\/event-bridge\/webhooks\/evsrc_/);
    expect(JSON.stringify(insertValues)).not.toContain(body['secret'] as string);
    expect(insertValues[3]).toMatch(/^ctx1:/);
    expect(body).not.toHaveProperty('encrypted_secret');
  });

  it('rejects unknown fields, private keys and an SSF source without keys', async () => {
    const { privateKey } = await generateKeyPair('ES256', { extractable: true });
    const privateJwk = await exportJWK(privateKey);
    for (const payload of [
      { kind: 'webhook', name: 'x', secret: 'chosen-by-caller' },
      { kind: 'ssf', name: 'x', issuer: ISSUER, jwks: { keys: [privateJwk] } },
      { kind: 'ssf', name: 'x', issuer: ISSUER },
      { kind: 'ssf', name: 'x', issuer: ISSUER, jwksUri: 'ftp://keys.example.com/jwks' },
      { kind: 'other', name: 'x' },
    ]) {
      const res = await app.inject({ method: 'POST', url: '/v1/event-sources', headers: authHeader(), payload });
      expect(res.statusCode).toBe(422);
    }
  });
});

describe('ingestion rate limiting', () => {
  it('is keyed on the client address, so varying the source id mints no new budget', async () => {
    vi.stubEnv('EVENT_BRIDGE_RATE_LIMIT_PER_MINUTE', '2');
    const limited = await buildTestApp();
    try {
      const responses: number[] = [];
      for (const suffix of ['AAAA', 'BBBB', 'CCCC']) {
        const id = `evsrc_01K5${suffix}AAAAAAAAAAAAAAAAAA`.slice(0, 32);
        const res = await limited.inject({
          method: 'POST', url: `/v1/event-bridge/webhooks/${id}`, ...signedWebhook(webhookEvent),
        });
        responses.push(res.statusCode);
      }
      // Three deliveries from one address, three different source ids: the
      // third is refused rather than getting a bucket of its own.
      expect(responses[2]).toBe(429);
    } finally {
      await limited.close();
    }
  });
});
