// SPDX-License-Identifier: Apache-2.0
/**
 * The agent key history mirror (PRD §7 Keys, §8.8), behind
 * AGENT_KEY_HISTORY_MIRROR_ENABLED (default off).
 *
 * POST and PATCH /v1/agents write one registered key (agents.public_jwk and
 * key_thumbprint). With the flag on, they call this in the same transaction
 * as that write, so the key also enters agent_keys and the history is
 * complete whichever route wrote it. With the flag off it is never called and
 * those routes behave exactly as they did before the history existed: keys
 * they write are not in the history, and they refuse nothing the history
 * would. spec/agent-keys.md §4 describes both states.
 *
 * What the mirror does, in the order it decides it:
 *
 *   - a key reported compromised (compromised_agent_keys) is refused, even
 *     after the agent that held it was deleted;
 *   - a key another agent holds in its history (pending, active, or rotated
 *     and still in its overlap) is refused as AGENT_KEY_CONFLICT, the answer
 *     these routes already give for a key another agent has registered;
 *   - a key this agent held before and rotated out becomes pending again: it
 *     was registered again, so it has to be proven again;
 *   - a key another agent replaced and no longer uses moves to this agent,
 *     pending, as the agents index has always allowed;
 *   - any other key is added, pending;
 *   - the key it replaces (PATCH) ends at once: rotated, valid_to now.
 *
 * The P-256 rule for payments rails and the compromise tombstone are also
 * enforced by the agent_keys triggers of migration 122; a refusal from them
 * is turned into the same answer as the checks here.
 */
import type { JWK } from 'jose';
import type postgres from 'postgres';
import type { TxSql } from '../../db/client.js';
import { keyAlgorithm, railAlgorithmError } from './agent-keys.js';

/** A write the mirror refuses. Thrown inside the caller's transaction, so the agent write rolls back too. */
export class AgentKeyMirrorRefusal extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'AgentKeyMirrorRefusal';
  }
}

const conflict = () => new AgentKeyMirrorRefusal(
  409, 'AGENT_KEY_CONFLICT', 'publicJwk is already registered to another Agent Client Instance');
const compromised = () => new AgentKeyMirrorRefusal(
  409, 'key_not_active', 'publicJwk was reported compromised and can never be registered again');
const railRefusal = (message: string) => new AgentKeyMirrorRefusal(400, 'KEY_ALGORITHM_NOT_ALLOWED', message);

function constraintOf(error: unknown): { code: unknown; constraint: unknown } | null {
  if (!error || typeof error !== 'object') return null;
  return {
    code: (error as { code?: unknown }).code,
    constraint: (error as { constraint_name?: unknown }).constraint_name,
  };
}

/** A database refusal from the agent_keys constraints and triggers, as the mirror's own answer. */
export function mirrorRefusalFromDatabase(error: unknown): AgentKeyMirrorRefusal | null {
  const found = constraintOf(error);
  if (!found) return null;
  // The same key written to the history by a concurrent request.
  if (found.code === '23505' && found.constraint === 'agent_keys_pkey') return conflict();
  if (found.code === '23514' && found.constraint === 'chk_agent_keys_not_compromised') return compromised();
  if (found.code === '23514' && found.constraint === 'chk_agent_keys_payments_rail_alg') {
    return railRefusal(railAlgorithmError(['ap2'], 'unsupported') ?? 'key algorithm not allowed');
  }
  return null;
}

export interface RegisteredKeyWrite {
  agentId: string;
  developerId: string;
  /** The key the agent row now holds, or null when it holds none. */
  jwk: JWK | null;
  thumbprint: string | null;
  /** The key the agent row held before this write (null for a new agent). */
  previousThumbprint: string | null;
}

/**
 * Mirror a registered-key write into agent_keys. Call it in the transaction
 * that wrote the agent row, after that write, with the agent row locked.
 */
export async function mirrorRegisteredAgentKey(tx: TxSql, write: RegisteredKeyWrite): Promise<void> {
  try {
    await mirror(tx, write);
  } catch (error) {
    const refusal = mirrorRefusalFromDatabase(error);
    if (refusal) throw refusal;
    throw error;
  }
}

async function mirror(tx: TxSql, write: RegisteredKeyWrite): Promise<void> {
  const { agentId, developerId, jwk, thumbprint, previousThumbprint } = write;

  if (thumbprint !== null && jwk !== null && thumbprint !== previousThumbprint) {
    let alg: string;
    try {
      alg = keyAlgorithm(jwk);
    } catch {
      // The routes validate the key first, so this cannot happen; if it did,
      // the key could not be tracked, and it is refused rather than left out
      // of the history.
      throw new AgentKeyMirrorRefusal(400, 'BAD_REQUEST', 'publicJwk has no supported algorithm');
    }

    const agents = await tx<{ declared_rails: string[] | null }[]>`
      SELECT declared_rails FROM agents WHERE id = ${agentId} AND developer_id = ${developerId}`;
    const railError = railAlgorithmError(agents[0]?.declared_rails ?? [], alg);
    if (railError) throw railRefusal(railError);

    const tombstone = await tx`SELECT 1 FROM compromised_agent_keys WHERE thumbprint = ${thumbprint}`;
    if (tombstone[0]) throw compromised();

    const existing = await tx<{ agent_id: string; status: string; in_overlap: boolean }[]>`
      SELECT agent_id, status, COALESCE(valid_to > NOW(), FALSE) AS in_overlap
      FROM agent_keys WHERE thumbprint = ${thumbprint}
      FOR UPDATE`;
    const held = existing[0];
    if (held) {
      if (held.status === 'compromised') throw compromised();
      if (held.agent_id === agentId) {
        if (held.status === 'rotated') {
          await tx`
            UPDATE agent_keys
               SET status = 'pending', valid_from = NOW(), valid_to = NULL,
                   possession_proved_at = NULL, updated_at = NOW()
             WHERE thumbprint = ${thumbprint}`;
        }
      } else if (held.status === 'pending' || held.status === 'active' || held.in_overlap) {
        throw conflict();
      } else {
        await tx`DELETE FROM agent_key_challenges WHERE thumbprint = ${thumbprint}`;
        await tx`
          UPDATE agent_keys
             SET agent_id = ${agentId}, developer_id = ${developerId}, jwk = ${tx.json(jwk as postgres.JSONValue)},
                 alg = ${alg}, status = 'pending', valid_from = NOW(), valid_to = NULL,
                 possession_proved_at = NULL, rotated_from = NULL, updated_at = NOW()
           WHERE thumbprint = ${thumbprint}`;
      }
    } else {
      await tx`
        INSERT INTO agent_keys (thumbprint, agent_id, developer_id, jwk, alg, status)
        VALUES (${thumbprint}, ${agentId}, ${developerId}, ${tx.json(jwk as postgres.JSONValue)}, ${alg}, 'pending')`;
    }
  }

  // PATCH /v1/agents replaces the key at once: the old one ends now.
  if (previousThumbprint !== null && previousThumbprint !== thumbprint) {
    await tx`
      UPDATE agent_keys
         SET status = 'rotated', valid_to = NOW(), updated_at = NOW()
       WHERE thumbprint = ${previousThumbprint} AND agent_id = ${agentId}
         AND status IN ('pending', 'active')`;
  }
}

/**
 * Record a DPoP proof of the registered key as a possession proof (owner
 * decision 12). The token endpoints verify DPoP proofs of agents.public_jwk
 * and record them in agents.key_verified_thumbprint and key_verified_at; the
 * key routes call this before they read an agent's history, so a pending
 * history entry for that key reads as active from then on. Nothing on the
 * token endpoints changes: they write only the columns they always wrote.
 */
export async function recordDpopPossession(tx: TxSql, agentId: string, developerId: string): Promise<void> {
  await tx`
    UPDATE agent_keys k
       SET status = 'active', possession_proved_at = a.key_verified_at, updated_at = NOW()
      FROM agents a
     WHERE a.id = ${agentId} AND a.developer_id = ${developerId}
       AND k.agent_id = a.id AND k.status = 'pending'
       AND a.key_verified_thumbprint IS NOT NULL
       AND a.key_verified_thumbprint = a.key_thumbprint
       AND a.key_verified_at IS NOT NULL
       AND k.thumbprint = a.key_verified_thumbprint`;
}
