import type { FastifyInstance } from 'fastify';
import { getSql } from '../db/client.js';

export async function meRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/me', async (request, reply) => {
    const sql = getSql();
    const developerId = request.developer.id;

    const rows = await sql<{
      id: string;
      name: string;
      email: string | null;
      mode: string;
      plan: string | null;
      created_at: string;
    }[]>`
      SELECT d.id, d.name, d.email, d.mode,
             s.plan,
             d.created_at
      FROM developers d
      LEFT JOIN subscriptions s ON s.developer_id = d.id
      WHERE d.id = ${developerId}
      LIMIT 1
    `;

    const dev = rows[0];
    if (!dev) {
      return reply.status(404).send({
        message: 'Developer not found',
        code: 'NOT_FOUND',
        requestId: request.id,
      });
    }

    return reply.send({
      developerId: dev.id,
      name: dev.name,
      email: dev.email,
      mode: dev.mode,
      plan: dev.plan ?? 'free',
      createdAt: dev.created_at,
    });
  });

  // PATCH /v1/me — update developer settings (e.g. FIDO)
  app.patch<{ Body: { fidoRequired?: boolean; fidoRpName?: string } }>(
    '/v1/me',
    async (request, reply) => {
      const sql = getSql();
      const developerId = request.developer.id;
      const { fidoRequired, fidoRpName } = request.body;

      if (fidoRequired === undefined && fidoRpName === undefined) {
        return reply.status(400).send({ message: 'No fields to update', code: 'BAD_REQUEST', requestId: request.id });
      }

      if (fidoRequired !== undefined && fidoRpName !== undefined) {
        await sql`
          UPDATE developers
          SET fido_required = ${fidoRequired}, fido_rp_name = ${fidoRpName}
          WHERE id = ${developerId}
        `;
      } else if (fidoRequired !== undefined) {
        await sql`
          UPDATE developers SET fido_required = ${fidoRequired} WHERE id = ${developerId}
        `;
      } else {
        await sql`
          UPDATE developers SET fido_rp_name = ${fidoRpName!} WHERE id = ${developerId}
        `;
      }

      return reply.send({ updated: true });
    },
  );
}
