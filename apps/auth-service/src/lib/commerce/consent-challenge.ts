import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import type postgres from 'postgres';
import { ulid } from 'ulid';
import { type TxSql } from '../../db/client.js';

type Sql = ReturnType<typeof postgres>;

export const CHALLENGE_TTL_SECONDS = 300;             // 5 minutes
export const CHALLENGE_DEFAULT_MAX_ATTEMPTS = 5;
export const CHALLENGE_CODE_LENGTH = 6;

export type DeliveryChannel = 'test_sink' | 'email_otp';

export interface CreateChallengeInput {
  tenantId: string;
  consentRecordId: string;
  consentRequestId: string;
  principalId: string;
  developerId: string;
}

export type ChallengeCreateResult =
  | {
      ok: true;
      challengeId: string;
      deliveryChannel: DeliveryChannel;
      expiresAt: string;
      /**
       * Raw challenge code, returned ONLY when
       * delivery_channel === 'test_sink' AND NODE_ENV === 'test'. This
       * is the vitest harness path; staging, preview, QA, development,
       * and production never see this field. Both gates are required
       * and re-checked at the route boundary so a misconfiguration in
       * either layer cannot leak the secret.
       */
      testOnlyCode?: string;
    }
  | {
      ok: false;
      reason: 'no_delivery_provider_configured' | 'active_challenge_exists';
    };

export type ChallengeVerifyResult =
  | { ok: true; challengeId: string; remainingAttempts: number }
  | { ok: false; reason: 'not_found' | 'expired' | 'invalid_code'; remainingAttempts?: number };

/**
 * Pick a delivery channel that we can actually deliver through. Fail
 * closed everywhere a real out-of-band delivery is not implemented:
 *
 *   - `test_sink` is selected ONLY when NODE_ENV === 'test'. It is the
 *     vitest harness path — the raw code is returned in the API
 *     response so test code can complete the verify step. Selecting
 *     this channel anywhere else (development, staging, preview,
 *     production) would mean a caller could obtain session + CSRF + the
 *     raw OTP and self-approve, which is the original P0 attack.
 *   - `email_otp` is reserved in the schema enum but DEFERRED in M2 —
 *     no real email delivery is wired up. Treating
 *     `COMMERCE_CONSENT_CHALLENGE_PROVIDER=email_otp` as functional
 *     would create a green-looking production where users are asked
 *     for a code that is never sent. M2 always fails closed for
 *     email_otp; M3 wires real delivery (verified-email lookup +
 *     existing lib/email.ts Resend integration) and flips this gate.
 */
function selectDeliveryChannel(): DeliveryChannel | null {
  const provider = process.env['COMMERCE_CONSENT_CHALLENGE_PROVIDER'];
  // Allow an explicit override only inside the test runner. The double
  // gate (`NODE_ENV === 'test'` AND explicit provider, OR NODE_ENV ===
  // 'test' as default) means no shared environment can accidentally
  // surface the test-sink channel.
  if (process.env['NODE_ENV'] === 'test') {
    if (provider === 'email_otp') {
      // Even tests can opt out of test_sink and exercise the
      // fail-closed email_otp path explicitly.
      return null;
    }
    return 'test_sink';
  }
  // Outside NODE_ENV='test': everything fails closed in M2.
  // M3 adds real email_otp delivery and changes this branch to:
  //   if (provider === 'email_otp' && verifiedEmailDeliveryConfigured())
  //     return 'email_otp';
  void provider;
  return null;
}

function sha256hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * Domain-separated challenge hash. Includes consent_request_id and
 * principal_id so a hash leaked from one challenge cannot be replayed
 * against another consent or principal.
 */
function hashChallengeCode(code: string, consentRequestId: string, principalId: string): string {
  return sha256hex(`commerce_consent_challenge:v1:${consentRequestId}:${principalId}:${code}`);
}

function generateNumericCode(): string {
  let s = '';
  for (let i = 0; i < CHALLENGE_CODE_LENGTH; i++) {
    s += String(randomInt(0, 10));
  }
  return s;
}

/**
 * Create a one-time challenge for the given consent + principal. Returns
 * the test_only_code only when NODE_ENV === 'test' AND
 * delivery_channel === 'test_sink' (the vitest harness path).
 * Development, staging, preview, and production never return the raw
 * code in the response — those environments fail closed with
 * `no_delivery_provider_configured` until M3 wires real delivery.
 */
export async function createChallenge(
  sql: Sql,
  input: CreateChallengeInput,
): Promise<ChallengeCreateResult> {
  const channel = selectDeliveryChannel();
  if (!channel) {
    return { ok: false, reason: 'no_delivery_provider_configured' };
  }
  const code = generateNumericCode();
  const challengeHash = hashChallengeCode(code, input.consentRequestId, input.principalId);
  const id = `ccch_${ulid()}`;
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_SECONDS * 1000);

  // Atomic: expire any active challenges for this (reqId, principalId)
  // first, then insert new. If the unique partial index would conflict
  // (concurrent creator), expire-and-retry once.
  try {
    await sql.begin(async (_tx) => {
      const tx = _tx as unknown as TxSql;
      await tx`
        UPDATE commerce_consent_challenges
           SET status = 'expired', updated_at = NOW()
         WHERE consent_request_id = ${input.consentRequestId}
           AND principal_id = ${input.principalId}
           AND status IN ('requested','verified')
      `;
      await tx`
        INSERT INTO commerce_consent_challenges (
          id, tenant_id, consent_record_id, consent_request_id,
          principal_id, developer_id, challenge_hash, delivery_channel,
          status, expires_at, max_attempts
        ) VALUES (
          ${id}, ${input.tenantId}, ${input.consentRecordId}, ${input.consentRequestId},
          ${input.principalId}, ${input.developerId}, ${challengeHash}, ${channel},
          'requested', ${expiresAt.toISOString()}, ${CHALLENGE_DEFAULT_MAX_ATTEMPTS}
        )
      `;
    });
  } catch (err) {
    // 23505 = unique_violation (rare race with concurrent creator).
    if ((err as { code?: string }).code === '23505') {
      return { ok: false, reason: 'active_challenge_exists' };
    }
    throw err;
  }

  const result: ChallengeCreateResult = {
    ok: true,
    challengeId: id,
    deliveryChannel: channel,
    expiresAt: expiresAt.toISOString(),
  };
  // Raw code disclosure is gated to NODE_ENV === 'test' only AND the
  // test_sink delivery channel. Both gates required. Anywhere outside
  // the vitest harness (development, staging, preview, production), no
  // raw code is ever returned in the response — the channel is null
  // upstream and we never reach this point.
  if (channel === 'test_sink' && process.env['NODE_ENV'] === 'test') {
    result.testOnlyCode = code;
  }
  return result;
}

interface ChallengeRow {
  id: string;
  tenant_id: string;
  consent_request_id: string;
  principal_id: string;
  challenge_hash: string;
  status: string;
  attempts_count: number;
  max_attempts: number;
  expires_at: Date | string;
}

/**
 * Verify a candidate code against the active challenge for
 * (consent_request_id, principal_id). Increments attempts; expires the
 * challenge when attempts reach max. Constant-time hash compare. On
 * success, marks status='verified' (still single-use until consumed by
 * approve/deny).
 */
export async function verifyChallenge(
  sql: Sql,
  input: { consentRequestId: string; principalId: string; code: string },
): Promise<ChallengeVerifyResult> {
  const expectedHash = hashChallengeCode(input.code, input.consentRequestId, input.principalId);

  return await sql.begin(async (_tx) => {
    const tx = _tx as unknown as TxSql;
    const rows = await tx<ChallengeRow[]>`
      SELECT id, tenant_id, consent_request_id, principal_id, challenge_hash,
             status, attempts_count, max_attempts, expires_at
        FROM commerce_consent_challenges
       WHERE consent_request_id = ${input.consentRequestId}
         AND principal_id = ${input.principalId}
         AND status IN ('requested','verified')
       FOR UPDATE
    `;
    const row = rows[0];
    if (!row) return { ok: false as const, reason: 'not_found' as const };

    const expiresAt = row.expires_at instanceof Date
      ? row.expires_at
      : new Date(row.expires_at);
    if (expiresAt.getTime() < Date.now()) {
      await tx`
        UPDATE commerce_consent_challenges
           SET status = 'expired', updated_at = NOW()
         WHERE id = ${row.id}
      `;
      return { ok: false as const, reason: 'expired' as const };
    }

    // Already-verified challenges should not be re-verified — caller
    // should proceed straight to approve/deny. Treat re-submit as a
    // no-op success (idempotent) so a network retry doesn't burn the
    // verification.
    if (row.status === 'verified') {
      return {
        ok: true as const,
        challengeId: row.id,
        remainingAttempts: row.max_attempts - row.attempts_count,
      };
    }

    const attempts = row.attempts_count + 1;
    const a = Buffer.from(expectedHash, 'hex');
    const b = Buffer.from(row.challenge_hash, 'hex');
    const codeMatches = a.length === b.length && timingSafeEqual(a, b);

    if (codeMatches) {
      await tx`
        UPDATE commerce_consent_challenges
           SET status = 'verified', verified_at = NOW(),
               attempts_count = ${attempts}, updated_at = NOW()
         WHERE id = ${row.id}
      `;
      return {
        ok: true as const,
        challengeId: row.id,
        remainingAttempts: row.max_attempts - attempts,
      };
    }

    // Wrong code; bump attempts. Expire if over the cap.
    if (attempts >= row.max_attempts) {
      await tx`
        UPDATE commerce_consent_challenges
           SET status = 'expired', attempts_count = ${attempts}, updated_at = NOW()
         WHERE id = ${row.id}
      `;
      return { ok: false as const, reason: 'expired' as const, remainingAttempts: 0 };
    }
    await tx`
      UPDATE commerce_consent_challenges
         SET attempts_count = ${attempts}, updated_at = NOW()
       WHERE id = ${row.id}
    `;
    return {
      ok: false as const,
      reason: 'invalid_code' as const,
      remainingAttempts: row.max_attempts - attempts,
    };
  });
}

/**
 * Atomic SELECT FOR UPDATE + UPDATE that consumes a verified challenge.
 * Run inside the same sql.begin() block as the consent state transition
 * so approve/deny + challenge consumption are one atomic unit.
 *
 * Returns true when a verified challenge was consumed. Returns false
 * when no verified challenge exists for (consent_request_id,
 * principal_id) — the route MUST then refuse the decision.
 */
export async function consumeVerifiedChallengeTx(
  tx: TxSql,
  input: { consentRequestId: string; principalId: string },
): Promise<{ consumed: true; challengeId: string } | { consumed: false }> {
  const rows = await tx<{ id: string; expires_at: Date | string }[]>`
    SELECT id, expires_at FROM commerce_consent_challenges
     WHERE consent_request_id = ${input.consentRequestId}
       AND principal_id = ${input.principalId}
       AND status = 'verified'
     FOR UPDATE
  `;
  const row = rows[0];
  if (!row) return { consumed: false };
  const expiresAt = row.expires_at instanceof Date
    ? row.expires_at
    : new Date(row.expires_at);
  if (expiresAt.getTime() < Date.now()) {
    await tx`UPDATE commerce_consent_challenges SET status = 'expired', updated_at = NOW() WHERE id = ${row.id}`;
    return { consumed: false };
  }
  await tx`
    UPDATE commerce_consent_challenges
       SET status = 'used', used_at = NOW(), updated_at = NOW()
     WHERE id = ${row.id}
  `;
  return { consumed: true, challengeId: row.id };
}

/**
 * Read-only check used by the page renderer to decide whether to show
 * the "enter code" form vs the approve/deny forms. Returns the current
 * status without mutating; route handlers that need to consume use
 * consumeVerifiedChallengeTx.
 *
 * P2 fix: filters out rows past `expires_at`. Without this, a verified
 * challenge that has expired would still cause the page to render the
 * approve/deny forms — only for the decision POST to fail downstream
 * with a confusing `challenge_required`. Stale rows get cleaned up by
 * the next createChallenge (its expire-then-insert path); we don't
 * mutate here because the renderer must remain a pure read.
 */
export async function findActiveChallenge(
  sql: Sql,
  input: { consentRequestId: string; principalId: string },
): Promise<{ id: string; status: 'requested' | 'verified'; expiresAt: string } | null> {
  const rows = await sql<{ id: string; status: string; expires_at: Date | string }[]>`
    SELECT id, status, expires_at
      FROM commerce_consent_challenges
     WHERE consent_request_id = ${input.consentRequestId}
       AND principal_id = ${input.principalId}
       AND status IN ('requested','verified')
       AND expires_at > NOW()
     LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  const exp = row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at);
  return {
    id: row.id,
    status: row.status as 'requested' | 'verified',
    expiresAt: exp.toISOString(),
  };
}

/**
 * Predicate version of selectDeliveryChannel — true iff
 * createChallenge would succeed in this environment with the current
 * provider configuration. Page renderer uses this to choose between
 * `challenge_request` and `challenge_unavailable` without trying to
 * create a challenge.
 */
export function isChallengeProviderAvailable(): boolean {
  return selectDeliveryChannel() !== null;
}

export const _internal = {
  hashChallengeCode,
  selectDeliveryChannel,
};
