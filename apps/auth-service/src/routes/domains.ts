import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { getSql } from '../db/client.js';
import { verifyDomainDns } from '../lib/domains.js';

export async function domainsRoutes(app: FastifyInstance): Promise<void> {
  // POST /v1/domains — register a custom domain
  app.post<{ Body: { domain: string } }>('/v1/domains', async (request, reply) => {
    const { domain } = request.body;
    const developerId = request.developer.id;

    if (!domain) {
      return reply.status(400).send({
        message: 'domain is required',
        code: 'BAD_REQUEST',
        requestId: request.id,
      });
    }

    // Only enterprise plan can use custom domains
    const sql = getSql();
    const subRows = await sql<{ plan: string }[]>`
      SELECT plan FROM subscriptions WHERE developer_id = ${developerId}
    `;
    const planName = subRows[0]?.plan ?? 'free';
    if (planName !== 'enterprise') {
      return reply.status(402).send({
        message: 'Custom domains require Enterprise plan',
        code: 'PLAN_LIMIT_EXCEEDED',
        requestId: request.id,
      });
    }

    const id = `dom_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const verificationToken = `grantex-verify-${randomUUID()}`;

    try {
      await sql`
        INSERT INTO custom_domains (id, developer_id, domain, verification_token)
        VALUES (${id}, ${developerId}, ${domain}, ${verificationToken})
      `;
    } catch {
      return reply.status(409).send({
        message: 'Domain already registered',
        code: 'CONFLICT',
        requestId: request.id,
      });
    }

    return reply.status(201).send({
      id,
      domain,
      verified: false,
      verificationToken,
      instructions: `Add a DNS TXT record: _grantex.${domain} = ${verificationToken}`,
    });
  });

  // GET /v1/domains — list custom domains
  app.get('/v1/domains', async (request, reply) => {
    const sql = getSql();
    const rows = await sql`
      SELECT id, domain, verified, verified_at, created_at
      FROM custom_domains
      WHERE developer_id = ${request.developer.id}
      ORDER BY created_at DESC
    `;

    return reply.send({
      domains: rows.map((r) => ({
        id: r['id'],
        domain: r['domain'],
        verified: r['verified'],
        verifiedAt: r['verified_at'],
        createdAt: r['created_at'],
      })),
    });
  });

  // POST /v1/domains/:id/verify — verify domain DNS
  app.post<{ Params: { id: string } }>('/v1/domains/:id/verify', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const sql = getSql();

    const rows = await sql`
      SELECT id, domain, verification_token, verified
      FROM custom_domains
      WHERE id = ${request.params.id} AND developer_id = ${request.developer.id}
    `;

    const row = rows[0];
    if (!row) {
      return reply.status(404).send({
        message: 'Domain not found',
        code: 'NOT_FOUND',
        requestId: request.id,
      });
    }

    if (row['verified']) {
      return reply.send({ verified: true, message: 'Domain already verified' });
    }

    const verified = await verifyDomainDns(
      row['domain'] as string,
      row['verification_token'] as string,
    );

    if (!verified) {
      return reply.status(400).send({
        message: 'DNS verification failed. Ensure TXT record is set.',
        code: 'VERIFICATION_FAILED',
        requestId: request.id,
      });
    }

    await sql`
      UPDATE custom_domains SET verified = TRUE, verified_at = NOW()
      WHERE id = ${row['id'] as string}
    `;

    return reply.send({ verified: true, message: 'Domain verified successfully' });
  });

  // DELETE /v1/domains/:id — remove a custom domain
  app.delete<{ Params: { id: string } }>('/v1/domains/:id', async (request, reply) => {
    const sql = getSql();

    const rows = await sql`
      DELETE FROM custom_domains
      WHERE id = ${request.params.id} AND developer_id = ${request.developer.id}
      RETURNING id
    `;

    if (!rows[0]) {
      return reply.status(404).send({
        message: 'Domain not found',
        code: 'NOT_FOUND',
        requestId: request.id,
      });
    }

    return reply.status(204).send();
  });
}
