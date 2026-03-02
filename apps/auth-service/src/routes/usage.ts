import type { FastifyInstance } from 'fastify';
import { getSql } from '../db/client.js';
import { getDailyUsage } from '../lib/usage.js';

export async function usageRoutes(app: FastifyInstance): Promise<void> {
  // GET /v1/usage — current period usage (real-time from Redis)
  app.get('/v1/usage', async (request, reply) => {
    const developerId = request.developer.id;
    const today = new Date().toISOString().slice(0, 10);

    const usage = await getDailyUsage(developerId, today);

    return reply.send({
      developerId,
      period: today,
      tokenExchanges: usage.token_exchanges,
      authorizations: usage.authorizations,
      verifications: usage.verifications,
      totalRequests: usage.token_exchanges + usage.authorizations + usage.verifications,
    });
  });

  // GET /v1/usage/history — daily breakdown from PostgreSQL
  app.get<{ Querystring: { days?: string } }>('/v1/usage/history', async (request, reply) => {
    const developerId = request.developer.id;
    const days = Math.min(parseInt(request.query.days ?? '30', 10) || 30, 90);

    const sql = getSql();
    const rows = await sql`
      SELECT date, token_exchanges, authorizations, verifications, total_requests
      FROM usage_daily
      WHERE developer_id = ${developerId}
        AND date >= CURRENT_DATE - ${days}
      ORDER BY date DESC
    `;

    return reply.send({
      developerId,
      days,
      entries: rows.map((r) => ({
        date: r['date'],
        tokenExchanges: r['token_exchanges'],
        authorizations: r['authorizations'],
        verifications: r['verifications'],
        totalRequests: r['total_requests'],
      })),
    });
  });
}
