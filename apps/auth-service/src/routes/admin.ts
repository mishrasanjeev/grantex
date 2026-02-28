import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getSql } from '../db/client.js';
import { config } from '../config.js';

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  const adminKey = config.adminApiKey;

  function checkAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
    if (!adminKey) {
      reply.status(503).send({ message: 'Admin API not configured' });
      return false;
    }
    const auth = request.headers.authorization;
    if (auth !== `Bearer ${adminKey}`) {
      reply.status(401).send({ message: 'Unauthorized' });
      return false;
    }
    return true;
  }

  // GET /v1/admin/stats — aggregate platform stats
  app.get(
    '/v1/admin/stats',
    { config: { skipAuth: true } },
    async (request, reply) => {
      if (!checkAdmin(request, reply)) return;

      const sql = getSql();

      const [devTotal, dev24h, dev7d, dev30d, modeRows, agentTotal, grantTotal] = await Promise.all([
        sql`SELECT COUNT(*)::int AS count FROM developers`,
        sql`SELECT COUNT(*)::int AS count FROM developers WHERE created_at > NOW() - INTERVAL '24 hours'`,
        sql`SELECT COUNT(*)::int AS count FROM developers WHERE created_at > NOW() - INTERVAL '7 days'`,
        sql`SELECT COUNT(*)::int AS count FROM developers WHERE created_at > NOW() - INTERVAL '30 days'`,
        sql`SELECT mode, COUNT(*)::int AS count FROM developers GROUP BY mode`,
        sql`SELECT COUNT(*)::int AS count FROM agents`,
        sql`SELECT COUNT(*)::int AS count FROM grants`,
      ]);

      const byMode: Record<string, number> = {};
      for (const row of modeRows) {
        byMode[row.mode as string] = row.count as number;
      }

      return reply.send({
        totalDevelopers: devTotal[0]!['count'],
        last24h: dev24h[0]!['count'],
        last7d: dev7d[0]!['count'],
        last30d: dev30d[0]!['count'],
        byMode,
        totalAgents: agentTotal[0]!['count'],
        totalGrants: grantTotal[0]!['count'],
      });
    },
  );

  // GET /v1/admin/developers — paginated developer list
  app.get(
    '/v1/admin/developers',
    { config: { skipAuth: true } },
    async (request, reply) => {
      if (!checkAdmin(request, reply)) return;

      const sql = getSql();
      const query = request.query as Record<string, string | undefined>;
      const page = Math.max(1, parseInt(query.page ?? '1', 10) || 1);
      const pageSize = Math.min(100, Math.max(1, parseInt(query.pageSize ?? '50', 10) || 50));
      const offset = (page - 1) * pageSize;

      const [developers, countRows] = await Promise.all([
        sql`
          SELECT id, name, email, mode, created_at
          FROM developers
          ORDER BY created_at DESC
          LIMIT ${pageSize} OFFSET ${offset}
        `,
        sql`SELECT COUNT(*)::int AS count FROM developers`,
      ]);

      return reply.send({
        developers: developers.map((d) => ({
          id: d.id,
          name: d.name,
          email: d.email,
          mode: d.mode,
          createdAt: d.created_at,
        })),
        total: countRows[0]!['count'],
        page,
        pageSize,
      });
    },
  );
}
