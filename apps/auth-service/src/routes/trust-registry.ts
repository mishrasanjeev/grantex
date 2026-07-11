import type { FastifyInstance } from 'fastify';
import { resolve } from 'node:dns/promises';
import { createHash, timingSafeEqual } from 'node:crypto';
import { getSql } from '../db/client.js';
import { ulid } from 'ulid';

/**
 * Verify organization ownership via DNS TXT record.
 *
 * New registrations must match the SHA-256 hash of the one-time token returned
 * at registration. Existing registrations without a stored hash retain support
 * for the legacy, exact `grantex-verify=did:web:<domain>` proof.
 */
export async function verifyDnsTxt(domain: string, expectedTokenHash: string | null): Promise<boolean> {
  try {
    const records = await resolve(`_grantex-verify.${domain}`, 'TXT');
    // DNS TXT records come as arrays of strings (chunked)
    for (const chunks of records) {
      const txt = Array.isArray(chunks) ? chunks.join('') : String(chunks);
      if (expectedTokenHash !== null) {
        const actualHash = hashVerificationToken(txt);
        const expected = Buffer.from(expectedTokenHash, 'hex');
        const actual = Buffer.from(actualHash, 'hex');
        if (expected.length === actual.length && timingSafeEqual(actual, expected)) return true;
      } else if (txt === `grantex-verify=did:web:${domain}`) {
        return true;
      }
    }
    return false;
  } catch {
    // ENOTFOUND, ENODATA, etc. — record doesn't exist
    return false;
  }
}

function hashVerificationToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function domainFromWebDid(did: string): string | null {
  if (!did.startsWith('did:web:')) return null;

  const authoritySegment = did.slice('did:web:'.length).split(':', 1)[0];
  if (!authoritySegment) return null;

  try {
    const authority = decodeURIComponent(authoritySegment);
    if (!authority || /[\s\/?#@]/.test(authority)) return null;
    const parsed = new URL(`https://${authority}`);
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
    const labels = hostname.split('.');

    if (hostname.length > 253 || labels.length < 2 || /^\d+(?:\.\d+){3}$/.test(hostname)) return null;
    if (labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) return null;

    return hostname;
  } catch {
    return null;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === '23505';
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
      const sql = getSql();

      // Check the row before resolving DNS so registrations with a one-time
      // challenge cannot fall back to the predictable legacy proof.
      const existing = await sql`
        SELECT id, verification_token_hash
        FROM trust_registry
        WHERE organization_did = ${orgDID}
      `;
      const expectedTokenHash = existing[0]
        ? (existing[0]['verification_token_hash'] as string | null)
        : null;
      const verified = await verifyDnsTxt(domain, expectedTokenHash);

      if (!verified) {
        return reply.status(400).send({
          message: expectedTokenHash === null
            ? `DNS TXT verification failed. Add a TXT record at _grantex-verify.${domain} with value "grantex-verify=did:web:${domain}"`
            : `DNS TXT verification failed for ${domain}`,
          code: 'DNS_VERIFICATION_FAILED',
          requestId: request.id,
        });
      }

      const now = new Date();

      if (existing[0]) {
        // Update existing record
        await sql`
          UPDATE trust_registry
          SET verification_method = 'dns-txt',
              trust_level = 'verified',
              verified_at = ${now},
              verification_token_hash = NULL,
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

      if (verified !== undefined && verified !== 'true' && verified !== 'false') {
        return reply.status(400).send({
          message: 'verified must be true or false',
          code: 'BAD_REQUEST',
          requestId: request.id,
        });
      }
      if (sort !== undefined && sort !== 'average_rating') {
        return reply.status(400).send({
          message: 'sort must be average_rating',
          code: 'BAD_REQUEST',
          requestId: request.id,
        });
      }

      const searchPattern = q?.trim() ? `%${q.trim()}%` : null;
      const verifiedFilter = verified === undefined ? null : verified;
      const badgeFilter = badge?.trim() || null;
      const categoryFilter = category?.trim() || null;
      const sortByRating = sort === 'average_rating';

      // Count the complete filtered result, independent of the current page.
      const countRows = await sql`
        SELECT COUNT(*)::integer AS total
        FROM trust_registry t
        WHERE (
          ${searchPattern}::text IS NULL
          OR t.name ILIKE ${searchPattern}
          OR COALESCE(t.description, '') ILIKE ${searchPattern}
        )
          AND (
            ${verifiedFilter}::text IS NULL
            OR (${verifiedFilter} = 'true' AND t.trust_level = 'verified')
            OR (${verifiedFilter} = 'false' AND t.trust_level != 'verified')
          )
          AND (${badgeFilter}::text IS NULL OR ${badgeFilter} = ANY(t.badges))
          AND (
            ${categoryFilter}::text IS NULL
            OR EXISTS (
              SELECT 1
              FROM registry_agents ra
              WHERE ra.registry_id = t.id
                AND ra.category = ${categoryFilter}
                AND ra.listed = true
            )
          )
      `;

      const rows = await sql`
        SELECT * FROM trust_registry t
        WHERE (
          ${searchPattern}::text IS NULL
          OR t.name ILIKE ${searchPattern}
          OR COALESCE(t.description, '') ILIKE ${searchPattern}
        )
          AND (
            ${verifiedFilter}::text IS NULL
            OR (${verifiedFilter} = 'true' AND t.trust_level = 'verified')
            OR (${verifiedFilter} = 'false' AND t.trust_level != 'verified')
          )
          AND (${badgeFilter}::text IS NULL OR ${badgeFilter} = ANY(t.badges))
          AND (
            ${categoryFilter}::text IS NULL
            OR EXISTS (
              SELECT 1
              FROM registry_agents ra
              WHERE ra.registry_id = t.id
                AND ra.category = ${categoryFilter}
                AND ra.listed = true
            )
          )
          AND (
            ${cursor ?? null}::text IS NULL
            OR (
              ${sortByRating} = true
              AND (t.average_rating, t.weekly_active_grants, t.created_at, t.id) < (
                SELECT c.average_rating, c.weekly_active_grants, c.created_at, c.id
                FROM trust_registry c
                WHERE c.id = ${cursor ?? null}
              )
            )
            OR (
              ${sortByRating} = false
              AND (t.weekly_active_grants, t.created_at, t.id) < (
                SELECT c.weekly_active_grants, c.created_at, c.id
                FROM trust_registry c
                WHERE c.id = ${cursor ?? null}
              )
            )
          )
        ORDER BY
          CASE WHEN ${sortByRating} THEN t.average_rating END DESC NULLS LAST,
          t.weekly_active_grants DESC,
          t.created_at DESC,
          t.id DESC
        LIMIT ${limit + 1}
      `;

      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit) as Record<string, unknown>[];
      const nextCursor = hasMore ? (page[page.length - 1]!['id'] as string) : null;

      return reply.send({
        data: page.map(toOrgSummary),
        meta: {
          total: Number(countRows[0]?.['total'] ?? 0),
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
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
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

      if (verificationMethod && verificationMethod !== 'dns-txt') {
        return reply.status(400).send({
          message: 'Only dns-txt verification is currently supported',
          code: 'UNSUPPORTED_VERIFICATION_METHOD',
          requestId: request.id,
        });
      }

      const domain = domainFromWebDid(did);
      if (!domain) {
        return reply.status(400).send({
          message: 'did must be a did:web identifier with a valid DNS hostname',
          code: 'BAD_REQUEST',
          requestId: request.id,
        });
      }

      const sql = getSql();
      const id = `treg_${ulid()}`;

      const verificationToken = `grantex-verify=${ulid()}`;
      const verificationTokenHash = hashVerificationToken(verificationToken);

      try {
        await sql`
          INSERT INTO trust_registry (
            id, organization_did, domain, developer_id,
            name, description, website,
            contact_security, contact_dpo,
            trust_level, verification_method, verification_token_hash, verified_at
          ) VALUES (
            ${id}, ${did}, ${domain}, ${developerId},
            ${name}, ${description ?? null}, ${website ?? null},
            ${contact?.security ?? null}, ${contact?.dpo ?? null},
            'basic', ${requestVerification ? 'dns-txt' : 'pending'}, ${verificationTokenHash}, NULL
          )
        `;
      } catch (error) {
        if (isUniqueViolation(error)) {
          return reply.status(409).send({
            message: 'This organization DID is already registered',
            code: 'CONFLICT',
            requestId: request.id,
          });
        }
        throw error;
      }

      const dnsRecordName = `_grantex-verify.${domain}`;
      const instructions = requestVerification
        ? `Add a DNS TXT record at ${dnsRecordName} with value "${verificationToken}"`
        : null;

      return reply.status(201).send({
        orgId: id,
        did,
        name,
        trustLevel: 'basic',
        domain,
        dnsRecordName,
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
        SELECT id, domain, organization_did, developer_id, verification_token_hash
        FROM trust_registry
        WHERE id = ${orgId} OR organization_did = ${orgId}
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
      const verified = await verifyDnsTxt(domain, record['verification_token_hash'] as string | null);

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
            verification_token_hash = NULL,
            badges = CASE
              WHEN 'dns-verified' = ANY(badges) THEN badges
              ELSE array_append(badges, 'dns-verified')
            END,
            updated_at = ${now}
        WHERE id = ${record['id']}
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
