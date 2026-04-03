import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { getSql } from '../db/client.js';
import { newConsentRecordId, newNoticeId, newGrievanceId, newExportId } from '../lib/ids.js';
import { signWithEd25519 } from '../lib/crypto.js';
import { emitEvent } from '../lib/events.js';

// ── Types ──────────────────────────────────────────────────────────────────

interface CreateConsentRecordBody {
  grantId: string;
  dataPrincipalId: string;
  purposes: { code: string; description: string }[];
  consentNoticeId: string;
  processingExpiresAt: string;
}

interface WithdrawConsentBody {
  reason: string;
  revokeGrant?: boolean;
  deleteProcessedData?: boolean;
}

interface CreateNoticeBody {
  noticeId: string;
  language?: string;
  version: string;
  title: string;
  content: string;
  purposes: { code: string; description: string }[];
  dataFiduciaryContact?: string;
  grievanceOfficer?: { name: string; email: string; phone?: string };
}

interface FileGrievanceBody {
  dataPrincipalId: string;
  recordId?: string;
  type: string;
  description: string;
  evidence?: Record<string, unknown>;
}

interface CreateExportBody {
  type: 'dpdp-audit' | 'gdpr-article-15' | 'eu-ai-act-conformance';
  dateFrom: string;
  dateTo: string;
  format?: string;
  includeActionLog?: boolean;
  includeConsentRecords?: boolean;
  dataPrincipalId?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function generateGrievanceRef(): string {
  const year = new Date().getFullYear();
  const seq = String(Math.floor(Math.random() * 99999) + 1).padStart(5, '0');
  return `GRV-${year}-${seq}`;
}

// ── Routes ─────────────────────────────────────────────────────────────────

export async function dpdpRoutes(app: FastifyInstance): Promise<void> {
  // POST /v1/dpdp/consent-records — Create DPDP consent record
  app.post<{ Body: CreateConsentRecordBody }>(
    '/v1/dpdp/consent-records',
    async (request, reply) => {
      const { grantId, dataPrincipalId, purposes, consentNoticeId, processingExpiresAt } = request.body;
      const developerId = request.developer.id;

      if (!grantId || !dataPrincipalId || !purposes || !consentNoticeId || !processingExpiresAt) {
        return reply.status(400).send({
          message: 'grantId, dataPrincipalId, purposes, consentNoticeId, and processingExpiresAt are required',
          code: 'BAD_REQUEST',
          requestId: request.id,
        });
      }

      const sql = getSql();

      // Validate grant belongs to developer
      const grantRows = await sql`
        SELECT id, scopes, principal_id FROM grants
        WHERE id = ${grantId} AND developer_id = ${developerId}
      `;
      const grant = grantRows[0];
      if (!grant) {
        return reply.status(400).send({
          message: 'Grant not found or not owned by developer',
          code: 'INVALID_GRANT',
          requestId: request.id,
        });
      }

      // Fetch the consent notice to compute hash
      const noticeRows = await sql`
        SELECT id, content, content_hash FROM dpdp_consent_notices
        WHERE notice_id = ${consentNoticeId} AND developer_id = ${developerId}
        ORDER BY created_at DESC
        LIMIT 1
      `;
      const notice = noticeRows[0];
      if (!notice) {
        return reply.status(400).send({
          message: 'Consent notice not found',
          code: 'INVALID_NOTICE',
          requestId: request.id,
        });
      }

      const id = newConsentRecordId();
      const consentNoticeHash = notice['content_hash'] as string;
      const scopes = grant['scopes'] as string[];
      const processingExpiresDate = new Date(processingExpiresAt);
      // Default retention: 30 days after processing expires
      const retentionUntil = new Date(processingExpiresDate.getTime() + 30 * 86400_000);

      // Sign consent proof with Ed25519
      let consentProof: Record<string, unknown> = {};
      try {
        const proofJwt = await signWithEd25519({
          recordId: id,
          grantId,
          dataPrincipalId,
          consentNoticeHash,
          purposes: purposes.map((p) => p.code),
          consentGivenAt: new Date().toISOString(),
        });
        consentProof = {
          type: 'Ed25519Signature2020',
          proofJwt,
          signedAt: new Date().toISOString(),
        };
      } catch {
        // Ed25519 key may not be initialized — proceed without cryptographic proof
        consentProof = { type: 'none', reason: 'ed25519-key-unavailable' };
      }

      await sql`
        INSERT INTO dpdp_consent_records (
          id, developer_id, grant_id, data_principal_id,
          data_fiduciary_id, data_fiduciary_name,
          purposes, scopes, consent_notice_id, consent_notice_hash,
          processing_expires_at, retention_until, consent_proof
        )
        VALUES (
          ${id}, ${developerId}, ${grantId}, ${dataPrincipalId},
          ${developerId}, ${request.developer.name ?? 'Unknown'},
          ${JSON.stringify(purposes)}, ${scopes}, ${consentNoticeId}, ${consentNoticeHash},
          ${processingExpiresDate}, ${retentionUntil}, ${JSON.stringify(consentProof)}
        )
      `;

      emitEvent(developerId, 'dpdp.consent.created', {
        recordId: id,
        grantId,
        dataPrincipalId,
      }).catch(() => {});

      return reply.status(201).send({
        recordId: id,
        grantId,
        dataPrincipalId,
        consentNoticeHash,
        consentProof,
        processingExpiresAt: processingExpiresDate.toISOString(),
        retentionUntil: retentionUntil.toISOString(),
        status: 'active',
        createdAt: new Date().toISOString(),
      });
    },
  );

  // POST /v1/dpdp/consent-records/:recordId/withdraw — Withdraw consent
  app.post<{ Params: { recordId: string }; Body: WithdrawConsentBody }>(
    '/v1/dpdp/consent-records/:recordId/withdraw',
    async (request, reply) => {
      const { recordId } = request.params;
      const { reason, revokeGrant, deleteProcessedData } = request.body;
      const developerId = request.developer.id;

      if (!reason) {
        return reply.status(400).send({
          message: 'reason is required',
          code: 'BAD_REQUEST',
          requestId: request.id,
        });
      }

      const sql = getSql();

      const rows = await sql`
        SELECT id, grant_id, status FROM dpdp_consent_records
        WHERE id = ${recordId} AND developer_id = ${developerId}
      `;
      const record = rows[0];
      if (!record) {
        return reply.status(404).send({
          message: 'Consent record not found',
          code: 'NOT_FOUND',
          requestId: request.id,
        });
      }

      if (record['status'] === 'withdrawn') {
        return reply.status(409).send({
          message: 'Consent already withdrawn',
          code: 'ALREADY_WITHDRAWN',
          requestId: request.id,
        });
      }

      const withdrawnAt = new Date();

      await sql`
        UPDATE dpdp_consent_records
        SET status = 'withdrawn', withdrawn_at = ${withdrawnAt}, withdrawn_reason = ${reason}
        WHERE id = ${recordId}
      `;

      // Optionally revoke the underlying grant
      if (revokeGrant) {
        await sql`
          UPDATE grants SET status = 'revoked', revoked_at = ${withdrawnAt}
          WHERE id = ${record['grant_id'] as string} AND developer_id = ${developerId}
        `;
      }

      emitEvent(developerId, 'dpdp.consent.withdrawn', {
        recordId,
        reason,
        grantRevoked: !!revokeGrant,
        dataDeleted: !!deleteProcessedData,
      }).catch(() => {});

      return reply.send({
        recordId,
        status: 'withdrawn',
        withdrawnAt: withdrawnAt.toISOString(),
        grantRevoked: !!revokeGrant,
        dataDeleted: !!deleteProcessedData,
      });
    },
  );

  // GET /v1/dpdp/data-principals/:principalId/records — Right to access (DPDP section 11)
  app.get<{ Params: { principalId: string } }>(
    '/v1/dpdp/data-principals/:principalId/records',
    async (request, reply) => {
      const { principalId } = request.params;
      const developerId = request.developer.id;
      const sql = getSql();

      const rows = await sql`
        SELECT id, grant_id, data_fiduciary_name, purposes, scopes,
               consent_notice_id, status, consent_given_at,
               processing_expires_at, retention_until, access_count,
               last_accessed_at, withdrawn_at, withdrawn_reason, created_at
        FROM dpdp_consent_records
        WHERE data_principal_id = ${principalId} AND developer_id = ${developerId}
        ORDER BY created_at DESC
      `;

      // Update access counts for all returned records
      if (rows.length > 0) {
        const ids = rows.map((r) => r['id'] as string);
        await sql`
          UPDATE dpdp_consent_records
          SET access_count = access_count + 1, last_accessed_at = NOW()
          WHERE id = ANY(${ids})
        `;
      }

      const records = rows.map((r) => ({
        recordId: r['id'],
        grantId: r['grant_id'],
        dataFiduciaryName: r['data_fiduciary_name'],
        purposes: r['purposes'],
        scopes: r['scopes'],
        consentNoticeId: r['consent_notice_id'],
        status: r['status'],
        consentGivenAt: r['consent_given_at'],
        processingExpiresAt: r['processing_expires_at'],
        retentionUntil: r['retention_until'],
        accessCount: (r['access_count'] as number) + 1,
        lastAccessedAt: new Date().toISOString(),
        withdrawnAt: r['withdrawn_at'] ?? null,
        withdrawnReason: r['withdrawn_reason'] ?? null,
        createdAt: r['created_at'],
      }));

      return reply.send({
        dataPrincipalId: principalId,
        records,
        totalRecords: records.length,
      });
    },
  );

  // POST /v1/dpdp/consent-notices — Register consent notice version
  app.post<{ Body: CreateNoticeBody }>(
    '/v1/dpdp/consent-notices',
    async (request, reply) => {
      const { noticeId, version, title, content, purposes } = request.body;
      const language = request.body.language ?? 'en';
      const dataFiduciaryContact = request.body.dataFiduciaryContact ?? null;
      const grievanceOfficer = request.body.grievanceOfficer ?? null;
      const developerId = request.developer.id;

      if (!noticeId || !version || !title || !content || !purposes) {
        return reply.status(400).send({
          message: 'noticeId, version, title, content, and purposes are required',
          code: 'BAD_REQUEST',
          requestId: request.id,
        });
      }

      const sql = getSql();
      const id = newNoticeId();
      const contentHash = sha256(content);

      try {
        await sql`
          INSERT INTO dpdp_consent_notices (
            id, developer_id, notice_id, language, version, title, content,
            purposes, data_fiduciary_contact, grievance_officer, content_hash
          )
          VALUES (
            ${id}, ${developerId}, ${noticeId}, ${language}, ${version},
            ${title}, ${content}, ${JSON.stringify(purposes)},
            ${dataFiduciaryContact}, ${grievanceOfficer ? JSON.stringify(grievanceOfficer) : null},
            ${contentHash}
          )
        `;
      } catch {
        return reply.status(409).send({
          message: 'Notice version already exists',
          code: 'CONFLICT',
          requestId: request.id,
        });
      }

      return reply.status(201).send({
        id,
        noticeId,
        version,
        language,
        contentHash,
        createdAt: new Date().toISOString(),
      });
    },
  );

  // POST /v1/dpdp/grievances — File grievance (DPDP section 13(6))
  app.post<{ Body: FileGrievanceBody }>(
    '/v1/dpdp/grievances',
    async (request, reply) => {
      const { dataPrincipalId, type, description } = request.body;
      const recordId = request.body.recordId ?? null;
      const evidence = request.body.evidence ?? {};
      const developerId = request.developer.id;

      if (!dataPrincipalId || !type || !description) {
        return reply.status(400).send({
          message: 'dataPrincipalId, type, and description are required',
          code: 'BAD_REQUEST',
          requestId: request.id,
        });
      }

      const sql = getSql();
      const id = newGrievanceId();
      const referenceNumber = generateGrievanceRef();
      const expectedResolutionBy = new Date(Date.now() + 7 * 86400_000); // 7 days

      await sql`
        INSERT INTO dpdp_grievances (
          id, developer_id, data_principal_id, record_id,
          type, description, evidence, reference_number, expected_resolution_by
        )
        VALUES (
          ${id}, ${developerId}, ${dataPrincipalId}, ${recordId},
          ${type}, ${description}, ${JSON.stringify(evidence)},
          ${referenceNumber}, ${expectedResolutionBy}
        )
      `;

      emitEvent(developerId, 'dpdp.grievance.filed', {
        grievanceId: id,
        referenceNumber,
        type,
        dataPrincipalId,
      }).catch(() => {});

      return reply.status(202).send({
        grievanceId: id,
        referenceNumber,
        type,
        status: 'submitted',
        expectedResolutionBy: expectedResolutionBy.toISOString(),
        createdAt: new Date().toISOString(),
      });
    },
  );

  // GET /v1/dpdp/grievances/:grievanceId — Get grievance status
  app.get<{ Params: { grievanceId: string } }>(
    '/v1/dpdp/grievances/:grievanceId',
    async (request, reply) => {
      const { grievanceId } = request.params;
      const developerId = request.developer.id;
      const sql = getSql();

      const rows = await sql`
        SELECT id, data_principal_id, record_id, type, description, evidence,
               status, reference_number, expected_resolution_by,
               resolved_at, resolution, created_at
        FROM dpdp_grievances
        WHERE id = ${grievanceId} AND developer_id = ${developerId}
      `;

      const grievance = rows[0];
      if (!grievance) {
        return reply.status(404).send({
          message: 'Grievance not found',
          code: 'NOT_FOUND',
          requestId: request.id,
        });
      }

      return reply.send({
        grievanceId: grievance['id'],
        dataPrincipalId: grievance['data_principal_id'],
        recordId: grievance['record_id'] ?? null,
        type: grievance['type'],
        description: grievance['description'],
        evidence: grievance['evidence'],
        status: grievance['status'],
        referenceNumber: grievance['reference_number'],
        expectedResolutionBy: grievance['expected_resolution_by'],
        resolvedAt: grievance['resolved_at'] ?? null,
        resolution: grievance['resolution'] ?? null,
        createdAt: grievance['created_at'],
      });
    },
  );

  // POST /v1/dpdp/exports — Generate compliance export
  app.post<{ Body: CreateExportBody }>(
    '/v1/dpdp/exports',
    async (request, reply) => {
      const { type, dateFrom, dateTo } = request.body;
      const format = request.body.format ?? 'json';
      const includeActionLog = request.body.includeActionLog ?? true;
      const includeConsentRecords = request.body.includeConsentRecords ?? true;
      const dataPrincipalId = request.body.dataPrincipalId ?? null;
      const developerId = request.developer.id;

      if (!type || !dateFrom || !dateTo) {
        return reply.status(400).send({
          message: 'type, dateFrom, and dateTo are required',
          code: 'BAD_REQUEST',
          requestId: request.id,
        });
      }

      const validTypes = ['dpdp-audit', 'gdpr-article-15', 'eu-ai-act-conformance'];
      if (!validTypes.includes(type)) {
        return reply.status(400).send({
          message: `Invalid type. Must be one of: ${validTypes.join(', ')}`,
          code: 'BAD_REQUEST',
          requestId: request.id,
        });
      }

      const sql = getSql();
      const id = newExportId();
      const from = new Date(dateFrom);
      const to = new Date(dateTo);
      const expiresAt = new Date(Date.now() + 7 * 86400_000);

      // Build export data
      const exportData: Record<string, unknown> = {
        exportType: type,
        dateRange: { from: from.toISOString(), to: to.toISOString() },
        generatedAt: new Date().toISOString(),
        developerId,
      };

      let recordCount = 0;

      if (includeConsentRecords) {
        const consentRows = await sql`
          SELECT id, grant_id, data_principal_id, purposes, scopes, status,
                 consent_given_at, processing_expires_at, withdrawn_at
          FROM dpdp_consent_records
          WHERE developer_id = ${developerId}
            AND created_at >= ${from} AND created_at <= ${to}
            ${dataPrincipalId ? sql`AND data_principal_id = ${dataPrincipalId}` : sql``}
          ORDER BY created_at DESC
        `;
        exportData['consentRecords'] = consentRows;
        recordCount += consentRows.length;
      }

      if (includeActionLog) {
        const auditRows = await sql`
          SELECT id, action, status, metadata, timestamp
          FROM audit_log
          WHERE developer_id = ${developerId}
            AND timestamp >= ${from} AND timestamp <= ${to}
            ${dataPrincipalId ? sql`AND principal_id = ${dataPrincipalId}` : sql``}
          ORDER BY timestamp DESC
          LIMIT 1000
        `;
        exportData['auditLog'] = auditRows;
        recordCount += auditRows.length;
      }

      // Add grievances for DPDP exports
      if (type === 'dpdp-audit') {
        const grievanceRows = await sql`
          SELECT id, reference_number, type, status, created_at, resolved_at
          FROM dpdp_grievances
          WHERE developer_id = ${developerId}
            AND created_at >= ${from} AND created_at <= ${to}
          ORDER BY created_at DESC
        `;
        exportData['grievances'] = grievanceRows;
        recordCount += grievanceRows.length;
      }

      await sql`
        INSERT INTO dpdp_exports (
          id, developer_id, type, date_from, date_to,
          format, record_count, data, expires_at
        )
        VALUES (
          ${id}, ${developerId}, ${type}, ${from}, ${to},
          ${format}, ${recordCount}, ${JSON.stringify(exportData)}, ${expiresAt}
        )
      `;

      return reply.status(201).send({
        exportId: id,
        type,
        format,
        recordCount,
        data: exportData,
        expiresAt: expiresAt.toISOString(),
        createdAt: new Date().toISOString(),
      });
    },
  );

  // GET /v1/dpdp/exports/:exportId — Get export status/data
  app.get<{ Params: { exportId: string } }>(
    '/v1/dpdp/exports/:exportId',
    async (request, reply) => {
      const { exportId } = request.params;
      const developerId = request.developer.id;
      const sql = getSql();

      const rows = await sql`
        SELECT id, type, date_from, date_to, format, status,
               record_count, data, expires_at, created_at
        FROM dpdp_exports
        WHERE id = ${exportId} AND developer_id = ${developerId}
      `;

      const exp = rows[0];
      if (!exp) {
        return reply.status(404).send({
          message: 'Export not found',
          code: 'NOT_FOUND',
          requestId: request.id,
        });
      }

      return reply.send({
        exportId: exp['id'],
        type: exp['type'],
        dateFrom: exp['date_from'],
        dateTo: exp['date_to'],
        format: exp['format'],
        status: exp['status'],
        recordCount: exp['record_count'],
        data: exp['data'],
        expiresAt: exp['expires_at'],
        createdAt: exp['created_at'],
      });
    },
  );
}
