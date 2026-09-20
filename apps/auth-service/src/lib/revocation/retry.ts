/**
 * Retrying a transaction the database asked us to retry.
 *
 * A revocation competes with everything else touching `grants`: delegation,
 * token refresh, and — during a rolling deploy — the startup migrations, whose
 * `ALTER TABLE … IF NOT EXISTS` statements take a brief exclusive lock. Any of
 * those can end in `deadlock_detected` or `serialization_failure`, which
 * Postgres raises precisely because retrying is the correct response.
 *
 * Revocation is the one thing that must not quietly fail, so these are
 * retried rather than surfaced.
 */
import { logger, type AppLogger } from '../logger.js';

/** deadlock_detected, serialization_failure, lock_not_available. */
const RETRYABLE = new Set(['40P01', '40001', '55P03']);

export const MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 25;

function isRetryable(err: unknown): boolean {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' && RETRYABLE.has(code);
}

export async function withTransactionRetry<T>(
  what: string,
  run: () => Promise<T>,
  log: AppLogger = logger,
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await run();
    } catch (err) {
      attempt += 1;
      if (attempt >= MAX_ATTEMPTS || !isRetryable(err)) throw err;
      const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
      log.warn(
        { err, retry: what, attempt, delayMs: delay },
        'database asked for a retry; retrying rather than failing a revocation',
      );
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, delay);
        timer.unref?.();
      });
    }
  }
}
