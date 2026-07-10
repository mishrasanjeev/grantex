import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { getSql, type TxSql } from '../db/client.js';
import { newWebhookId } from '../lib/ids.js';
import { isPlanName, PLAN_LIMITS } from '../lib/plans.js';
import { config } from '../config.js';
import { validateOutboundUrl } from '../lib/url-security.js';

const VALID_EVENTS = new Set(['grant.created', 'grant.revoked', 'token.issued']);
const VALID_DELIVERY_STATUSES = new Set(['pending', 'delivered', 'failed']);

interface CreateWebhookBody {
  url: string;
  events: string[];
}

export async function webhooksRoutes(app: FastifyInstance): Promise<void> {
  // POST /v1/webhooks
  app.post<{ Body: CreateWebhookBody }>('/v1/webhooks', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const body = request.body as unknown;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return reply.status(400).send({
        message: 'url and events are required',
        code: 'BAD_REQUEST',
        requestId: request.id,
      });
    }
    const { url, events } = body as Partial<CreateWebhookBody>;

    if (typeof url !== 'string' || url.length === 0 ||
        !Array.isArray(events) || events.length === 0 ||
        events.some(event => typeof event !== 'string')) {
      return reply.status(400).send({
        message: 'url and events are required',
        code: 'BAD_REQUEST',
        requestId: request.id,
      });
    }
    try {
      validateOutboundUrl(url, {
        allowedProtocols: ['https:', 'http:'],
        allowInsecureHttp: config.allowInsecureWebhookUrls,
        allowPrivateHosts: config.allowPrivateWebhookHosts,
      });
    } catch (err) {
      return reply.status(400).send({
        message: `Invalid webhook URL: ${err instanceof Error ? err.message : 'invalid URL'}`,
        code: 'BAD_REQUEST',
        requestId: request.id,
      });
    }

    const invalid = events.filter(e => !VALID_EVENTS.has(e));
    if (invalid.length > 0) {
      return reply.status(400).send({
        message: `Invalid event types: ${invalid.join(', ')}. Valid: grant.created, grant.revoked, token.issued`,
        code: 'BAD_REQUEST',
        requestId: request.id,
      });
    }

    const developerId = request.developer.id;
    const sql = getSql();

    const id = newWebhookId();
    const secret = randomBytes(24).toString('hex');
    let limitExceeded: { plan: string; limit: number } | undefined;

    // Serialize the count-and-insert sequence per developer. Without a lock,
    // concurrent registrations can both observe the same count and exceed the
    // subscription limit.
    await sql.begin(async (_tx) => {
      const tx = _tx as unknown as TxSql;
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${developerId}, 1))`;

      const subRows = await tx<{ plan: string }[]>`
        SELECT plan FROM subscriptions WHERE developer_id = ${developerId}
      `;
      const planName = subRows[0]?.plan ?? 'free';
      const plan = isPlanName(planName) ? planName : 'free';
      const webhookLimit = PLAN_LIMITS[plan].webhooks;

      const countRows = await tx<{ count: string }[]>`
        SELECT COUNT(*) AS count FROM webhooks WHERE developer_id = ${developerId}
      `;
      const webhookCount = parseInt(countRows[0]?.count ?? '0', 10);
      if (webhookCount >= webhookLimit) {
        limitExceeded = { plan, limit: webhookLimit };
        return;
      }

      await tx`
        INSERT INTO webhooks (id, developer_id, url, events, secret)
        VALUES (${id}, ${developerId}, ${url}, ${events}, ${secret})
      `;
    });

    if (limitExceeded) {
      return reply.status(402).send({
        message: `Plan limit reached: ${limitExceeded.plan} plan allows ${limitExceeded.limit} webhook(s). Upgrade at /v1/billing/checkout`,
        code: 'PLAN_LIMIT_EXCEEDED',
        requestId: request.id,
      });
    }

    return reply.status(201).send({
      id,
      url,
      events,
      secret,
      createdAt: new Date().toISOString(),
    });
  });

  // GET /v1/webhooks
  app.get('/v1/webhooks', async (request, reply) => {
    const sql = getSql();
    const rows = await sql`
      SELECT id, url, events, created_at
      FROM webhooks
      WHERE developer_id = ${request.developer.id}
      ORDER BY created_at DESC
    `;
    return reply.send({
      webhooks: rows.map(r => ({
        id: r['id'],
        url: r['url'],
        events: r['events'],
        createdAt: r['created_at'],
      })),
    });
  });

  // GET /v1/webhooks/:id/deliveries
  app.get<{ Params: { id: string } }>('/v1/webhooks/:id/deliveries', async (request, reply) => {
    const sql = getSql();
    const developerId = request.developer.id;
    const webhookId = request.params.id;

    // Verify webhook ownership
    const whRows = await sql`
      SELECT id FROM webhooks
      WHERE id = ${webhookId} AND developer_id = ${developerId}
    `;
    if (!whRows[0]) {
      return reply.status(404).send({
        message: 'Webhook not found',
        code: 'NOT_FOUND',
        requestId: request.id,
      });
    }

    const query = request.query as Record<string, unknown>;
    const status = query['status'] ?? null;
    if (status !== null && (typeof status !== 'string' || !VALID_DELIVERY_STATUSES.has(status))) {
      return reply.status(400).send({
        message: 'status must be one of: pending, delivered, failed',
        code: 'BAD_REQUEST',
        requestId: request.id,
      });
    }

    const parsedPage = Number(query['page'] ?? 1);
    const parsedPageSize = Number(query['pageSize'] ?? 20);
    if (!Number.isSafeInteger(parsedPage) || parsedPage < 1 || parsedPage > 1_000_000 ||
        !Number.isSafeInteger(parsedPageSize) || parsedPageSize < 1) {
      return reply.status(400).send({
        message: 'page and pageSize must be positive integers',
        code: 'BAD_REQUEST',
        requestId: request.id,
      });
    }
    const page = parsedPage;
    const pageSize = Math.min(100, parsedPageSize);
    const offset = (page - 1) * pageSize;

    const countRows = await sql<{ count: string }[]>`
      SELECT COUNT(*) AS count FROM webhook_deliveries
      WHERE webhook_id = ${webhookId}
        AND (${status}::text IS NULL OR status = ${status ?? ''})
    `;
    const total = parseInt(countRows[0]?.count ?? '0', 10);

    const rows = await sql`
      SELECT id, event_id, event_type, status, attempts, max_attempts, url,
             last_error, created_at, delivered_at
      FROM webhook_deliveries
      WHERE webhook_id = ${webhookId}
        AND (${status}::text IS NULL OR status = ${status ?? ''})
      ORDER BY created_at DESC
      LIMIT ${pageSize} OFFSET ${offset}
    `;

    return reply.send({
      deliveries: rows.map(r => ({
        id: r['id'],
        webhookId,
        eventId: r['event_id'],
        eventType: r['event_type'],
        status: r['status'],
        attempts: r['attempts'],
        maxAttempts: r['max_attempts'],
        url: r['url'],
        lastError: r['last_error'] ?? null,
        createdAt: r['created_at'],
        deliveredAt: r['delivered_at'] ?? null,
      })),
      total,
      page,
      pageSize,
    });
  });

  // DELETE /v1/webhooks/:id
  app.delete<{ Params: { id: string } }>('/v1/webhooks/:id', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const sql = getSql();
    const rows = await sql`
      DELETE FROM webhooks
      WHERE id = ${request.params.id} AND developer_id = ${request.developer.id}
      RETURNING id
    `;
    if (!rows[0]) {
      return reply.status(404).send({
        message: 'Webhook not found',
        code: 'NOT_FOUND',
        requestId: request.id,
      });
    }
    return reply.status(204).send();
  });
}
