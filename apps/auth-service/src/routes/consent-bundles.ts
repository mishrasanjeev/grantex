import type { FastifyInstance } from 'fastify';
import * as jose from 'jose';
import { getSql } from '../db/client.js';
import { signGrantToken, buildJwks, parseExpiresIn } from '../lib/crypto.js';
import { newConsentBundleId, newGrantId, newTokenId, newOfflineAuditEntryId } from '../lib/ids.js';
import { emitEvent } from '../lib/events.js';
import { config } from '../config.js';

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

export async function consentBundlesRoutes(app: FastifyInstance): Promise<void> {
  // POST /v1/consent-bundles — Issue offline consent bundle
  app.post<{ Body: CreateBundleBody }>(
    '/v1/consent-bundles',
    async (request, reply) => {
      const { agentId, userId, scopes } = request.body;
      const offlineTTL = request.body.offlineTTL ?? '72h';
      const offlineAuditKeyAlgorithm = request.body.offlineAuditKeyAlgorithm ?? 'Ed25519';
      const deviceId = request.body.deviceId ?? null;
      const devicePlatform = request.body.devicePlatform ?? null;
      const developerId = request.developer.id;

      // Validate required fields
      if (!agentId || !userId || !scopes || !Array.isArray(scopes) || scopes.length === 0) {
        return reply.status(400).send({
          message: 'agentId, userId, and non-empty scopes array are required',
          code: 'BAD_REQUEST',
          requestId: request.id,
        });
      }

      const sql = getSql();

      // Verify agent belongs to developer
      const agentRows = await sql`
        SELECT id, did FROM agents
        WHERE id = ${agentId} AND developer_id = ${developerId}
      `;
      const agent = agentRows[0];
      if (!agent) {
        return reply.status(404).send({
          message: 'Agent not found or not owned by developer',
          code: 'NOT_FOUND',
          requestId: request.id,
        });
      }

      // Parse TTL
      let offlineSeconds: number;
      try {
        offlineSeconds = parseExpiresIn(offlineTTL);
      } catch {
        return reply.status(422).send({
          message: `Invalid offlineTTL format: ${offlineTTL}`,
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

      await sql`
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
      const auditKeyPair = await jose.generateKeyPair('EdDSA', { crv: 'Ed25519' });
      const auditPublicJwk = await jose.exportJWK(auditKeyPair.publicKey);
      const auditPrivateJwk = await jose.exportJWK(auditKeyPair.privateKey);

      const offlineAuditKey = {
        publicKey: auditPublicJwk,
        privateKey: auditPrivateJwk,
        algorithm: offlineAuditKeyAlgorithm,
      };

      const checkpointAt = Math.floor(offlineExpiresAt.getTime() / 1000);
      const bundleId = newConsentBundleId();

      // Insert consent bundle (columns match 025_consent_bundles.sql)
      await sql`
        INSERT INTO consent_bundles (
          id, developer_id, agent_id, grant_id, user_id,
          scopes, audit_public_key, device_id, device_platform,
          offline_ttl, offline_expires_at, checkpoint_at, status
        )
        VALUES (
          ${bundleId}, ${developerId}, ${agentId}, ${grantId}, ${userId},
          ${scopes}, ${JSON.stringify(auditPublicJwk)},
          ${deviceId}, ${devicePlatform},
          ${offlineTTL}, ${offlineExpiresAt}, NOW(), 'active'
        )
      `;

      // Emit event
      emitEvent(developerId, 'consent_bundle.created', {
        bundleId,
        agentId,
        grantId,
        userId,
      }).catch(() => {});

      return reply.status(201).send({
        data: {
          bundleId,
          grantToken,
          jwksSnapshot,
          offlineAuditKey,
          checkpointAt,
          syncEndpoint: `${config.jwtIssuer}/v1/audit/offline-sync`,
          offlineExpiresAt: offlineExpiresAt.toISOString(),
        },
      });
    },
  );

  // POST /v1/audit/offline-sync — Sync offline audit log entries
  app.post<{ Body: OfflineSyncBody }>(
    '/v1/audit/offline-sync',
    async (request, reply) => {
      const { bundleId, entries } = request.body;
      const deviceId = request.body.deviceId ?? null;
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

      const sql = getSql();

      // Validate bundle exists and belongs to developer
      const bundleRows = await sql`
        SELECT id, grant_id, status FROM consent_bundles
        WHERE id = ${bundleId} AND developer_id = ${developerId}
      `;
      const bundle = bundleRows[0];
      if (!bundle) {
        return reply.status(404).send({
          message: 'Bundle not found',
          code: 'NOT_FOUND',
          requestId: request.id,
        });
      }

      // Insert entries in batch
      const entryValues = entries.map((e) => ({
        id: newOfflineAuditEntryId(),
        bundle_id: bundleId,
        developer_id: developerId,
        seq: e.seq,
        timestamp: e.timestamp,
        action: e.action,
        agent_did: e.agentDID,
        grant_id: e.grantId,
        scopes: e.scopes,
        result: e.result,
        metadata: JSON.stringify(e.metadata ?? {}),
        prev_hash: e.prevHash,
        hash: e.hash,
        signature: e.signature,
        device_id: deviceId,
      }));

      await sql`
        INSERT INTO offline_audit_entries ${sql(entryValues,
          'id', 'bundle_id', 'developer_id', 'seq', 'timestamp',
          'action', 'agent_did', 'grant_id', 'scopes', 'result',
          'metadata', 'prev_hash', 'hash', 'signature', 'device_id',
        )}
      `;

      // Update bundle sync metadata
      await sql`
        UPDATE consent_bundles
        SET last_sync_at = NOW(),
            audit_entry_count = COALESCE(audit_entry_count, 0) + ${entries.length}
        WHERE id = ${bundleId}
      `;

      // Check if the grant associated with the bundle is revoked
      const grantId = bundle['grant_id'] as string;
      const grantRows = await sql`
        SELECT status FROM grants WHERE id = ${grantId}
      `;
      const grantStatus = grantRows[0]?.['status'] as string | undefined;
      const revocationStatus = grantStatus === 'revoked' ? 'revoked' : 'valid';

      // Emit event
      emitEvent(developerId, 'consent_bundle.synced', {
        bundleId,
        accepted: entries.length,
      }).catch(() => {});

      return reply.send({
        data: {
          accepted: entries.length,
          rejected: 0,
          revocationStatus,
          newBundle: null,
        },
      });
    },
  );

  // GET /v1/consent-bundles/:bundleId/revocation-status — Check revocation status
  app.get<{ Params: { bundleId: string } }>(
    '/v1/consent-bundles/:bundleId/revocation-status',
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
        ? Math.floor(new Date(bundle['checkpoint_at'] as string).getTime() / 1000)
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
    async (request, reply) => {
      const developerId = request.developer.id;
      const sql = getSql();
      const query = request.query as Record<string, string | undefined>;

      const status = query['status'];
      const agentId = query['agentId'];
      const limit = Math.min(parseInt(query['limit'] ?? '50', 10), 100);
      const cursor = query['cursor'];

      const rows = await sql`
        SELECT id, agent_id, grant_id, user_id, scopes, status,
               device_id, device_platform, offline_expires_at,
               audit_entry_count, last_sync_at, created_at
        FROM consent_bundles
        WHERE developer_id = ${developerId}
          ${status ? sql`AND status = ${status}` : sql``}
          ${agentId ? sql`AND agent_id = ${agentId}` : sql``}
          ${cursor ? sql`AND created_at < ${cursor}` : sql``}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;

      const bundles = rows.map((r) => ({
        bundleId: r['id'] as string,
        agentId: r['agent_id'] as string,
        grantId: r['grant_id'] as string,
        userId: r['user_id'] as string,
        scopes: r['scopes'] as string[],
        status: r['status'] as string,
        deviceId: r['device_id'] ?? null,
        devicePlatform: r['device_platform'] ?? null,
        offlineExpiresAt: r['offline_expires_at']
          ? (r['offline_expires_at'] as Date).toISOString()
          : null,
        auditEntryCount: r['audit_entry_count'] ?? 0,
        lastSyncAt: r['last_sync_at'] ?? null,
        createdAt: (r['created_at'] as Date).toISOString(),
      }));

      const nextCursor = bundles.length === limit
        ? bundles[bundles.length - 1]!.createdAt
        : null;

      return reply.send({
        data: {
          bundles,
          ...(nextCursor !== null ? { nextCursor } : {}),
        },
      });
    },
  );

  // POST /v1/consent-bundles/:bundleId/refresh — Refresh an expiring bundle
  app.post<{ Params: { bundleId: string } }>(
    '/v1/consent-bundles/:bundleId/refresh',
    async (request, reply) => {
      const { bundleId } = request.params;
      const developerId = request.developer.id;
      const sql = getSql();

      const rows = await sql`
        SELECT id, agent_id, grant_id, user_id, scopes, offline_ttl, status
        FROM consent_bundles
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

      if (bundle['status'] !== 'active') {
        return reply.status(400).send({
          message: 'Cannot refresh a non-active bundle',
          code: 'BAD_REQUEST',
          requestId: request.id,
        });
      }

      const offlineTTL = bundle['offline_ttl'] as string;
      const ttlSeconds = parseExpiresIn(offlineTTL);
      const offlineExpiresAt = new Date(Date.now() + ttlSeconds * 1000);

      const jwksSnapshot = {
        keys: (await buildJwks()).keys,
        fetchedAt: new Date().toISOString(),
        validUntil: new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString(),
      };

      await sql`
        UPDATE consent_bundles
        SET offline_expires_at = ${offlineExpiresAt},
            checkpoint_at = NOW()
        WHERE id = ${bundleId}
      `;

      return reply.send({
        bundleId,
        grantToken: null,
        jwksSnapshot,
        offlineExpiresAt: offlineExpiresAt.toISOString(),
        checkpointAt: Math.floor(Date.now() / 1000),
        syncEndpoint: `${config.jwtIssuer}/v1/audit/offline-sync`,
      });
    },
  );

  // POST /v1/consent-bundles/:bundleId/revoke — Revoke a bundle
  app.post<{ Params: { bundleId: string }; Body: { revokeGrant?: boolean } }>(
    '/v1/consent-bundles/:bundleId/revoke',
    async (request, reply) => {
      const { bundleId } = request.params;
      const revokeGrant = request.body?.revokeGrant ?? false;
      const developerId = request.developer.id;
      const sql = getSql();

      const rows = await sql`
        SELECT id, status, grant_id FROM consent_bundles
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
        return reply.send({
          data: { bundleId, status: 'revoked', revokedAt: new Date().toISOString() },
        });
      }

      const revokedAt = new Date();

      await sql`
        UPDATE consent_bundles
        SET status = 'revoked', revoked_at = ${revokedAt}, revoked_by = ${developerId}
        WHERE id = ${bundleId}
      `;

      if (revokeGrant) {
        const grantId = bundle['grant_id'] as string;
        await sql`
          UPDATE grants SET status = 'revoked', revoked_at = ${revokedAt}
          WHERE id = ${grantId} AND developer_id = ${developerId}
        `;
      }

      // Emit event
      emitEvent(developerId, 'consent_bundle.revoked', {
        bundleId,
        revokeGrant,
      }).catch(() => {});

      return reply.send({
        data: {
          bundleId,
          status: 'revoked',
          revokedAt: revokedAt.toISOString(),
        },
      });
    },
  );
}
