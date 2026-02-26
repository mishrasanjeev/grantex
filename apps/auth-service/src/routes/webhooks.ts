import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { getSql } from '../db/client.js';
import { newWebhookId } from '../lib/ids.js';
import { isPlanName, PLAN_LIMITS } from '../lib/plans.js';

const VALID_EVENTS = new Set(['grant.created', 'grant.revoked', 'token.issued']);

interface CreateWebhookBody {
  url: string;
  events: string[];
}

export async function webhooksRoutes(app: FastifyInstance): Promise<void> {
  // POST /v1/webhooks
  app.post<{ Body: CreateWebhookBody }>('/v1/webhooks', async (request, reply) => {
    const { url, events } = request.body;

    if (!url || !events || !Array.isArray(events) || events.length === 0) {
      return reply.status(400).send({
        message: 'url and events are required',
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

    // Enforce plan webhook limit
    const subRows = await sql<{ plan: string }[]>`
      SELECT plan FROM subscriptions WHERE developer_id = ${developerId}
    `;
    const planName = subRows[0]?.plan ?? 'free';
    const plan = isPlanName(planName) ? planName : 'free';
    const webhookLimit = PLAN_LIMITS[plan].webhooks;

    const countRows = await sql<{ count: string }[]>`
      SELECT COUNT(*) AS count FROM webhooks WHERE developer_id = ${developerId}
    `;
    const webhookCount = parseInt(countRows[0]?.count ?? '0', 10);

    if (webhookCount >= webhookLimit) {
      return reply.status(402).send({
        message: `Plan limit reached: ${plan} plan allows ${webhookLimit} webhook(s). Upgrade at /v1/billing/checkout`,
        code: 'PLAN_LIMIT_EXCEEDED',
        requestId: request.id,
      });
    }

    const id = newWebhookId();
    const secret = randomBytes(24).toString('hex');

    await sql`
      INSERT INTO webhooks (id, developer_id, url, events, secret)
      VALUES (${id}, ${developerId}, ${url}, ${events}, ${secret})
    `;

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

  // DELETE /v1/webhooks/:id
  app.delete<{ Params: { id: string } }>('/v1/webhooks/:id', async (request, reply) => {
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
