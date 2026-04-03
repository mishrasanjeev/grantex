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
export async function verifyDnsTxt(domain: string): Promise<boolean> {
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

// -----------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------

/** Map trust_level DB value to the public verificationLevel label. */
function toVerificationLevel(trustLevel: string): string {
  switch (trustLevel) {
    case 'verified':
      return 'verified';
    case 'extended':
      return 'extended';
    default:
      return 'basic';
  }
}

/** Shape a raw trust_registry row into the public org summary. */
function toOrgSummary(r: Record<string, unknown>) {
  return {
    did: r['organization_did'] as string,
    name: (r['name'] as string) ?? null,
    description: (r['description'] as string) ?? null,
    verificationLevel: toVerificationLevel(r['trust_level'] as string),
    badges: (r['badges'] as string[]) ?? [],
    stats: {
      totalAgents: Number(r['total_agents'] ?? 0),
      weeklyActiveGrants: Number(r['weekly_active_grants'] ?? 0),
      averageRating: Number(r['average_rating'] ?? 0),
    },
    website: (r['website'] as string) ?? null,
    logoUrl: (r['logo_url'] as string) ?? null,
  };
}

/** Shape a raw trust_registry row into the full org detail. */
function toOrgDetail(r: Record<string, unknown>, agents: unknown[]) {
  return {
    ...toOrgSummary(r),
    domain: r['domain'] as string,
    publicKeys: r['public_keys'] ?? [],
    compliance: {
      soc2: Boolean(r['compliance_soc2']),
      iso27001: Boolean(r['compliance_iso27001']),
      dpdp: Boolean(r['compliance_dpdp']),
      gdpr: Boolean(r['compliance_gdpr']),
    },
    contact: {
      security: (r['contact_security'] as string) ?? null,
      dpo: (r['contact_dpo'] as string) ?? null,
    },
    reviewCount: Number(r['review_count'] ?? 0),
    verifiedAt: r['verified_at'] ? (r['verified_at'] as Date).toISOString?.() ?? String(r['verified_at']) : null,
    verificationMethod: (r['verification_method'] as string) ?? null,
    agents,
  };
}

/** Shape a registry_agents row into the public agent shape. */
function toAgentSummary(a: Record<string, unknown>) {
  return {
    id: a['id'] as string,
    agentDid: a['agent_did'] as string,
    name: a['name'] as string,
    description: (a['description'] as string) ?? null,
    version: (a['version'] as string) ?? null,
    scopes: (a['scopes'] as string[]) ?? [],
    category: (a['category'] as string) ?? 'other',
    npmPackage: (a['npm_package'] as string) ?? null,
    pypiPackage: (a['pypi_package'] as string) ?? null,
    githubUrl: (a['github_url'] as string) ?? null,
    weeklyActiveGrants: Number(a['weekly_active_grants'] ?? 0),
    rating: Number(a['rating'] ?? 0),
    reviewCount: Number(a['review_count'] ?? 0),
  };
}

export async function trustRegistryRoutes(app: FastifyInstance): Promise<void> {
  // ===============================================================
  // LEGACY ENDPOINTS — backward compatible
  // ===============================================================

  // GET /v1/trust-registry/:orgDID — Public: look up org trust record (enhanced)
  app.get<{ Params: { orgDID: string } }>(
    '/v1/trust-registry/:orgDID',
    { config: { skipAuth: true } },
    async (request, reply) => {
      const { orgDID } = request.params;
      const sql = getSql();

      const rows = await sql`
        SELECT *
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

      // Fetch listed agents
      const agentRows = await sql`
        SELECT * FROM registry_agents
        WHERE registry_id = ${record['id']} AND listed = true
        ORDER BY created_at DESC
      `;

      const agents = agentRows.map(toAgentSummary);

      return reply.send({
        organizationDID: record['organization_did'],
        verifiedAt: record['verified_at']
          ? (record['verified_at'] as Date).toISOString?.() ?? String(record['verified_at'])
          : null,
        verificationMethod: record['verification_method'],
        trustLevel: record['trust_level'],
        domains: [record['domain'] as string],
        name: record['name'] ?? null,
        description: record['description'] ?? null,
        badges: record['badges'] ?? [],
        stats: {
          totalAgents: Number(record['total_agents'] ?? 0),
          weeklyActiveGrants: Number(record['weekly_active_grants'] ?? 0),
          averageRating: Number(record['average_rating'] ?? 0),
        },
        agents,
      });
    },
  );

  // GET /v1/trust-registry — Protected: list all trust records (admin)
  app.get(
    '/v1/trust-registry',
    async (request, reply) => {
      const sql = getSql();

      const rows = await sql`
        SELECT *
        FROM trust_registry
        ORDER BY created_at DESC
        LIMIT 100
      `;

      const records = rows.map((r) => ({
        organizationDID: r['organization_did'],
        verifiedAt: r['verified_at']
          ? (r['verified_at'] as Date).toISOString?.() ?? String(r['verified_at'])
          : null,
        verificationMethod: r['verification_method'],
        trustLevel: r['trust_level'],
        domains: [r['domain'] as string],
        name: r['name'] ?? null,
        description: r['description'] ?? null,
        badges: r['badges'] ?? [],
      }));

      return reply.send({ records });
    },
  );

  // POST /v1/trust-registry/verify-dns — Protected: trigger DNS TXT verification for an org
  app.post<{ Body: { domain: string } }>(
    '/v1/trust-registry/verify-dns',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
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

  // ===============================================================
  // NEW PUBLIC REGISTRY ENDPOINTS (PRD §5.4)
  // ===============================================================

  // GET /v1/registry/orgs — Public: search organizations
  app.get<{
    Querystring: {
      q?: string;
      verified?: string;
      badge?: string;
      category?: string;
      sort?: string;
      limit?: string;
      cursor?: string;
    };
  }>(
    '/v1/registry/orgs',
    { config: { skipAuth: true } },
    async (request, reply) => {
      const sql = getSql();
      const {
        q,
        verified,
        badge,
        category,
        sort,
        limit: limitStr,
        cursor,
      } = request.query;

      const limit = Math.min(Math.max(Number(limitStr) || 20, 1), 100);

      // Build dynamic conditions
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (q) {
        // Search by name or description (case-insensitive)
        conditions.push(`(t.name ILIKE $1 OR t.description ILIKE $1)`);
        params.push(`%${q}%`);
      }

      if (verified === 'true') {
        conditions.push(`t.trust_level = 'verified'`);
      } else if (verified === 'false') {
        conditions.push(`t.trust_level != 'verified'`);
      }

      if (badge) {
        conditions.push(`$${params.length + 1} = ANY(t.badges)`);
        params.push(badge);
      }

      if (cursor) {
        conditions.push(`t.id < $${params.length + 1}`);
        params.push(cursor);
      }

      // When category is provided we need to join registry_agents
      // to filter orgs that have agents in that category
      if (category) {
        conditions.push(
          `EXISTS (SELECT 1 FROM registry_agents ra WHERE ra.registry_id = t.id AND ra.category = $${params.length + 1} AND ra.listed = true)`,
        );
        params.push(category);
      }

      // Because postgres.js uses tagged-template sql we cannot pass
      // dynamic WHERE easily. Instead we query all and filter in-app
      // for simplicity (registry will be small — thousands of rows max).
      // We read a superset and apply filters.

      const rows = await sql`
        SELECT * FROM trust_registry t
        ORDER BY
          CASE WHEN ${sort ?? ''} = 'average_rating' THEN t.average_rating ELSE 0 END DESC,
          t.weekly_active_grants DESC,
          t.created_at DESC
        LIMIT ${limit + 1}
      `;

      // Apply in-app filters
      let filtered = rows as Record<string, unknown>[];

      if (q) {
        const lower = q.toLowerCase();
        filtered = filtered.filter(
          (r) =>
            ((r['name'] as string) ?? '').toLowerCase().includes(lower) ||
            ((r['description'] as string) ?? '').toLowerCase().includes(lower),
        );
      }

      if (verified === 'true') {
        filtered = filtered.filter((r) => r['trust_level'] === 'verified');
      } else if (verified === 'false') {
        filtered = filtered.filter((r) => r['trust_level'] !== 'verified');
      }

      if (badge) {
        filtered = filtered.filter((r) =>
          ((r['badges'] as string[]) ?? []).includes(badge),
        );
      }

      if (cursor) {
        filtered = filtered.filter((r) => (r['id'] as string) < cursor);
      }

      const hasMore = filtered.length > limit;
      const page = filtered.slice(0, limit);
      const nextCursor = hasMore ? (page[page.length - 1]!['id'] as string) : null;

      return reply.send({
        data: page.map(toOrgSummary),
        meta: {
          total: page.length,
          ...(nextCursor !== null ? { cursor: nextCursor } : {}),
        },
      });
    },
  );

  // GET /v1/registry/orgs/:did — Public: get org detail
  app.get<{ Params: { did: string } }>(
    '/v1/registry/orgs/:did',
    { config: { skipAuth: true } },
    async (request, reply) => {
      const { did } = request.params;
      const sql = getSql();

      const rows = await sql`
        SELECT * FROM trust_registry WHERE organization_did = ${did}
      `;

      const record = rows[0];
      if (!record) {
        return reply.status(404).send({
          message: 'Organization not found',
          code: 'NOT_FOUND',
          requestId: request.id,
        });
      }

      // Fetch listed agents
      const agentRows = await sql`
        SELECT * FROM registry_agents
        WHERE registry_id = ${record['id']} AND listed = true
        ORDER BY created_at DESC
      `;

      const agents = agentRows.map(toAgentSummary);

      return reply.send(toOrgDetail(record, agents));
    },
  );

  // GET /v1/registry/orgs/:did/jwks — Public: org JWK set
  app.get<{ Params: { did: string } }>(
    '/v1/registry/orgs/:did/jwks',
    { config: { skipAuth: true } },
    async (request, reply) => {
      const { did } = request.params;
      const sql = getSql();

      const rows = await sql`
        SELECT public_keys FROM trust_registry WHERE organization_did = ${did}
      `;

      const record = rows[0];
      if (!record) {
        return reply.status(404).send({
          message: 'Organization not found',
          code: 'NOT_FOUND',
          requestId: request.id,
        });
      }

      const keys = record['public_keys'] ?? [];

      return reply.send({ keys });
    },
  );

  // POST /v1/registry/orgs — Protected: register organization
  app.post<{
    Body: {
      did: string;
      name: string;
      description?: string;
      website?: string;
      contact?: { security?: string; dpo?: string };
      requestVerification?: boolean;
      verificationMethod?: string;
    };
  }>(
    '/v1/registry/orgs',
    async (request, reply) => {
      const { did, name, description, website, contact, requestVerification, verificationMethod } = request.body;
      const developerId = request.developer.id;

      if (!did || !name) {
        return reply.status(400).send({
          message: 'did and name are required',
          code: 'BAD_REQUEST',
          requestId: request.id,
        });
      }

      const sql = getSql();
      const id = `treg_${ulid()}`;

      // Extract domain from DID (did:web:example.com → example.com)
      const domain = did.startsWith('did:web:') ? did.slice('did:web:'.length) : did;

      const verificationToken = `grantex-verify=${ulid()}`;

      await sql`
        INSERT INTO trust_registry (
          id, organization_did, domain, developer_id,
          name, description, website,
          contact_security, contact_dpo,
          trust_level, verification_method, verified_at
        ) VALUES (
          ${id}, ${did}, ${domain}, ${developerId},
          ${name}, ${description ?? null}, ${website ?? null},
          ${contact?.security ?? null}, ${contact?.dpo ?? null},
          'basic', ${verificationMethod ?? 'pending'}, NOW()
        )
      `;

      const instructions = requestVerification
        ? `Add a DNS TXT record at _grantex-verify.${domain} with value "${verificationToken}"`
        : null;

      return reply.status(201).send({
        orgId: id,
        did,
        name,
        trustLevel: 'basic',
        verificationToken,
        ...(instructions !== null ? { instructions } : {}),
      });
    },
  );

  // POST /v1/registry/orgs/:orgId/verify-dns — Protected: trigger DNS verification for a specific org
  app.post<{ Params: { orgId: string } }>(
    '/v1/registry/orgs/:orgId/verify-dns',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { orgId } = request.params;
      const developerId = request.developer.id;
      const sql = getSql();

      // Look up org
      const rows = await sql`
        SELECT id, domain, organization_did, developer_id
        FROM trust_registry
        WHERE id = ${orgId}
      `;

      const record = rows[0];
      if (!record) {
        return reply.status(404).send({
          message: 'Organization not found',
          code: 'NOT_FOUND',
          requestId: request.id,
        });
      }

      // Verify ownership
      if (record['developer_id'] && record['developer_id'] !== developerId) {
        return reply.status(403).send({
          message: 'Not authorized to verify this organization',
          code: 'FORBIDDEN',
          requestId: request.id,
        });
      }

      const domain = record['domain'] as string;
      const verified = await verifyDnsTxt(domain);

      if (!verified) {
        return reply.status(400).send({
          message: `DNS TXT verification failed for ${domain}`,
          code: 'DNS_VERIFICATION_FAILED',
          requestId: request.id,
        });
      }

      const now = new Date();

      await sql`
        UPDATE trust_registry
        SET verification_method = 'dns-txt',
            trust_level = 'verified',
            verified_at = ${now},
            badges = array_append(
              CASE WHEN NOT ('dns-verified' = ANY(badges)) THEN badges ELSE badges END,
              'dns-verified'
            ),
            updated_at = ${now}
        WHERE id = ${orgId} AND NOT ('dns-verified' = ANY(badges))
      `;

      // Also update if badges already contained it (just update times)
      await sql`
        UPDATE trust_registry
        SET verification_method = 'dns-txt',
            trust_level = 'verified',
            verified_at = ${now},
            updated_at = ${now}
        WHERE id = ${orgId} AND 'dns-verified' = ANY(badges)
      `;

      return reply.send({
        orgId,
        verified: true,
        verificationMethod: 'dns-txt',
        trustLevel: 'verified',
        verifiedAt: now.toISOString(),
        domain,
      });
    },
  );
}
