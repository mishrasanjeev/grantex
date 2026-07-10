import type { FastifyInstance } from 'fastify';
import * as jose from 'jose';
import { getSql, type TxSql } from '../db/client.js';
import { signGrantToken, buildJwks, parseExpiresIn } from '../lib/crypto.js';
import { newConsentBundleId, newGrantId, newTokenId, newOfflineAuditEntryId } from '../lib/ids.js';
import { emitEvent } from '../lib/events.js';
import { config } from '../config.js';
import {
  computeOfflineAuditEntryHash,
  OFFLINE_AUDIT_GENESIS_HASH,
  verifyOfflineAuditEntrySignature,
  type SignedOfflineAuditEntry,
} from '../lib/offline-audit.js';

interface CreateBundleBody {
  agentId: string;
  userId: string;
  scopes: string[];
  offlineTTL?: string;
  offlineAuditKeyAlgorithm?: string;
  deviceId?: string;
  devicePlatform?: string;
}

interface OfflineSyncEntry {
  seq: number;
  timestamp: string;
  action: string;
  agentDID: string;
  grantId: string;
  scopes: string[];
  result: string;
  metadata?: Record<string, unknown>;
  prevHash: string;
  hash: string;
  signature: string;
}

interface OfflineSyncBody {
  bundleId: string;
  deviceId?: string;
  entries: OfflineSyncEntry[];
}

function offlineEntryShapeError(entry: OfflineSyncEntry): string | null {
  if (!Number.isSafeInteger(entry.seq) || entry.seq <= 0) return 'seq must be a positive integer';
  if (typeof entry.timestamp !== 'string' || Number.isNaN(Date.parse(entry.timestamp))) return 'timestamp must be a valid date-time';
  if (typeof entry.action !== 'string' || entry.action.length === 0 || entry.action.length > 256) return 'action must be 1 to 256 characters';
  if (typeof entry.agentDID !== 'string' || entry.agentDID.length === 0 || entry.agentDID.length > 512) return 'agentDID must be 1 to 512 characters';
  if (typeof entry.grantId !== 'string' || entry.grantId.length === 0 || entry.grantId.length > 128) return 'grantId must be 1 to 128 characters';
  if (!Array.isArray(entry.scopes) || entry.scopes.length === 0 || entry.scopes.length > 100
    || entry.scopes.some((scope) => typeof scope !== 'string' || scope.length === 0 || scope.length > 256)) {
    return 'scopes must contain 1 to 100 valid scope strings';
  }
  if (typeof entry.result !== 'string' || entry.result.length === 0 || entry.result.length > 64) return 'result must be 1 to 64 characters';
  if (entry.metadata !== undefined && (typeof entry.metadata !== 'object' || entry.metadata === null || Array.isArray(entry.metadata))) {
    return 'metadata must be an object';
  }
  if (typeof entry.prevHash !== 'string' || !/^(?:[0-9a-f]{64}|0000000000000000)$/i.test(entry.prevHash)) return 'prevHash is invalid';
  if (typeof entry.hash !== 'string' || !/^[0-9a-f]{64}$/i.test(entry.hash)) return 'hash is invalid';
  if (typeof entry.signature !== 'string' || !/^[0-9a-f]{128}$/i.test(entry.signature)) return 'signature is invalid';
  return null;
}

function toIsoString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value as string);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toBundleResponse(row: Record<string, unknown>) {
  return {
    id: row['id'] as string,
    agentId: row['agent_id'] as string,
    grantId: row['grant_id'] as string,
    userId: row['user_id'] as string,
    scopes: row['scopes'] as string[],
    status: row['status'] as string,
    deviceId: row['device_id'] ?? null,
    devicePlatform: row['device_platform'] ?? null,
    offlineTTL: row['offline_ttl'] as string,
    offlineExpiresAt: toIsoString(row['offline_expires_at']),
    checkpointAt: toIsoString(row['checkpoint_at']),
    auditEntryCount: Number(row['audit_entry_count'] ?? 0),
    lastSyncAt: toIsoString(row['last_sync_at']),
    createdAt: toIsoString(row['created_at']),
    revokedAt: toIsoString(row['revoked_at']),
  };
}

export async function consentBundlesRoutes(app: FastifyInstance): Promise<void> {
  // POST /v1/consent-bundles — Issue offline consent bundle
  app.post<{ Body: CreateBundleBody }>(
    '/v1/consent-bundles',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = (request.body ?? {}) as Partial<CreateBundleBody>;
      const { agentId, userId, scopes } = body;
      const offlineTTL = body.offlineTTL ?? '72h';
      const offlineAuditKeyAlgorithm = body.offlineAuditKeyAlgorithm ?? 'Ed25519';
      const deviceId = body.deviceId ?? null;
      const devicePlatform = body.devicePlatform ?? null;
      const developerId = request.developer.id;

      // Validate required fields
      if (!agentId || !userId || !scopes || !Array.isArray(scopes) || scopes.length === 0) {
        return reply.status(400).send({
          message: 'agentId, userId, and non-empty scopes array are required',
          code: 'BAD_REQUEST',
          requestId: request.id,
        });
      }
      if (scopes.length > 100 || scopes.some((scope) => typeof scope !== 'string' || scope.length === 0 || scope.length > 256)) {
        return reply.status(400).send({
          message: 'scopes must contain 1 to 100 non-empty strings of at most 256 characters',
          code: 'BAD_REQUEST',
          requestId: request.id,
        });
      }
      if (offlineAuditKeyAlgorithm !== 'Ed25519') {
        return reply.status(400).send({
          message: 'offlineAuditKeyAlgorithm must be Ed25519',
          code: 'BAD_REQUEST',
          requestId: request.id,
        });
      }

      const sql = getSql();

      // Verify agent belongs to developer
      const agentRows = await sql`
        SELECT id, did, scopes FROM agents
        WHERE id = ${agentId} AND developer_id = ${developerId} AND status = 'active'
      `;
      const agent = agentRows[0];
      if (!agent) {
        return reply.status(404).send({
          message: 'Agent not found or not owned by developer',
          code: 'NOT_FOUND',
          requestId: request.id,
        });
      }

      const registeredScopes = agent['scopes'] as string[];
      const unsupportedScopes = scopes.filter((scope) => !registeredScopes.includes(scope));
      if (unsupportedScopes.length > 0) {
        return reply.status(422).send({
          message: `Scopes are not registered for this agent: ${unsupportedScopes.join(', ')}`,
          code: 'INVALID_SCOPES',
          requestId: request.id,
        });
      }

      // Parse TTL
      let offlineSeconds: number;
      try {
        offlineSeconds = parseExpiresIn(offlineTTL);
      } catch {
        return reply.status(400).send({
          message: `Invalid offlineTTL format: ${offlineTTL}`,
          code: 'INVALID_TTL',
          requestId: request.id,
        });
      }

      if (offlineSeconds > 7 * 24 * 60 * 60) {
        return reply.status(422).send({
          message: 'offlineTTL may not exceed 168 hours',
          code: 'INVALID_TTL',
          requestId: request.id,
        });
      }

      const now = new Date();
      const offlineExpiresAt = new Date(now.getTime() + offlineSeconds * 1000);
      const grantExpiresAt = offlineExpiresAt;

      // Create a grant for this bundle
      const grantId = newGrantId();
      const jti = newTokenId();
      const agentDid = agent['did'] as string;
      const expTimestamp = Math.floor(grantExpiresAt.getTime() / 1000);

      // Sign grant token
      const grantToken = await signGrantToken({
        sub: userId,
        agt: agentDid,
        dev: developerId,
        scp: scopes,
        jti,
        grnt: grantId,
        exp: expTimestamp,
      });

      // Build JWKS snapshot
      const jwksResult = await buildJwks();
      const jwksSnapshot = {
        keys: jwksResult.keys,
        fetchedAt: now.toISOString(),
        validUntil: offlineExpiresAt.toISOString(),
      };

      // Generate Ed25519 key pair for offline audit signing
      const auditKeyPair = await jose.generateKeyPair('EdDSA', {
        crv: 'Ed25519',
        extractable: true,
      });
      const auditPublicJwk = await jose.exportJWK(auditKeyPair.publicKey);
      const auditPublicPem = await jose.exportSPKI(auditKeyPair.publicKey);
      const auditPrivatePem = await jose.exportPKCS8(auditKeyPair.privateKey);

      const offlineAuditKey = {
        publicKey: auditPublicPem,
        privateKey: auditPrivatePem,
        algorithm: offlineAuditKeyAlgorithm,
      };

      const checkpointAt = now.getTime();
      const bundleId = newConsentBundleId();

      // Persist the grant, its issued token, and the bundle atomically. Earlier
      // versions omitted grant_tokens entirely, so the returned JWT was validly
      // signed but always failed active-token verification as not_found.
      await sql.begin(async (_tx) => {
        const tx = _tx as unknown as TxSql;
        await tx`
          INSERT INTO grants (id, agent_id, principal_id, developer_id, scopes, expires_at)
          VALUES (
            ${grantId},
            ${agentId},
            ${userId},
            ${developerId},
            ${scopes},
            ${grantExpiresAt}
          )
        `;
        await tx`
          INSERT INTO grant_tokens (jti, grant_id, expires_at)
          VALUES (${jti}, ${grantId}, ${grantExpiresAt})
        `;
        await tx`
          INSERT INTO consent_bundles (
            id, developer_id, agent_id, grant_id, user_id,
            scopes, audit_public_key, device_id, device_platform,
            offline_ttl, offline_expires_at, checkpoint_at, status
          )
          VALUES (
            ${bundleId}, ${developerId}, ${agentId}, ${grantId}, ${userId},
            ${scopes}, ${JSON.stringify(auditPublicJwk)},
            ${deviceId}, ${devicePlatform},
            ${offlineTTL}, ${offlineExpiresAt}, ${now}, 'active'
          )
        `;
      });

      // Emit event
      emitEvent(developerId, 'consent_bundle.created', {
        bundleId,
        agentId,
        grantId,
        userId,
      }).catch(() => {});

      const response = {
        bundleId,
        grantToken,
        jwksSnapshot,
        offlineAuditKey,
        checkpointAt,
        syncEndpoint: `${config.publicBaseUrl}/v1/audit/offline-sync`,
        offlineExpiresAt: offlineExpiresAt.toISOString(),
      };
      return reply.status(201).send({
        ...response,
        data: response,
      });
    },
  );

  // GET /v1/consent-bundles/:bundleId — Fetch one owned bundle
  app.get<{ Params: { bundleId: string } }>(
    '/v1/consent-bundles/:bundleId',
    async (request, reply) => {
      const sql = getSql();
      const rows = await sql`
        SELECT id, agent_id, grant_id, user_id, scopes, status,
               device_id, device_platform, offline_ttl, offline_expires_at,
               checkpoint_at, audit_entry_count, last_sync_at, created_at, revoked_at
        FROM consent_bundles
        WHERE id = ${request.params.bundleId}
          AND developer_id = ${request.developer.id}
      `;
      if (!rows[0]) {
        return reply.status(404).send({
          message: 'Bundle not found',
          code: 'NOT_FOUND',
          requestId: request.id,
        });
      }
      return reply.send(toBundleResponse(rows[0] as Record<string, unknown>));
    },
  );

  // GET /v1/consent-bundles/:bundleId/audit — List synced audit entries
  app.get<{ Params: { bundleId: string } }>(
    '/v1/consent-bundles/:bundleId/audit',
    async (request, reply) => {
      const sql = getSql();
      const owned = await sql`
        SELECT id FROM consent_bundles
        WHERE id = ${request.params.bundleId}
          AND developer_id = ${request.developer.id}
      `;
      if (!owned[0]) {
        return reply.status(404).send({
          message: 'Bundle not found',
          code: 'NOT_FOUND',
          requestId: request.id,
        });
      }

      const rows = await sql`
        SELECT id, seq, timestamp, action, agent_did, grant_id, scopes,
               result, metadata, prev_hash, hash, signature, synced_at
        FROM offline_audit_entries
        WHERE bundle_id = ${request.params.bundleId}
          AND developer_id = ${request.developer.id}
        ORDER BY seq ASC
        LIMIT 1000
      `;
      return reply.send({
        entries: (rows as Array<Record<string, unknown>>).map((row) => ({
          id: row['id'],
          seq: Number(row['seq']),
          timestamp: toIsoString(row['timestamp']),
          action: row['action'],
          agentDID: row['agent_did'],
          grantId: row['grant_id'],
          scopes: row['scopes'],
          result: row['result'],
          metadata: row['metadata'] ?? {},
          prevHash: row['prev_hash'],
          hash: row['hash'],
          signature: row['signature'],
          syncedAt: toIsoString(row['synced_at']),
        })),
      });
    },
  );

  // POST /v1/audit/offline-sync — Sync offline audit log entries
  app.post<{ Body: OfflineSyncBody }>(
    '/v1/audit/offline-sync',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = (request.body ?? {}) as Partial<OfflineSyncBody>;
      const { bundleId, entries } = body;
      const deviceId = body.deviceId ?? null;
      const developerId = request.developer.id;

      if (!bundleId) {
        return reply.status(400).send({
          message: 'bundleId is required',
          code: 'BAD_REQUEST',
          requestId: request.id,
        });
      }

      if (!entries || !Array.isArray(entries) || entries.length === 0) {
        return reply.status(400).send({
          message: 'entries array must be non-empty',
          code: 'BAD_REQUEST',
          requestId: request.id,
        });
      }
      if (entries.length > 1000) {
        return reply.status(413).send({
          message: 'A sync batch may contain at most 1000 entries',
          code: 'PAYLOAD_TOO_LARGE',
          requestId: request.id,
        });
      }

      const sql = getSql();

      // Fetch the signing key and identity constraints from an owned bundle.
      const bundleRows = await sql`
        SELECT cb.id, cb.grant_id, cb.scopes, cb.status, cb.audit_public_key,
               a.did AS agent_did
        FROM consent_bundles cb
        JOIN agents a ON a.id = cb.agent_id AND a.developer_id = cb.developer_id
        WHERE cb.id = ${bundleId} AND cb.developer_id = ${developerId}
      `;
      const bundle = bundleRows[0];
      if (!bundle) {
        return reply.status(404).send({
          message: 'Bundle not found',
          code: 'NOT_FOUND',
          requestId: request.id,
        });
      }

      const grantId = bundle['grant_id'] as string;
      const agentDid = bundle['agent_did'] as string;
      const bundleScopes = bundle['scopes'] as string[];
      const publicKey = bundle['audit_public_key'] as string | Record<string, unknown>;
      const errors: Array<{ seq: number | null; code: string; message: string }> = [];

      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index]!;
        const shapeError = offlineEntryShapeError(entry);
        if (shapeError) {
          errors.push({ seq: Number.isSafeInteger(entry.seq) ? entry.seq : null, code: 'INVALID_ENTRY', message: shapeError });
          continue;
        }
        if (entry.grantId !== grantId || entry.agentDID !== agentDid
          || entry.scopes.some((scope) => !bundleScopes.includes(scope))) {
          errors.push({ seq: entry.seq, code: 'BUNDLE_MISMATCH', message: 'Entry identity or scopes do not match the bundle' });
          continue;
        }
        const computed = computeOfflineAuditEntryHash(entry as Omit<SignedOfflineAuditEntry, 'hash' | 'signature'>);
        if (computed !== entry.hash) {
          errors.push({ seq: entry.seq, code: 'INVALID_HASH', message: 'Entry hash does not match its contents' });
          continue;
        }
        if (!verifyOfflineAuditEntrySignature(entry, publicKey)) {
          errors.push({ seq: entry.seq, code: 'INVALID_SIGNATURE', message: 'Entry signature is invalid' });
          continue;
        }
        if (index > 0) {
          const previous = entries[index - 1]!;
          if (entry.seq !== previous.seq + 1) {
            errors.push({ seq: entry.seq, code: 'SEQ_GAP', message: 'Sequence numbers must be consecutive' });
          } else if (entry.prevHash !== previous.hash) {
            errors.push({ seq: entry.seq, code: 'BROKEN_CHAIN', message: 'prevHash does not match the previous entry' });
          }
        }
      }

      if (errors.length > 0) {
        return reply.status(400).send({
          message: 'Offline audit batch failed integrity validation',
          code: 'INVALID_AUDIT_ENTRIES',
          requestId: request.id,
          errors,
        });
      }

      let accepted = 0;
      let inserted = 0;
      let persistenceErrors: Array<{ seq: number | null; code: string; message: string }> = [];
      let grantStatus: string | undefined;
      let revokedAt: unknown = null;

      // Lock the bundle while comparing sequence state and inserting. This
      // makes duplicate uploads idempotent even when two sync requests race.
      await sql.begin(async (_tx) => {
        const tx = _tx as unknown as TxSql;
        await tx`
          SELECT id FROM consent_bundles
          WHERE id = ${bundleId} AND developer_id = ${developerId}
          FOR UPDATE
        `;
        const lastRows = await tx`
          SELECT seq, hash
          FROM offline_audit_entries
          WHERE bundle_id = ${bundleId} AND developer_id = ${developerId}
          ORDER BY seq DESC
          LIMIT 1
        `;
        const sequenceValues = entries.map((entry) => entry.seq);
        const existingRows = await tx`
          SELECT seq, hash
          FROM offline_audit_entries
          WHERE bundle_id = ${bundleId}
            AND developer_id = ${developerId}
            AND seq = ANY(${sequenceValues})
        `;
        const existing = new Map(
          (existingRows as Array<Record<string, unknown>>)
            .map((row) => [Number(row['seq']), row['hash'] as string]),
        );
        const last = lastRows[0] as Record<string, unknown> | undefined;
        let nextSequence = last ? Number(last['seq']) + 1 : 1;
        let expectedPrevHash = last ? last['hash'] as string : OFFLINE_AUDIT_GENESIS_HASH;
        const newEntries: OfflineSyncEntry[] = [];

        for (const entry of entries) {
          const existingHash = existing.get(entry.seq);
          if (existingHash !== undefined) {
            if (existingHash !== entry.hash) {
              persistenceErrors.push({
                seq: entry.seq,
                code: 'DUPLICATE_SEQ',
                message: 'This sequence already exists with a different hash',
              });
            } else {
              accepted++;
            }
            continue;
          }
          if (entry.seq !== nextSequence) {
            persistenceErrors.push({ seq: entry.seq, code: 'SEQ_GAP', message: `Expected sequence ${nextSequence}` });
            continue;
          }
          if (entry.prevHash !== expectedPrevHash) {
            persistenceErrors.push({ seq: entry.seq, code: 'BROKEN_CHAIN', message: 'prevHash does not match the persisted chain' });
            continue;
          }
          newEntries.push(entry);
          accepted++;
          nextSequence++;
          expectedPrevHash = entry.hash;
        }

        if (persistenceErrors.length > 0) return;

        if (newEntries.length > 0) {
          const entryValues = newEntries.map((entry) => ({
            id: newOfflineAuditEntryId(),
            bundle_id: bundleId,
            developer_id: developerId,
            seq: entry.seq,
            timestamp: entry.timestamp,
            action: entry.action,
            agent_did: entry.agentDID,
            grant_id: entry.grantId,
            scopes: entry.scopes,
            result: entry.result,
            metadata: JSON.stringify(entry.metadata ?? {}),
            prev_hash: entry.prevHash,
            hash: entry.hash,
            signature: entry.signature,
            device_id: deviceId,
          }));
          await tx`
            INSERT INTO offline_audit_entries ${tx(entryValues,
              'id', 'bundle_id', 'developer_id', 'seq', 'timestamp',
              'action', 'agent_did', 'grant_id', 'scopes', 'result',
              'metadata', 'prev_hash', 'hash', 'signature', 'device_id',
            )}
          `;
          inserted = newEntries.length;
        }

        await tx`
          UPDATE consent_bundles
          SET last_sync_at = NOW(),
              audit_entry_count = COALESCE(audit_entry_count, 0) + ${inserted}
          WHERE id = ${bundleId} AND developer_id = ${developerId}
        `;
        const grantRows = await tx`
          SELECT status, revoked_at
          FROM grants
          WHERE id = ${grantId} AND developer_id = ${developerId}
        `;
        grantStatus = grantRows[0]?.['status'] as string | undefined;
        revokedAt = grantRows[0]?.['revoked_at'] ?? null;
      });

      if (persistenceErrors.length > 0) {
        return reply.status(409).send({
          message: 'Offline audit batch conflicts with the persisted chain',
          code: 'AUDIT_CHAIN_CONFLICT',
          requestId: request.id,
          errors: persistenceErrors,
        });
      }

      const revocationStatus = grantStatus === 'revoked' ? 'revoked' : 'valid';

      // Emit event
      emitEvent(developerId, 'consent_bundle.synced', {
        bundleId,
        accepted,
      }).catch(() => {});

      const response = {
        accepted,
        rejected: 0,
        revocationStatus,
        revokedAt,
        errors: [] as Array<unknown>,
        newBundle: null,
      };
      return reply.send({
        ...response,
        data: {
          ...response,
        },
      });
    },
  );

  // GET /v1/consent-bundles/:bundleId/revocation-status — Check revocation status
  app.get<{ Params: { bundleId: string } }>(
    '/v1/consent-bundles/:bundleId/revocation-status',
    { config: { rateLimit: { max: 100, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { bundleId } = request.params;
      const developerId = request.developer.id;
      const sql = getSql();

      const rows = await sql`
        SELECT cb.id, cb.status, cb.revoked_at, cb.revoked_by, cb.grant_id, cb.checkpoint_at,
               g.status AS grant_status
        FROM consent_bundles cb
        LEFT JOIN grants g ON g.id = cb.grant_id
        WHERE cb.id = ${bundleId} AND cb.developer_id = ${developerId}
      `;

      const bundle = rows[0];
      if (!bundle) {
        return reply.status(404).send({
          message: 'Bundle not found',
          code: 'NOT_FOUND',
          requestId: request.id,
        });
      }

      const bundleStatus = bundle['status'] as string;
      const grantRevoked = bundle['grant_status'] === 'revoked';
      const checkpointAt = bundle['checkpoint_at']
        ? new Date(bundle['checkpoint_at'] as string).getTime()
        : null;

      return reply.send({
        data: {
          bundleId,
          status: bundleStatus,
          revokedAt: bundle['revoked_at'] ?? null,
          revokedBy: bundle['revoked_by'] ?? null,
          grantRevoked,
          checkpointAt,
        },
      });
    },
  );

  // GET /v1/consent-bundles — List bundles for developer
  app.get(
    '/v1/consent-bundles',
    { config: { rateLimit: { max: 100, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const developerId = request.developer.id;
      const sql = getSql();
      const query = request.query as Record<string, string | undefined>;

      const status = query['status'];
      const agentId = query['agentId'];
      const requestedLimit = Number.parseInt(query['limit'] ?? '50', 10);
      const limit = Number.isFinite(requestedLimit)
        ? Math.min(Math.max(requestedLimit, 1), 100)
        : 50;
      const cursor = query['cursor'];

      if (cursor && Number.isNaN(Date.parse(cursor))) {
        return reply.status(400).send({
          message: 'cursor must be a valid date-time',
          code: 'BAD_REQUEST',
          requestId: request.id,
        });
      }

      const rows = await sql`
        SELECT id, agent_id, grant_id, user_id, scopes, status,
               device_id, device_platform, offline_ttl, offline_expires_at,
               checkpoint_at, audit_entry_count, last_sync_at, created_at, revoked_at
        FROM consent_bundles
        WHERE developer_id = ${developerId}
          ${status ? sql`AND status = ${status}` : sql``}
          ${agentId ? sql`AND agent_id = ${agentId}` : sql``}
          ${cursor ? sql`AND created_at < ${cursor}` : sql``}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;

      const bundles = (rows as Array<Record<string, unknown>>).map(toBundleResponse);

      const nextCursor = bundles.length === limit
        ? bundles[bundles.length - 1]!.createdAt
        : null;

      return reply.send({
        bundles,
        ...(nextCursor !== null ? { nextCursor } : {}),
      });
    },
  );

  // POST /v1/consent-bundles/:bundleId/refresh — Refresh an expiring bundle
  app.post<{ Params: { bundleId: string } }>(
    '/v1/consent-bundles/:bundleId/refresh',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { bundleId } = request.params;
      const developerId = request.developer.id;
      const sql = getSql();

      const rows = await sql`
        SELECT cb.id, cb.agent_id, cb.grant_id, cb.user_id, cb.scopes,
               cb.offline_ttl, cb.offline_expires_at, cb.status,
               a.did AS agent_did, g.status AS grant_status
        FROM consent_bundles cb
        JOIN agents a ON a.id = cb.agent_id AND a.developer_id = cb.developer_id
        JOIN grants g ON g.id = cb.grant_id AND g.developer_id = cb.developer_id
        WHERE cb.id = ${bundleId} AND cb.developer_id = ${developerId}
      `;

      const bundle = rows[0];
      if (!bundle) {
        return reply.status(404).send({
          message: 'Bundle not found',
          code: 'NOT_FOUND',
          requestId: request.id,
        });
      }

      if (bundle['status'] !== 'active') {
        return reply.status(409).send({
          message: 'Cannot refresh a non-active bundle',
          code: 'BUNDLE_REVOKED',
          requestId: request.id,
        });
      }
      if (new Date(bundle['offline_expires_at'] as string).getTime() <= Date.now()) {
        return reply.status(409).send({
          message: 'Cannot refresh an expired bundle',
          code: 'BUNDLE_EXPIRED',
          requestId: request.id,
        });
      }
      if (bundle['grant_status'] !== 'active') {
        return reply.status(409).send({
          message: 'Cannot refresh a bundle whose grant is not active',
          code: 'GRANT_INACTIVE',
          requestId: request.id,
        });
      }

      const offlineTTL = bundle['offline_ttl'] as string;
      const ttlSeconds = parseExpiresIn(offlineTTL);
      const now = new Date();
      const offlineExpiresAt = new Date(now.getTime() + ttlSeconds * 1000);
      const jti = newTokenId();
      const grantId = bundle['grant_id'] as string;
      const grantToken = await signGrantToken({
        sub: bundle['user_id'] as string,
        agt: bundle['agent_did'] as string,
        dev: developerId,
        scp: bundle['scopes'] as string[],
        jti,
        grnt: grantId,
        exp: Math.floor(offlineExpiresAt.getTime() / 1000),
      });

      const jwksSnapshot = {
        keys: (await buildJwks()).keys,
        fetchedAt: now.toISOString(),
        validUntil: offlineExpiresAt.toISOString(),
      };
      const auditKeyPair = await jose.generateKeyPair('EdDSA', {
        crv: 'Ed25519',
        extractable: true,
      });
      const auditPublicJwk = await jose.exportJWK(auditKeyPair.publicKey);
      const offlineAuditKey = {
        publicKey: await jose.exportSPKI(auditKeyPair.publicKey),
        privateKey: await jose.exportPKCS8(auditKeyPair.privateKey),
        algorithm: 'Ed25519',
      };

      try {
        await sql.begin(async (_tx) => {
          const tx = _tx as unknown as TxSql;
          // Re-check current state as guarded writes inside the transaction.
          // A revoke racing the earlier lookup must not be followed by a new
          // token/key being committed for the now-inactive bundle.
          const updatedBundles = await tx<{ id: string }[]>`
            UPDATE consent_bundles
            SET offline_expires_at = ${offlineExpiresAt},
                checkpoint_at = ${now},
                audit_public_key = ${JSON.stringify(auditPublicJwk)}
            WHERE id = ${bundleId}
              AND developer_id = ${developerId}
              AND status = 'active'
              AND offline_expires_at > NOW()
            RETURNING id
          `;
          if (!updatedBundles[0]) {
            throw new BundleRefreshRaceError('BUNDLE_INACTIVE');
          }

          const updatedGrants = await tx<{ id: string }[]>`
            UPDATE grants
            SET expires_at = ${offlineExpiresAt}
            WHERE id = ${grantId}
              AND developer_id = ${developerId}
              AND status = 'active'
            RETURNING id
          `;
          if (!updatedGrants[0]) {
            throw new BundleRefreshRaceError('GRANT_INACTIVE');
          }

          await tx`
            INSERT INTO grant_tokens (jti, grant_id, expires_at)
            VALUES (${jti}, ${grantId}, ${offlineExpiresAt})
          `;
        });
      } catch (error) {
        if (error instanceof BundleRefreshRaceError) {
          return reply.status(409).send({
            message: error.reason === 'GRANT_INACTIVE'
              ? 'Cannot refresh a bundle whose grant is not active'
              : 'Bundle state changed before it could be refreshed',
            code: error.reason,
            requestId: request.id,
          });
        }
        throw error;
      }

      const response = {
        bundleId,
        grantToken,
        jwksSnapshot,
        offlineAuditKey,
        offlineExpiresAt: offlineExpiresAt.toISOString(),
        checkpointAt: now.getTime(),
        syncEndpoint: `${config.publicBaseUrl}/v1/audit/offline-sync`,
      };
      return reply.send({
        ...response,
        data: response,
      });
    },
  );

  // POST /v1/consent-bundles/:bundleId/revoke — Revoke a bundle
  app.post<{ Params: { bundleId: string }; Body: { revokeGrant?: boolean } }>(
    '/v1/consent-bundles/:bundleId/revoke',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { bundleId } = request.params;
      const revokeGrant = request.body?.revokeGrant ?? false;
      const developerId = request.developer.id;
      const sql = getSql();

      const rows = await sql`
        SELECT id, status, grant_id, revoked_at FROM consent_bundles
        WHERE id = ${bundleId} AND developer_id = ${developerId}
      `;

      const bundle = rows[0];
      if (!bundle) {
        return reply.status(404).send({
          message: 'Bundle not found',
          code: 'NOT_FOUND',
          requestId: request.id,
        });
      }

      if (bundle['status'] === 'revoked') {
        const response = {
          bundleId,
          status: 'revoked',
          revokedAt: toIsoString(bundle['revoked_at']),
        };
        return reply.send({
          ...response,
          data: response,
        });
      }

      const revokedAt = new Date();

      await sql.begin(async (_tx) => {
        const tx = _tx as unknown as TxSql;
        await tx`
          UPDATE consent_bundles
          SET status = 'revoked', revoked_at = ${revokedAt}, revoked_by = ${developerId}
          WHERE id = ${bundleId} AND developer_id = ${developerId}
        `;

        if (revokeGrant) {
          const grantId = bundle['grant_id'] as string;
          await tx`
            UPDATE grants SET status = 'revoked', revoked_at = ${revokedAt}
            WHERE id = ${grantId} AND developer_id = ${developerId}
          `;
        }
      });

      // Emit event
      emitEvent(developerId, 'consent_bundle.revoked', {
        bundleId,
        revokeGrant,
      }).catch(() => {});

      const response = {
        bundleId,
        status: 'revoked',
        revokedAt: revokedAt.toISOString(),
      };
      return reply.send({
        ...response,
        data: response,
      });
    },
  );
}

class BundleRefreshRaceError extends Error {
  constructor(readonly reason: 'BUNDLE_INACTIVE' | 'GRANT_INACTIVE') {
    super(reason);
  }
}
