import type { FastifyInstance } from 'fastify';
import { syncPolicyBundle, getActivePolicyBundle, listPolicyBundles } from '../lib/policy-sync.js';

export async function policySyncRoutes(app: FastifyInstance): Promise<void> {
  // POST /v1/policies/sync — upload a policy bundle
  app.post<{ Body: { format: string; version: string; content: string; fileCount?: number; activate?: boolean } }>(
    '/v1/policies/sync',
    async (request, reply) => {
      const { format, version, content, fileCount, activate } = request.body;
      const developerId = request.developer.id;

      if (!format || !version || !content) {
        return reply.status(400).send({
          message: 'format, version, and content are required',
          code: 'BAD_REQUEST',
          requestId: request.id,
        });
      }

      if (format !== 'rego' && format !== 'cedar') {
        return reply.status(400).send({
          message: 'format must be "rego" or "cedar"',
          code: 'BAD_REQUEST',
          requestId: request.id,
        });
      }

      const contentBuffer = Buffer.from(content, 'base64');

      const result = await syncPolicyBundle(
        developerId,
        format,
        version,
        contentBuffer,
        fileCount ?? 1,
        activate ?? true,
      );

      return reply.status(201).send(result);
    },
  );

  // GET /v1/policies/bundles — list policy bundles
  app.get<{ Querystring: { format?: string } }>('/v1/policies/bundles', async (request, reply) => {
    const developerId = request.developer.id;
    const format = request.query.format as 'rego' | 'cedar' | undefined;

    const bundles = await listPolicyBundles(developerId, format);

    return reply.send({ bundles });
  });

  // GET /v1/policies/bundles/active — get active bundle
  app.get<{ Querystring: { format: string } }>('/v1/policies/bundles/active', async (request, reply) => {
    const developerId = request.developer.id;
    const format = request.query.format as 'rego' | 'cedar';

    if (!format || (format !== 'rego' && format !== 'cedar')) {
      return reply.status(400).send({
        message: 'format query parameter is required (rego or cedar)',
        code: 'BAD_REQUEST',
        requestId: request.id,
      });
    }

    const bundle = await getActivePolicyBundle(developerId, format);

    if (!bundle) {
      return reply.status(404).send({
        message: 'No active policy bundle found',
        code: 'NOT_FOUND',
        requestId: request.id,
      });
    }

    return reply.send(bundle);
  });

  // POST /v1/policies/sync/webhook — git webhook trigger
  app.post<{ Body: { ref?: string; repository?: { full_name?: string } } }>(
    '/v1/policies/sync/webhook',
    async (request, reply) => {
      // This endpoint is intended for git webhook integrations.
      // The actual bundle upload would be triggered by a CI/CD pipeline.
      return reply.send({
        message: 'Webhook received',
        ref: request.body.ref,
        repository: request.body.repository?.full_name,
      });
    },
  );
}
