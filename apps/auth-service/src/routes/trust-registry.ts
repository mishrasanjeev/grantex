import type { FastifyInstance } from 'fastify';
import { resolve } from 'node:dns/promises';
import { getSql } from '../db/client.js';
import { ulid } from 'ulid';

/**
 * Verify organization ownership via DNS TXT record.
 *
 * Expected record: `_grantex-verify.<domain>` with value `grantex-verify=<token>`
 * where `<token>` is the org's `verificationToken` from the trust registry or
 * matches the pattern `grantex-verify=did:web:<domain>`.
 */
async function verifyDnsTxt(domain: string): Promise<boolean> {
  try {
    const records = await resolve(`_grantex-verify.${domain}`, 'TXT');
    // DNS TXT records come as arrays of strings (chunked)
    for (const chunks of records) {
      const txt = Array.isArray(chunks) ? chunks.join('') : String(chunks);
      if (
        txt === `grantex-verify=did:web:${domain}` ||
        txt.startsWith('grantex-verify=')
      ) {
        return true;
      }
    }
    return false;
  } catch {
    // ENOTFOUND, ENODATA, etc. — record doesn't exist
    return false;
  }
}

export async function trustRegistryRoutes(app: FastifyInstance): Promise<void> {
  // GET /v1/trust-registry/:orgDID — Public: look up org trust record
  app.get<{ Params: { orgDID: string } }>(
    '/v1/trust-registry/:orgDID',
    { config: { skipAuth: true } },
    async (request, reply) => {
      const { orgDID } = request.params;
      const sql = getSql();

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

  // POST /v1/trust-registry/verify-dns — Protected: trigger DNS TXT verification for an org
  app.post<{ Body: { domain: string } }>(
    '/v1/trust-registry/verify-dns',
    async (request, reply) => {
      const { domain } = request.body;

      if (!domain) {
        return reply.status(400).send({
          message: 'domain is required',
          code: 'BAD_REQUEST',
          requestId: request.id,
        });
      }

      const orgDID = `did:web:${domain}`;
      const verified = await verifyDnsTxt(domain);

      if (!verified) {
        return reply.status(400).send({
          message: `DNS TXT verification failed. Add a TXT record at _grantex-verify.${domain} with value "grantex-verify=did:web:${domain}"`,
          code: 'DNS_VERIFICATION_FAILED',
          requestId: request.id,
        });
      }

      const sql = getSql();
      const now = new Date();

      // Check if org already exists
      const existing = await sql`
        SELECT id FROM trust_registry WHERE organization_did = ${orgDID}
      `;

      if (existing[0]) {
        // Update existing record
        await sql`
          UPDATE trust_registry
          SET verification_method = 'dns-txt',
              trust_level = 'verified',
              verified_at = ${now},
              updated_at = ${now}
          WHERE organization_did = ${orgDID}
        `;
      } else {
        // Create new record
        const id = `treg_${ulid()}`;
        await sql`
          INSERT INTO trust_registry (id, organization_did, domain, verification_method, trust_level, verified_at)
          VALUES (${id}, ${orgDID}, ${domain}, 'dns-txt', 'verified', ${now})
        `;
      }

      return reply.status(200).send({
        organizationDID: orgDID,
        verified: true,
        verificationMethod: 'dns-txt',
        trustLevel: 'verified',
        verifiedAt: now.toISOString(),
        domain,
      });
    },
  );
}
