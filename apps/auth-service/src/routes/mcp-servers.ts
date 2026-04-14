import type { FastifyInstance } from 'fastify';
import { getSql } from '../db/client.js';
import { newMcpServerId, newCertificationId } from '../lib/ids.js';

const VALID_CATEGORIES = [
  'productivity',
  'data',
  'compute',
  'payments',
  'communication',
  'other',
];

const VALID_CERT_LEVELS = ['bronze', 'silver', 'gold'];

const VALID_SORT_FIELDS = ['weekly_active_agents', 'stars'];

interface RegisterServerBody {
  name: string;
  description?: string;
  serverUrl?: string;
  authEndpoint?: string;
  npmPackage?: string;
  category?: string;
  scopes?: string[];
}

interface ApplyCertificationBody {
  serverId: string;
  requestedLevel: string;
}

export async function mcpServersRoutes(app: FastifyInstance): Promise<void> {
  // GET /v1/mcp/servers — List MCP servers (public)
  app.get(
    '/v1/mcp/servers',
    { config: { skipAuth: true } },
    async (request, reply) => {
      const query = request.query as Record<string, string | undefined>;
      const sql = getSql();

      const certified = query.certified;
      const category = query.category;
      const q = query.q;
      const sort = query.sort;
      const limit = Math.min(Math.max(parseInt(query.limit ?? '20', 10) || 20, 1), 100);
      const cursor = query.cursor;

      // Build filter params — use null sentinels so postgres handles the logic
      const certifiedFilter = certified === 'true' ? true : certified === 'false' ? false : null;
      const categoryFilter = category ?? null;
      const searchFilter = q ? `%${q}%` : null;
      const cursorFilter = cursor ?? null;

      // Validate sort field
      const sortColumn = sort && VALID_SORT_FIELDS.includes(sort) ? sort : null;

      // Count total (without pagination)
      const countRows = await sql`
        SELECT COUNT(*)::int AS total FROM mcp_servers
        WHERE status = 'active'
          AND (${certifiedFilter}::boolean IS NULL OR certified = ${certifiedFilter})
          AND (${categoryFilter}::text IS NULL OR category = ${categoryFilter})
          AND (${searchFilter}::text IS NULL OR name ILIKE ${searchFilter} OR description ILIKE ${searchFilter})
      `;
      const total = (countRows[0] as { total: number }).total;

      // Fetch data — sort by the chosen column, fall back to created_at DESC
      const rows = await sql`
        SELECT
          id, name, description, category, scopes, certified, certified_at,
          certification_level, npm_package, weekly_active_agents, stars,
          server_url, auth_endpoint, created_at
        FROM mcp_servers
        WHERE status = 'active'
          AND (${certifiedFilter}::boolean IS NULL OR certified = ${certifiedFilter})
          AND (${categoryFilter}::text IS NULL OR category = ${categoryFilter})
          AND (${searchFilter}::text IS NULL OR name ILIKE ${searchFilter} OR description ILIKE ${searchFilter})
          AND (${cursorFilter}::text IS NULL OR id < ${cursorFilter})
        ORDER BY
          CASE WHEN ${sortColumn} = 'weekly_active_agents' THEN weekly_active_agents END DESC NULLS LAST,
          CASE WHEN ${sortColumn} = 'stars' THEN stars END DESC NULLS LAST,
          created_at DESC
        LIMIT ${limit}
      `;

      const data = rows.map((r) => ({
        serverId: r['id'] as string,
        name: r['name'] as string,
        description: r['description'] as string | null,
        category: r['category'] as string,
        scopes: r['scopes'] as string[],
        certified: r['certified'] as boolean,
        ...(r['certified_at'] ? { certifiedAt: (r['certified_at'] as Date).toISOString() } : {}),
        ...(r['certification_level'] ? { certificationLevel: r['certification_level'] as string } : {}),
        serverUrl: (r['server_url'] as string | null) ?? null,
        authEndpoint: (r['auth_endpoint'] as string | null) ?? null,
        npmPackage: (r['npm_package'] as string | null) ?? null,
        weeklyActiveAgents: r['weekly_active_agents'] as number,
        stars: r['stars'] as number,
        status: 'active' as const,
        createdAt: (r['created_at'] as Date).toISOString(),
      }));

      const nextCursor = rows.length === limit ? (rows[rows.length - 1]!['id'] as string) : undefined;

      return reply.send({
        data,
        meta: {
          total,
          ...(nextCursor !== undefined ? { cursor: nextCursor } : {}),
        },
      });
    },
  );

  // POST /v1/mcp/servers — Register an MCP server (protected)
  app.post<{ Body: RegisterServerBody }>(
    '/v1/mcp/servers',
    async (request, reply) => {
      const developerId = request.developer.id;
      const { name, description, serverUrl, authEndpoint, npmPackage, scopes } = request.body;
      const category = request.body.category ?? 'other';

      if (!name) {
        return reply.status(400).send({
          message: 'name is required',
          code: 'BAD_REQUEST',
          requestId: request.id,
        });
      }

      if (!VALID_CATEGORIES.includes(category)) {
        return reply.status(400).send({
          message: `Invalid category. Must be one of: ${VALID_CATEGORIES.join(', ')}`,
          code: 'BAD_REQUEST',
          requestId: request.id,
        });
      }

      const id = newMcpServerId();
      const sql = getSql();
      const scopeList = scopes ?? [];

      const inserted = await sql<{ created_at: Date }[]>`
        INSERT INTO mcp_servers (
          id, developer_id, name, description, server_url, auth_endpoint,
          npm_package, category, scopes
        )
        VALUES (
          ${id}, ${developerId}, ${name}, ${description ?? null},
          ${serverUrl ?? null}, ${authEndpoint ?? null},
          ${npmPackage ?? null}, ${category}, ${scopeList}
        )
        RETURNING created_at
      `;

      return reply.status(201).send({
        serverId: id,
        name,
        description: description ?? null,
        serverUrl: serverUrl ?? null,
        authEndpoint: authEndpoint ?? null,
        npmPackage: npmPackage ?? null,
        category,
        scopes: scopeList,
        certified: false,
        weeklyActiveAgents: 0,
        stars: 0,
        status: 'active',
        createdAt: inserted[0]!.created_at.toISOString(),
      });
    },
  );

  // GET /v1/mcp/servers/:serverId — Get server detail (public)
  app.get<{ Params: { serverId: string } }>(
    '/v1/mcp/servers/:serverId',
    { config: { skipAuth: true } },
    async (request, reply) => {
      const { serverId } = request.params;
      const sql = getSql();

      const rows = await sql`
        SELECT
          s.id, s.name, s.description, s.category, s.scopes,
          s.certified, s.certified_at, s.certification_level,
          s.server_url, s.auth_endpoint, s.npm_package,
          s.weekly_active_agents, s.stars, s.status,
          s.created_at, s.updated_at,
          d.id AS publisher_id, d.name AS publisher_name
        FROM mcp_servers s
        JOIN developers d ON d.id = s.developer_id
        WHERE s.id = ${serverId}
      `;

      const r = rows[0];
      if (!r) {
        return reply.status(404).send({
          message: 'MCP server not found',
          code: 'NOT_FOUND',
          requestId: request.id,
        });
      }

      return reply.send({
        serverId: r['id'] as string,
        name: r['name'] as string,
        description: r['description'] as string | null,
        category: r['category'] as string,
        scopes: r['scopes'] as string[],
        certified: r['certified'] as boolean,
        ...(r['certified_at'] ? { certifiedAt: (r['certified_at'] as Date).toISOString() } : {}),
        ...(r['certification_level'] ? { certificationLevel: r['certification_level'] as string } : {}),
        serverUrl: r['server_url'] as string | null,
        authEndpoint: r['auth_endpoint'] as string | null,
        npmPackage: r['npm_package'] as string | null,
        weeklyActiveAgents: r['weekly_active_agents'] as number,
        stars: r['stars'] as number,
        status: r['status'] as string,
        createdAt: (r['created_at'] as Date).toISOString(),
        updatedAt: (r['updated_at'] as Date).toISOString(),
        publisher: {
          id: r['publisher_id'] as string,
          name: r['publisher_name'] as string,
        },
      });
    },
  );

  // POST /v1/mcp/certification/apply — Apply for certification (protected)
  app.post<{ Body: ApplyCertificationBody }>(
    '/v1/mcp/certification/apply',
    async (request, reply) => {
      const developerId = request.developer.id;
      const { serverId, requestedLevel } = request.body;

      if (!serverId || !requestedLevel) {
        return reply.status(400).send({
          message: 'serverId and requestedLevel are required',
          code: 'BAD_REQUEST',
          requestId: request.id,
        });
      }

      if (!VALID_CERT_LEVELS.includes(requestedLevel)) {
        return reply.status(400).send({
          message: `Invalid requestedLevel. Must be one of: ${VALID_CERT_LEVELS.join(', ')}`,
          code: 'BAD_REQUEST',
          requestId: request.id,
        });
      }

      const sql = getSql();

      // Verify server exists and belongs to developer
      const serverRows = await sql`
        SELECT id FROM mcp_servers
        WHERE id = ${serverId} AND developer_id = ${developerId}
      `;

      if (!serverRows[0]) {
        return reply.status(404).send({
          message: 'MCP server not found or not owned by developer',
          code: 'NOT_FOUND',
          requestId: request.id,
        });
      }

      const certId = newCertificationId();

      await sql`
        INSERT INTO mcp_certifications (id, server_id, developer_id, requested_level)
        VALUES (${certId}, ${serverId}, ${developerId}, ${requestedLevel})
      `;

      return reply.status(202).send({
        certificationId: certId,
        serverId,
        requestedLevel,
        status: 'pending_conformance_test',
        conformancePassed: 0,
        conformanceTotal: 13,
        createdAt: new Date().toISOString(),
      });
    },
  );

  // GET /v1/mcp/certification/:certId — Get certification status (protected)
  app.get<{ Params: { certId: string } }>(
    '/v1/mcp/certification/:certId',
    async (request, reply) => {
      const { certId } = request.params;
      const developerId = request.developer.id;
      const sql = getSql();

      const rows = await sql`
        SELECT
          id, server_id, requested_level, status,
          conformance_results, conformance_passed, conformance_total,
          reviewed_at, reviewer_notes, created_at
        FROM mcp_certifications
        WHERE id = ${certId} AND developer_id = ${developerId}
      `;

      const cert = rows[0];
      if (!cert) {
        return reply.status(404).send({
          message: 'Certification not found',
          code: 'NOT_FOUND',
          requestId: request.id,
        });
      }

      return reply.send({
        certificationId: cert['id'] as string,
        serverId: cert['server_id'] as string,
        requestedLevel: cert['requested_level'] as string,
        status: cert['status'] as string,
        conformanceResults: cert['conformance_results'],
        conformancePassed: cert['conformance_passed'] as number,
        conformanceTotal: cert['conformance_total'] as number,
        ...(cert['reviewed_at'] ? { reviewedAt: (cert['reviewed_at'] as Date).toISOString() } : {}),
        ...(cert['reviewer_notes'] ? { reviewerNotes: cert['reviewer_notes'] as string } : {}),
        createdAt: (cert['created_at'] as Date).toISOString(),
      });
    },
  );
}
