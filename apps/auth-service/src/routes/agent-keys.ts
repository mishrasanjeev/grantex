// SPDX-License-Identifier: Apache-2.0
/**
 * Agent key history (PRD §5 Agent, §7 Keys, §8.8): the keys an agent holds,
 * proof that it holds them, rotation with an overlap, and compromise.
 *
 *   GET  /v1/agents/:id/keys                               the history, with whether each key is usable now
 *   POST /v1/agents/:id/keys                               add a pending key
 *   PUT  /v1/agents/:id/declared-rails                     the rails the agent declares (P-256 rule)
 *   POST /v1/agents/:id/keys/:thumbprint/challenge         a single-use nonce to sign
 *   POST /v1/agents/:id/keys/:thumbprint/prove             a JWS over the nonce; the key becomes active
 *   POST /v1/agents/:id/keys/:thumbprint/rotate            end the key after an overlap; needs an active replacement
 *   POST /v1/agents/:id/keys/:thumbprint/compromise        end the key now and revoke every grant bound to it
 *
 * Developer-authenticated, and only for the developer's own agents: every
 * statement is scoped by developer, and another developer's agent answers 404
 * exactly as a missing one does. spec/agent-keys.md is the normative text.
 *
 * Paths that still read the single registered key (agents.public_jwk and
 * key_thumbprint) are not switched to the history here. A compromise is the
 * exception, because leaving a compromised key registered would keep it
 * usable there: it moves the registered key to the newest active replacement
 * or, when there is none, clears it and suspends the agent.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { JWK } from 'jose';
import type postgres from 'postgres';
import { config } from '../config.js';
import { getSql, queries, type TxSql } from '../db/client.js';
import { publishLifecycleGrantRevocations, revokeAgentGrantsInTx } from '../lib/revoke.js';
import { validateAgentPublicJwk } from '../lib/agent-security.js';
import { appendPlatformAuditEntries, lockAuditChain } from '../lib/audit-chain.js';
import {
  CHALLENGE_TTL_SECONDS,
  KEY_PROOF_TYP,
  KeyProofError,
  MAX_LIVE_KEYS,
  MAX_ROTATION_OVERLAP_SECONDS,
  evaluateAgentKey,
  hashChallengeNonce,
  keyAlgorithm,
  newChallengeNonce,
  parseDeclaredRails,
  railAlgorithmError,
  requiresP256,
  verifyKeyPossessionProof,
  type AgentKeyStatus,
} from '../lib/registry/agent-keys.js';
import { JwkThumbprintError, jwkThumbprint } from '../lib/registry/jwk-thumbprint.js';
import { recordDpopPossession } from '../lib/registry/agent-key-mirror.js';
import { cascadeGrantAction } from '../lib/revocation/cascade.js';

type Row = Record<string, unknown>;

/** A base64url SHA-256 thumbprint: 32 octets, 43 characters. */
const THUMBPRINT = /^[A-Za-z0-9_-]{43}$/;
const MAX_REASON_LENGTH = 500;

/** Reserved (`grantex.`) audit actions, so a tenant cannot write one. */
export const AGENT_KEY_AUDIT_ACTIONS = {
  added: 'grantex.agent_key.added',
  proved: 'grantex.agent_key.proved',
  rotated: 'grantex.agent_key.rotated',
  compromised: 'grantex.agent_key.compromised',
  railsDeclared: 'grantex.agent.rails_declared',
} as const;

/** A refusal decided inside a transaction; throwing it rolls the transaction back. */
class KeyRouteError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

function send(reply: FastifyReply, request: FastifyRequest, error: KeyRouteError) {
  return reply.status(error.status).send({ message: error.message, code: error.code, requestId: request.id });
}

const notFound = () => new KeyRouteError(404, 'NOT_FOUND', 'Agent not found');
const keyNotFound = (what = 'Key') => new KeyRouteError(404, 'KEY_NOT_FOUND', `${what} not found for this agent`);

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return new Date(value as string).toISOString();
}

/**
 * The public shape of a key. `usable` is evaluated at the database's clock,
 * the clock that wrote valid_from and valid_to, so the overlap boundary is
 * never shifted by skew between the service and the database.
 */
function toKeyResponse(row: Row, at: unknown) {
  const evaluation = evaluateAgentKey({
    status: row['status'] as AgentKeyStatus,
    validFrom: new Date(row['valid_from'] as string),
    validTo: row['valid_to'] ? new Date(row['valid_to'] as string) : null,
    possessionProvedAt: row['possession_proved_at'] ? new Date(row['possession_proved_at'] as string) : null,
  }, new Date(at as string));
  return {
    thumbprint: row['thumbprint'],
    agentId: row['agent_id'],
    jwk: row['jwk'],
    alg: row['alg'],
    status: row['status'],
    validFrom: iso(row['valid_from']),
    validTo: iso(row['valid_to']),
    possessionProvedAt: iso(row['possession_proved_at']),
    rotatedFrom: row['rotated_from'] ?? null,
    createdAt: iso(row['created_at']),
    usable: evaluation.usable,
    ...(evaluation.usable ? {} : { denial: evaluation.denial }),
  };
}

/** The developer's own agent, optionally locked for the rest of the transaction. */
async function ownedAgent(
  tx: TxSql,
  agentId: string,
  developerId: string,
  lock: 'none' | 'share' | 'update' = 'none',
): Promise<Row> {
  const rows = lock === 'update'
    ? await tx`SELECT id, did, status, declared_rails, key_thumbprint, NOW() AS db_now FROM agents
               WHERE id = ${agentId} AND developer_id = ${developerId} FOR UPDATE`
    : lock === 'share'
      ? await tx`SELECT id, did, status, declared_rails, key_thumbprint, NOW() AS db_now FROM agents
                 WHERE id = ${agentId} AND developer_id = ${developerId} FOR SHARE`
      : await tx`SELECT id, did, status, declared_rails, key_thumbprint, NOW() AS db_now FROM agents
                 WHERE id = ${agentId} AND developer_id = ${developerId}`;
  const agent = rows[0];
  if (!agent) throw notFound();
  return agent;
}

async function lockedKey(tx: TxSql, agentId: string, thumbprint: string, what?: string): Promise<Row> {
  const rows = await tx`
    SELECT *, NOW() AS db_now FROM agent_keys
    WHERE thumbprint = ${thumbprint} AND agent_id = ${agentId}
    FOR UPDATE`;
  const key = rows[0];
  if (!key) throw keyNotFound(what);
  return key;
}

async function audit(tx: TxSql, developerId: string, agent: Row, action: string, metadata: Record<string, unknown>) {
  const head = await lockAuditChain(tx, developerId);
  await appendPlatformAuditEntries(tx, developerId, head, [{
    action,
    agentId: agent['id'] as string,
    agentDid: agent['did'] as string,
    metadata: { agent_id: agent['id'], ...metadata },
  }]);
}

function thumbprintParam(value: string): string {
  if (!THUMBPRINT.test(value)) {
    throw new KeyRouteError(400, 'BAD_REQUEST', 'thumbprint must be a base64url SHA-256 JWK thumbprint (RFC 7638)');
  }
  return value;
}

function bodyObject(body: unknown): Record<string, unknown> {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new KeyRouteError(400, 'BAD_REQUEST', 'body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

function isConstraint(error: unknown, code: string, constraint: string): boolean {
  return Boolean(error && typeof error === 'object'
    && (error as { code?: unknown }).code === code
    && (error as { constraint_name?: unknown }).constraint_name === constraint);
}

/** Run a handler, turning a KeyRouteError into its response. Anything else propagates (500). */
async function handle(request: FastifyRequest, reply: FastifyReply, run: () => Promise<unknown>) {
  try {
    return await run();
  } catch (error) {
    if (error instanceof KeyRouteError) return send(reply, request, error);
    throw error;
  }
}

type AgentParams = { Params: { id: string } };
type KeyParams = { Params: { id: string; thumbprint: string } };

export async function agentKeysRoutes(app: FastifyInstance): Promise<void> {
  app.get<AgentParams>('/v1/agents/:id/keys', async (request, reply) => handle(request, reply, async () => {
    const sql = getSql();
    const agent = await ownedAgent(queries(sql), request.params.id, request.developer.id);
    await recordDpopPossession(queries(sql), agent['id'] as string, request.developer.id);
    const rows = await sql<Row[]>`
      SELECT * FROM agent_keys WHERE agent_id = ${agent['id'] as string}
      ORDER BY created_at DESC, thumbprint`;
    return reply.send({
      agentId: agent['id'],
      declaredRails: agent['declared_rails'] ?? [],
      keys: rows.map((row) => toKeyResponse(row, agent['db_now'])),
    });
  }));

  app.put<AgentParams>('/v1/agents/:id/declared-rails', async (request, reply) => handle(request, reply, async () => {
    const body = bodyObject(request.body);
    let rails: string[];
    try {
      rails = parseDeclaredRails(body['declaredRails']);
    } catch (err) {
      throw new KeyRouteError(400, 'BAD_REQUEST', (err as Error).message);
    }
    const developerId = request.developer.id;
    await getSql().begin(async (raw) => {
      const tx = raw as unknown as TxSql;
      // FOR UPDATE: a key being added reads this row FOR SHARE (in the route
      // and in the agent_keys trigger), so the check below and a new key
      // cannot interleave.
      const agent = await ownedAgent(tx, request.params.id, developerId, 'update');
      if (requiresP256(rails)) {
        const offending = await tx<{ thumbprint: string; alg: string }[]>`
          SELECT thumbprint, alg FROM agent_keys
          WHERE agent_id = ${agent['id'] as string} AND alg <> 'ES256'
            AND (status IN ('pending', 'active') OR (status = 'rotated' AND valid_to > NOW()))
          ORDER BY created_at LIMIT 1`;
        if (offending[0]) {
          throw new KeyRouteError(409, 'KEY_ALGORITHM_NOT_ALLOWED',
            `${railAlgorithmError(rails, offending[0].alg)}; key ${offending[0].thumbprint} (${offending[0].alg}) must be compromised or rotated out first`);
        }
        // The registered key too, whatever its state in the history: the
        // token endpoints bind grants to it until they read the history
        // (FINDINGS G-85), so a key rotated out there still signs for the
        // agent. A key whose algorithm cannot be derived fails closed.
        const registered = await tx<{ thumbprint: string; alg: string | null }[]>`
          SELECT key_thumbprint AS thumbprint, grantex_agent_key_alg(public_jwk) AS alg FROM agents
          WHERE id = ${agent['id'] as string} AND key_thumbprint IS NOT NULL AND public_jwk IS NOT NULL`;
        if (registered[0] && registered[0].alg !== 'ES256') {
          const alg = registered[0].alg ?? 'unsupported';
          throw new KeyRouteError(409, 'KEY_ALGORITHM_NOT_ALLOWED',
            `${railAlgorithmError(rails, alg)}; the registered publicJwk ${registered[0].thumbprint} (${alg}) must be replaced with PATCH /v1/agents first`);
        }
      }
      await tx`UPDATE agents SET declared_rails = ${rails}, updated_at = NOW()
               WHERE id = ${agent['id'] as string} AND developer_id = ${developerId}`;
      await audit(tx, developerId, agent, AGENT_KEY_AUDIT_ACTIONS.railsDeclared, {
        declared_rails: rails, previous: agent['declared_rails'] ?? [],
      });
    });
    return reply.send({ agentId: request.params.id, declaredRails: rails });
  }));

  app.post<AgentParams>('/v1/agents/:id/keys', async (request, reply) => handle(request, reply, async () => {
    const body = bodyObject(request.body);
    let jwk: JWK;
    let thumbprint: string;
    try {
      const validated = await validateAgentPublicJwk(body['publicJwk']);
      jwk = validated.jwk;
      thumbprint = jwkThumbprint(jwk);
      // Two implementations of RFC 7638 over the same key. A disagreement
      // would split the key's identity between the history and the paths
      // that still read agents.key_thumbprint, so it is refused.
      if (thumbprint !== validated.thumbprint) {
        throw new KeyRouteError(400, 'BAD_REQUEST', 'publicJwk has no consistent RFC 7638 thumbprint');
      }
    } catch (err) {
      if (err instanceof KeyRouteError) throw err;
      if (err instanceof JwkThumbprintError) throw new KeyRouteError(400, 'BAD_REQUEST', err.message);
      throw new KeyRouteError(400, 'BAD_REQUEST', err instanceof Error ? err.message : 'publicJwk is invalid');
    }
    const alg = keyAlgorithm(jwk);
    const developerId = request.developer.id;

    let created: Row | undefined;
    try {
      await getSql().begin(async (raw) => {
        const tx = raw as unknown as TxSql;
        const agent = await ownedAgent(tx, request.params.id, developerId, 'share');
        const agentId = agent['id'] as string;
        const railError = railAlgorithmError((agent['declared_rails'] as string[] | null) ?? [], alg);
        if (railError) throw new KeyRouteError(400, 'KEY_ALGORITHM_NOT_ALLOWED', railError);

        const existing = await tx<{ agent_id: string; status: string }[]>`
          SELECT agent_id, status FROM agent_keys WHERE thumbprint = ${thumbprint}`;
        // Compromised keys outlive their agent (compromised_agent_keys), so a
        // key reported under a deleted agent is refused here too.
        const tombstone = await tx`SELECT 1 FROM compromised_agent_keys WHERE thumbprint = ${thumbprint}`;
        if (tombstone[0] || existing[0]?.status === 'compromised') {
          throw new KeyRouteError(409, 'key_not_active', 'This key was reported compromised and can never be registered again');
        }
        if (existing[0]) {
          if (existing[0].agent_id === agentId) {
            throw new KeyRouteError(409, 'KEY_ALREADY_REGISTERED', `This key is already in the agent's history (${existing[0].status})`);
          }
          throw new KeyRouteError(409, 'AGENT_KEY_CONFLICT', 'publicJwk is already registered to another Agent Client Instance');
        }
        const legacy = await tx`SELECT 1 FROM agents WHERE key_thumbprint = ${thumbprint} AND id <> ${agentId} LIMIT 1`;
        if (legacy[0]) {
          throw new KeyRouteError(409, 'AGENT_KEY_CONFLICT', 'publicJwk is already registered to another Agent Client Instance');
        }
        const live = await tx<{ count: number }[]>`
          SELECT COUNT(*)::int AS count FROM agent_keys
          WHERE agent_id = ${agentId}
            AND (status IN ('pending', 'active') OR (status = 'rotated' AND valid_to > NOW()))`;
        if ((live[0]?.count ?? 0) >= MAX_LIVE_KEYS) {
          throw new KeyRouteError(409, 'KEY_LIMIT_REACHED',
            `An agent may hold at most ${MAX_LIVE_KEYS} keys that are pending, active or within a rotation overlap`);
        }

        const rows = await tx<Row[]>`
          INSERT INTO agent_keys (thumbprint, agent_id, developer_id, jwk, alg, status)
          VALUES (${thumbprint}, ${agentId}, ${developerId}, ${tx.json(jwk as postgres.JSONValue)}, ${alg}, 'pending')
          RETURNING *, NOW() AS db_now`;
        created = rows[0];
        await audit(tx, developerId, agent, AGENT_KEY_AUDIT_ACTIONS.added, { thumbprint, alg });
      });
    } catch (error) {
      // A concurrent registration of the same key, decided by the primary key.
      if (isConstraint(error, '23505', 'agent_keys_pkey')) {
        throw new KeyRouteError(409, 'AGENT_KEY_CONFLICT', 'publicJwk is already registered to another Agent Client Instance');
      }
      // The trigger's P-256 rule, for a rails change that committed in between.
      if (isConstraint(error, '23514', 'chk_agent_keys_payments_rail_alg')) {
        throw new KeyRouteError(400, 'KEY_ALGORITHM_NOT_ALLOWED', railAlgorithmError(['ap2'], alg) ?? 'key algorithm not allowed');
      }
      // The trigger's tombstone, for a compromise that committed in between.
      if (isConstraint(error, '23514', 'chk_agent_keys_not_compromised')) {
        throw new KeyRouteError(409, 'key_not_active', 'This key was reported compromised and can never be registered again');
      }
      throw error;
    }
    if (!created) throw new Error('agent key insert returned no row');
    return reply.status(201).send(toKeyResponse(created, created['db_now']));
  }));

  app.post<KeyParams>('/v1/agents/:id/keys/:thumbprint/challenge', async (request, reply) => handle(request, reply, async () => {
    const thumbprint = thumbprintParam(request.params.thumbprint);
    const developerId = request.developer.id;
    const nonce = newChallengeNonce();
    let issued: { expires_at: unknown; alg: string; agentId: string } | undefined;
    await getSql().begin(async (raw) => {
      const tx = raw as unknown as TxSql;
      const agent = await ownedAgent(tx, request.params.id, developerId);
      const agentId = agent['id'] as string;
      const key = await lockedKey(tx, agentId, thumbprint);
      if (key['status'] === 'active') {
        throw new KeyRouteError(409, 'KEY_ALREADY_ACTIVE', 'Possession of this key is already proven');
      }
      if (key['status'] !== 'pending') {
        throw new KeyRouteError(409, 'key_not_active', `This key is ${key['status'] as string} and cannot be proven`);
      }
      // One outstanding challenge per key: a new one supersedes the last.
      await tx`DELETE FROM agent_key_challenges WHERE thumbprint = ${thumbprint} AND consumed_at IS NULL`;
      const rows = await tx<{ expires_at: unknown }[]>`
        INSERT INTO agent_key_challenges (nonce_hash, thumbprint, agent_id, expires_at)
        VALUES (${hashChallengeNonce(nonce)}, ${thumbprint}, ${agentId},
                NOW() + make_interval(secs => ${CHALLENGE_TTL_SECONDS}))
        RETURNING expires_at`;
      issued = { expires_at: rows[0]!.expires_at, alg: key['alg'] as string, agentId };
    });
    if (!issued) throw new Error('challenge insert returned no row');
    return reply.status(201).send({
      thumbprint,
      challenge: nonce,
      audience: config.jwtIssuer,
      subject: issued.agentId,
      typ: KEY_PROOF_TYP,
      alg: issued.alg,
      expiresAt: iso(issued.expires_at),
    });
  }));

  app.post<KeyParams>('/v1/agents/:id/keys/:thumbprint/prove', async (request, reply) => handle(request, reply, async () => {
    const thumbprint = thumbprintParam(request.params.thumbprint);
    const body = bodyObject(request.body);
    const proof = body['proof'];
    if (typeof proof !== 'string' || proof.length === 0) {
      throw new KeyRouteError(400, 'key_unproven', 'proof must be a compact JWS');
    }
    const developerId = request.developer.id;
    const sql = getSql();
    const agent = await ownedAgent(queries(sql), request.params.id, developerId);
    const agentId = agent['id'] as string;
    await recordDpopPossession(queries(sql), agentId, developerId);
    const keys = await sql<Row[]>`SELECT * FROM agent_keys WHERE thumbprint = ${thumbprint} AND agent_id = ${agentId}`;
    const key = keys[0];
    if (!key) throw keyNotFound();
    if (key['status'] !== 'pending' && key['status'] !== 'active') {
      throw new KeyRouteError(409, 'key_not_active', `This key is ${key['status'] as string} and cannot be proven`);
    }

    // The signature first, so only the key's holder can use up a challenge.
    let nonce: string;
    try {
      ({ nonce } = await verifyKeyPossessionProof(proof, {
        jwk: key['jwk'] as JWK, alg: key['alg'] as string, thumbprint,
      }, { audience: config.jwtIssuer, agentId }));
    } catch (err) {
      if (err instanceof KeyProofError) throw new KeyRouteError(400, err.code, err.message);
      throw err;
    }

    let proved: Row | undefined;
    await sql.begin(async (raw) => {
      const tx = raw as unknown as TxSql;
      const locked = await lockedKey(tx, agentId, thumbprint);
      if (locked['status'] !== 'pending' && locked['status'] !== 'active') {
        throw new KeyRouteError(409, 'key_not_active', `This key is ${locked['status'] as string} and cannot be proven`);
      }
      const nonceHash = hashChallengeNonce(nonce);
      // Single use, atomically: exactly one proof can move consumed_at from
      // NULL, and only before the challenge expires.
      const consumed = await tx`
        UPDATE agent_key_challenges SET consumed_at = NOW()
        WHERE nonce_hash = ${nonceHash} AND thumbprint = ${thumbprint} AND agent_id = ${agentId}
          AND consumed_at IS NULL AND expires_at > NOW()
        RETURNING nonce_hash`;
      if (!consumed[0]) {
        const known = await tx<{ consumed_at: unknown; expired: boolean }[]>`
          SELECT consumed_at, expires_at <= NOW() AS expired FROM agent_key_challenges
          WHERE nonce_hash = ${nonceHash} AND thumbprint = ${thumbprint} AND agent_id = ${agentId}`;
        const reason = !known[0]
          ? 'the proof nonce is not an outstanding challenge for this key'
          : known[0].consumed_at !== null
            ? 'the challenge was already used; request a new one'
            : 'the challenge expired; request a new one';
        throw new KeyRouteError(400, 'key_unproven', reason);
      }
      const rows = await tx<Row[]>`
        UPDATE agent_keys
        SET status = 'active', possession_proved_at = NOW(), updated_at = NOW()
        WHERE thumbprint = ${thumbprint} AND agent_id = ${agentId} AND status = 'pending'
        RETURNING *, NOW() AS db_now`;
      proved = rows[0] ?? locked;
      await audit(tx, developerId, agent, AGENT_KEY_AUDIT_ACTIONS.proved, { thumbprint, alg: locked['alg'] });
    });
    if (!proved) throw new Error('possession proof recorded no key');
    return reply.send(toKeyResponse(proved, proved['db_now']));
  }));

  app.post<KeyParams>('/v1/agents/:id/keys/:thumbprint/rotate', async (request, reply) => handle(request, reply, async () => {
    const thumbprint = thumbprintParam(request.params.thumbprint);
    const body = bodyObject(request.body);
    const replacementThumbprint = body['replacementThumbprint'];
    if (typeof replacementThumbprint !== 'string' || !THUMBPRINT.test(replacementThumbprint)) {
      throw new KeyRouteError(400, 'BAD_REQUEST', 'replacementThumbprint must be the thumbprint of an active key of this agent');
    }
    if (replacementThumbprint === thumbprint) {
      throw new KeyRouteError(400, 'BAD_REQUEST', 'a key cannot replace itself');
    }
    const requested = body['overlapSeconds'];
    if (requested !== undefined && (typeof requested !== 'number' || !Number.isSafeInteger(requested)
        || requested < 0 || requested > MAX_ROTATION_OVERLAP_SECONDS)) {
      throw new KeyRouteError(400, 'BAD_REQUEST', `overlapSeconds must be an integer from 0 to ${MAX_ROTATION_OVERLAP_SECONDS}`);
    }
    const overlapSeconds = (requested as number | undefined) ?? config.agentKeyRotationOverlapSeconds;
    const developerId = request.developer.id;

    let result: { rotated: Row; replacement: Row } | undefined;
    await getSql().begin(async (raw) => {
      const tx = raw as unknown as TxSql;
      const agent = await ownedAgent(tx, request.params.id, developerId, 'update');
      const agentId = agent['id'] as string;
      await recordDpopPossession(tx, agentId, developerId);
      const old = await lockedKey(tx, agentId, thumbprint);
      const replacement = await lockedKey(tx, agentId, replacementThumbprint, 'Replacement key');
      if (old['status'] !== 'active') {
        throw new KeyRouteError(409, 'key_not_active', `Only an active key can be rotated; this key is ${old['status'] as string}`);
      }
      if (replacement['status'] === 'pending' || replacement['possession_proved_at'] === null) {
        throw new KeyRouteError(409, 'key_unproven', 'The replacement key must be proven (active) before the rotation');
      }
      if (replacement['status'] !== 'active' || replacement['valid_to'] !== null) {
        throw new KeyRouteError(409, 'key_not_active', `The replacement key is ${replacement['status'] as string}`);
      }
      const rotatedRows = await tx<Row[]>`
        UPDATE agent_keys
        SET status = 'rotated', valid_to = NOW() + make_interval(secs => ${overlapSeconds}), updated_at = NOW()
        WHERE thumbprint = ${thumbprint} AND agent_id = ${agentId} AND status = 'active'
        RETURNING *, NOW() AS db_now`;
      const replacementRows = await tx<Row[]>`
        UPDATE agent_keys SET rotated_from = COALESCE(rotated_from, ${thumbprint}), updated_at = NOW()
        WHERE thumbprint = ${replacementThumbprint} AND agent_id = ${agentId}
        RETURNING *, NOW() AS db_now`;
      result = { rotated: rotatedRows[0]!, replacement: replacementRows[0]! };
      await audit(tx, developerId, agent, AGENT_KEY_AUDIT_ACTIONS.rotated, {
        thumbprint,
        replacement_thumbprint: replacementThumbprint,
        overlap_seconds: overlapSeconds,
        valid_to: iso(result.rotated['valid_to']),
      });
    });
    if (!result) throw new Error('rotation recorded no key');
    return reply.send({
      rotated: toKeyResponse(result.rotated, result.rotated['db_now']),
      replacement: toKeyResponse(result.replacement, result.replacement['db_now']),
    });
  }));

  app.post<KeyParams>('/v1/agents/:id/keys/:thumbprint/compromise', async (request, reply) => handle(request, reply, async () => {
    const thumbprint = thumbprintParam(request.params.thumbprint);
    const body = bodyObject(request.body);
    const reason = body['reason'];
    if (reason !== undefined && (typeof reason !== 'string' || reason.length > MAX_REASON_LENGTH)) {
      throw new KeyRouteError(400, 'BAD_REQUEST', `reason must be a string of at most ${MAX_REASON_LENGTH} characters`);
    }
    const developerId = request.developer.id;
    const sql = getSql();

    let outcome: {
      key: Row;
      agentId: string;
      alreadyCompromised: boolean;
      agentKey: 'promoted' | 'cleared' | 'unchanged';
      promotedThumbprint?: string;
      agentSuspended: boolean;
    } | undefined;
    let lifecycleRevokedRows: Record<string, unknown>[] = [];

    // Step 1: end the key and take it out of every place it could still be
    // used, in one transaction. The agent row is locked FOR UPDATE, which is
    // also the lock the code exchange takes (FOR UPDATE OF ar, a), so an
    // exchange either commits first, and its grant is found in step 2, or
    // runs after and finds its authorization denied.
    await sql.begin(async (raw) => {
      const tx = raw as unknown as TxSql;
      const agent = await ownedAgent(tx, request.params.id, developerId, 'update');
      const agentId = agent['id'] as string;
      await recordDpopPossession(tx, agentId, developerId);
      const key = await lockedKey(tx, agentId, thumbprint);
      const alreadyCompromised = key['status'] === 'compromised';
      let current = key;
      if (!alreadyCompromised) {
        const rows = await tx<Row[]>`
          UPDATE agent_keys
          SET status = 'compromised', valid_to = LEAST(COALESCE(valid_to, NOW()), NOW()), updated_at = NOW()
          WHERE thumbprint = ${thumbprint} AND agent_id = ${agentId}
          RETURNING *, NOW() AS db_now`;
        current = rows[0]!;
      }
      await tx`DELETE FROM agent_key_challenges WHERE thumbprint = ${thumbprint} AND consumed_at IS NULL`;
      // Authorizations bound to the key that have not become grants yet.
      await tx`
        UPDATE auth_requests SET status = 'denied'
        WHERE agent_id = ${agentId} AND developer_id = ${developerId}
          AND agent_key_thumbprint = ${thumbprint} AND status IN ('pending', 'approved')`;
      await tx`
        UPDATE oauth_par_requests SET status = 'denied'
        WHERE client_id = ${agentId} AND developer_id = ${developerId}
          AND dpop_jkt = ${thumbprint} AND status = 'pushed'`;

      let agentKey: 'promoted' | 'cleared' | 'unchanged' = 'unchanged';
      let promotedThumbprint: string | undefined;
      let agentSuspended = false;
      if (agent['key_thumbprint'] === thumbprint) {
        const candidates = await tx<Row[]>`
          SELECT thumbprint, jwk, possession_proved_at FROM agent_keys
          WHERE agent_id = ${agentId} AND thumbprint <> ${thumbprint}
            AND status = 'active' AND valid_to IS NULL AND possession_proved_at IS NOT NULL
          ORDER BY possession_proved_at DESC, thumbprint
          LIMIT 1`;
        const next = candidates[0];
        if (next) {
          await tx`
            UPDATE agents
            SET public_jwk = ${tx.json(next['jwk'] as postgres.JSONValue)},
                key_thumbprint = ${next['thumbprint'] as string},
                key_verified_thumbprint = ${next['thumbprint'] as string},
                key_verified_at = ${next['possession_proved_at'] as Date},
                updated_at = NOW()
            WHERE id = ${agentId} AND developer_id = ${developerId}`;
          agentKey = 'promoted';
          promotedThumbprint = next['thumbprint'] as string;
        } else {
          // No proven replacement. Clearing the key alone would let the
          // grantex-v1 paths issue unbound grants, so the agent is suspended
          // too: every issuance path refuses an inactive agent.
          await tx`
            UPDATE agents
            SET public_jwk = NULL, key_thumbprint = NULL,
                key_verified_thumbprint = NULL, key_verified_at = NULL,
                status = 'suspended', updated_at = NOW()
            WHERE id = ${agentId} AND developer_id = ${developerId}`;
          agentKey = 'cleared';
          agentSuspended = true;
        }
      }
      if (agentSuspended && config.agentLifecycleStatesEnabled) {
        lifecycleRevokedRows = await revokeAgentGrantsInTx(tx, agentId, developerId, false);
      }
      if (!alreadyCompromised) {
        await audit(tx, developerId, agent, AGENT_KEY_AUDIT_ACTIONS.compromised, {
          thumbprint,
          agent_key: agentKey,
          agent_suspended: agentSuspended,
          ...(promotedThumbprint !== undefined ? { promoted_thumbprint: promotedThumbprint } : {}),
          ...(typeof reason === 'string' ? { reason } : {}),
        });
      }
      outcome = {
        key: current, agentId, alreadyCompromised, agentKey, agentSuspended,
        ...(promotedThumbprint !== undefined ? { promotedThumbprint } : {}),
      };
    });
    if (!outcome) throw new Error('compromise recorded no key');
    if (config.agentLifecycleStatesEnabled) await publishLifecycleGrantRevocations(developerId, lifecycleRevokedRows);

    // Step 2: revoke every grant bound to the key (cnf.jkt), and everything
    // delegated beneath them, through the cascade. It runs on every call, so
    // a call that failed here after step 1 committed is completed by
    // reporting the compromise again. A failure propagates as a 500: the
    // caller must not read success while bound grants may still be active.
    //
    // The grants are looked up under the developer's cascade lock
    // (hashtextextended(developer_id, 4)), the lock POST /v1/grants/delegate
    // holds while it inserts a grant bound to the sub-agent's key. A
    // delegation holding it now, its grant not yet committed, is waited for,
    // and the query (its own statement, so its snapshot is taken after the
    // lock is granted) sees that grant. A delegation that takes the lock
    // after this lookup finds the key in compromised_agent_keys (step 1 has
    // committed) and issues nothing. Without the lock, the first case left a
    // live grant bound to the compromised key.
    const bound = await sql.begin(async (raw) => {
      const tx = raw as unknown as TxSql;
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${developerId}, 4))`;
      return tx<{ id: string }[]>`
        SELECT id FROM grants
        WHERE developer_id = ${developerId} AND agent_key_thumbprint = ${thumbprint}
          AND status IN ('active', 'suspended')`;
    });
    let grantsRevoked = lifecycleRevokedRows.length;
    if (bound.length > 0) {
      const cascade = await cascadeGrantAction(sql, {
        developerId,
        rootGrantIds: bound.map((row) => row.id),
        action: 'revoke',
        cause: 'api',
        reason: 'agent key compromised',
        context: { key_thumbprint: thumbprint, agent_id: outcome.agentId },
      });
      grantsRevoked += cascade.affected.length;
    }

    return reply.send({
      key: toKeyResponse(outcome.key, outcome.key['db_now']),
      grantsRevoked,
      alreadyCompromised: outcome.alreadyCompromised,
      agentKey: outcome.agentKey,
      ...(outcome.promotedThumbprint !== undefined ? { promotedThumbprint: outcome.promotedThumbprint } : {}),
      agentSuspended: outcome.agentSuspended,
    });
  }));
}
