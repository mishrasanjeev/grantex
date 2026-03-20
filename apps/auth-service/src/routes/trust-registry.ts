import type { FastifyInstance } from 'fastify';
import { getSql } from '../db/client.js';

export async function trustRegistryRoutes(app: FastifyInstance): Promise<void> {
  // GET /v1/trust-registry/:orgDID — Public: look up org trust record
  app.get<{ Params: { orgDID: string } }>(
    '/v1/trust-registry/:orgDID',
    { config: { skipAuth: true } },
    async (request, reply) => {
      const { orgDID } = request.params;
      const sql = getSql();

      // TODO: implement DNS TXT verification (post-hackathon)
      const rows = await sql`
        SELECT organization_did, domain, verified_at, verification_method, trust_level
        FROM trust_registry
        WHERE organization_did = ${orgDID}
      `;

      const record = rows[0];
      if (!record) {
        return reply.status(404).send({
          message: 'Organization not found in trust registry',
          code: 'NOT_FOUND',
          requestId: request.id,
        });
      }

      return reply.send({
        organizationDID: record['organization_did'],
        verifiedAt: (record['verified_at'] as Date).toISOString(),
        verificationMethod: record['verification_method'],
        trustLevel: record['trust_level'],
        domains: [record['domain'] as string],
      });
    },
  );

  // GET /v1/trust-registry — Protected: list all trust records (admin)
  app.get(
    '/v1/trust-registry',
    async (request, reply) => {
      const sql = getSql();

      const rows = await sql`
        SELECT organization_did, domain, verified_at, verification_method, trust_level
        FROM trust_registry
        ORDER BY created_at DESC
        LIMIT 100
      `;

      const records = rows.map((r) => ({
        organizationDID: r['organization_did'],
        verifiedAt: (r['verified_at'] as Date).toISOString(),
        verificationMethod: r['verification_method'],
        trustLevel: r['trust_level'],
        domains: [r['domain'] as string],
      }));

      return reply.send({ records });
    },
  );
}
