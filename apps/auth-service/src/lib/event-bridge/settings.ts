/**
 * Event bridge settings (PRD G-6), read at request time so a deployment can
 * change them without a rebuild and tests can stub them.
 *
 * - EVENT_BRIDGE_ENABLED=true turns on source registration and ingestion
 *   (default off: every event bridge route answers 404).
 * - EVENT_BRIDGE_DEVELOPER_IDS, when set, limits the bridge to these
 *   developers (comma separated) for a staged per-tenant rollout.
 * - EVENT_BRIDGE_RATE_LIMIT_PER_MINUTE caps ingestion requests per source and
 *   client address (default 30000, room for a 500 events/second burst).
 */

export interface EventBridgeSettings {
  enabled: boolean;
  developerIds: ReadonlySet<string> | null;
  rateLimitPerMinute: number;
}

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  return parsed >= min && parsed <= max ? parsed : fallback;
}

export function eventBridgeSettings(env: NodeJS.ProcessEnv = process.env): EventBridgeSettings {
  const ids = (env['EVENT_BRIDGE_DEVELOPER_IDS'] ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  return {
    enabled: env['EVENT_BRIDGE_ENABLED'] === 'true',
    developerIds: ids.length > 0 ? new Set(ids) : null,
    rateLimitPerMinute: boundedInteger(env['EVENT_BRIDGE_RATE_LIMIT_PER_MINUTE'], 30_000, 1, 1_000_000),
  };
}

export function eventBridgeEnabledFor(settings: EventBridgeSettings, developerId: string): boolean {
  return settings.enabled && (settings.developerIds === null || settings.developerIds.has(developerId));
}
