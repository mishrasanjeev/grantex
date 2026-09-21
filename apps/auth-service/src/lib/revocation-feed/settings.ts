/**
 * Revocation feed settings (PRD G-6), read at request time so a deployment can
 * change them without a rebuild and tests can stub them.
 *
 * - REVOCATION_FEED_ENABLED=true turns on the feed endpoints (default off:
 *   they answer 404, and nothing else changes).
 * - REVOCATION_FEED_DEVELOPER_IDS limits them to these developers.
 * - REVOCATION_FEED_POLL_MS is how often an instance looks for new
 *   revocations when no notification arrives (default 500 ms).
 * - REVOCATION_FEED_SETTLE_SECONDS is how long a feed entry may still be
 *   uncommitted: the cursor never advances past entries younger than this, so
 *   a transaction that commits out of order is still delivered (default 15 s).
 * - REVOCATION_FEED_HEARTBEAT_MS is how often a live stream confirms it is up
 *   to date. A client that stops hearing heartbeats must fail closed, so this
 *   must stay well below its staleness bound (default 1 s).
 * - REVOCATION_FEED_MAX_CONNECTIONS is the streams one developer may hold on
 *   one instance (default 200).
 * - REVOCATION_FEED_RETENTION_HOURS is how long delivered entries are kept
 *   after they expire (default 48 h).
 */

export interface RevocationFeedSettings {
  enabled: boolean;
  developerIds: ReadonlySet<string> | null;
  pollMs: number;
  settleSeconds: number;
  heartbeatMs: number;
  maxConnections: number;
  retentionHours: number;
}

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  return parsed >= min && parsed <= max ? parsed : fallback;
}

export function revocationFeedSettings(env: NodeJS.ProcessEnv = process.env): RevocationFeedSettings {
  const ids = (env['REVOCATION_FEED_DEVELOPER_IDS'] ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  return {
    enabled: env['REVOCATION_FEED_ENABLED'] === 'true',
    developerIds: ids.length > 0 ? new Set(ids) : null,
    pollMs: boundedInteger(env['REVOCATION_FEED_POLL_MS'], 500, 50, 60_000),
    settleSeconds: boundedInteger(env['REVOCATION_FEED_SETTLE_SECONDS'], 15, 1, 3_600),
    heartbeatMs: boundedInteger(env['REVOCATION_FEED_HEARTBEAT_MS'], 1_000, 100, 30_000),
    maxConnections: boundedInteger(env['REVOCATION_FEED_MAX_CONNECTIONS'], 200, 1, 10_000),
    retentionHours: boundedInteger(env['REVOCATION_FEED_RETENTION_HOURS'], 48, 1, 8_760),
  };
}

export function revocationFeedEnabledFor(settings: RevocationFeedSettings, developerId: string): boolean {
  return settings.enabled && (settings.developerIds === null || settings.developerIds.has(developerId));
}
