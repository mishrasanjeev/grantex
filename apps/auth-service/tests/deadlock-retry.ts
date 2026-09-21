/**
 * Retry a Postgres integration fixture that lost a deadlock.
 *
 * Startup re-runs `ALTER TABLE … ADD COLUMN IF NOT EXISTS` on `grants`,
 * `auth_requests` and `audit_entries` (migrations 002, 018, 061, 089, 090,
 * 095, 098). Those statements take a brief `ACCESS EXCLUSIVE` lock, so a test
 * file doing ordinary work on those tables can be chosen as the victim when
 * another file's migration run overlaps it — the same hazard a rolling deploy
 * has in production, recorded as FINDINGS G-18. (G-17 is a different thing:
 * a catalogue query that saw another test's schema.)
 *
 * The product code retries these itself (`lib/revocation/retry.ts`); this is
 * the same courtesy for the test's own queries, so the suite measures the
 * behaviour under test rather than the migration runner.
 */
const DEADLOCK = '40P01';
const ATTEMPTS = 4;

export function isDeadlock(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === DEADLOCK;
}

export async function retryOnDeadlock<T>(run: () => Promise<T>): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await run();
    } catch (err) {
      attempt += 1;
      if (attempt >= ATTEMPTS || !isDeadlock(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }
}
