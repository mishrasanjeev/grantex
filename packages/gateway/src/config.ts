import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { GatewayConfig } from './types.js';
import { GatewayError } from './errors.js';
import { checkAudienceCheck, checkExpectedAudience, type AudienceCheck } from './audience.js';
import { checkDataRegionCheck, checkExpectedDataRegion, type DataRegionCheck } from './region.js';
import { checkCredentialReference, type CredentialReferenceCheck } from './credentials.js';

export function loadConfig(filePath: string): GatewayConfig {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    throw new GatewayError('CONFIG_NOT_FOUND', `Config file not found: ${filePath}`, 500);
  }

  let raw: unknown;
  try {
    raw = parseYaml(content);
  } catch {
    throw new GatewayError('CONFIG_INVALID', 'Failed to parse YAML config', 500);
  }

  return validateConfig(raw);
}

export function validateConfig(raw: unknown): GatewayConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new GatewayError('CONFIG_INVALID', 'Config must be an object', 500);
  }

  const obj = raw as Record<string, unknown>;
  if ('currentAuthority' in obj) {
    throw new GatewayError('CONFIG_INVALID', 'currentAuthority callbacks are programmatic only; use currentAuthorityCheck in YAML', 500);
  }
  if ('currentAuthorityCheck' in obj && typeof obj['currentAuthorityCheck'] !== 'boolean') {
    throw new GatewayError('CONFIG_INVALID', 'currentAuthorityCheck must be a boolean', 500);
  }
  if ('grantexBaseUrl' in obj && (typeof obj['grantexBaseUrl'] !== 'string' || !obj['grantexBaseUrl'])) {
    throw new GatewayError('CONFIG_INVALID', 'grantexBaseUrl must be a non-empty URL', 500);
  }
  for (const field of ['expectedPrincipalId', 'expectedAgentDid']) {
    if (field in obj && (typeof obj[field] !== 'string' || !obj[field])) {
      throw new GatewayError('CONFIG_INVALID', `${field} must be a non-empty string`, 500);
    }
  }

  if (typeof obj['upstream'] !== 'string' || !obj['upstream']) {
    throw new GatewayError('CONFIG_INVALID', 'Config must include a non-empty "upstream" URL', 500);
  }

  if (typeof obj['jwksUri'] !== 'string' || !obj['jwksUri']) {
    throw new GatewayError('CONFIG_INVALID', 'Config must include a non-empty "jwksUri"', 500);
  }

  const port = typeof obj['port'] === 'number' ? obj['port'] : 8080;

  // An invalid audience setting stops the gateway from starting rather than
  // being read as "no audience", which would accept tokens meant elsewhere.
  const audienceCheck: AudienceCheck = 'audienceCheck' in obj
    ? configValue(() => checkAudienceCheck(obj['audienceCheck']))
    : 'on';
  const audience = 'audience' in obj
    ? configValue(() => checkExpectedAudience(obj['audience'], audienceCheck))
    : undefined;
  const dataRegionCheck: DataRegionCheck = 'dataRegionCheck' in obj
    ? configValue(() => checkDataRegionCheck(obj['dataRegionCheck']))
    : 'off';
  const dataRegion = 'dataRegion' in obj
    ? configValue(() => checkExpectedDataRegion(obj['dataRegion'], dataRegionCheck))
    : undefined;

  if (!Array.isArray(obj['routes']) || obj['routes'].length === 0) {
    throw new GatewayError('CONFIG_INVALID', 'Config must include at least one route', 500);
  }

  const routes = obj['routes'].map((route: unknown, i: number) => {
    if (typeof route !== 'object' || route === null) {
      throw new GatewayError('CONFIG_INVALID', `Route ${i} must be an object`, 500);
    }
    const r = route as Record<string, unknown>;

    if (typeof r['path'] !== 'string' || !r['path']) {
      throw new GatewayError('CONFIG_INVALID', `Route ${i} must have a "path"`, 500);
    }

    if (!Array.isArray(r['methods']) || r['methods'].length === 0) {
      throw new GatewayError('CONFIG_INVALID', `Route ${i} must have at least one method`, 500);
    }

    const methods = r['methods'].map((m: unknown) => {
      if (typeof m !== 'string') {
        throw new GatewayError('CONFIG_INVALID', `Route ${i} methods must be strings`, 500);
      }
      return m.toUpperCase();
    });

    if (!Array.isArray(r['requiredScopes']) || r['requiredScopes'].length === 0) {
      throw new GatewayError('CONFIG_INVALID', `Route ${i} must have at least one requiredScope`, 500);
    }

    const requiredScopes = r['requiredScopes'].map((s: unknown) => {
      if (typeof s !== 'string') {
        throw new GatewayError('CONFIG_INVALID', `Route ${i} requiredScopes must be strings`, 500);
      }
      return s;
    });

    const routeAudience = 'audience' in r
      ? configValue(() => checkExpectedAudience(r['audience'], audienceCheck), `Route ${i}: `)
      : undefined;
    const routeDataRegion = 'dataRegion' in r
      ? configValue(() => checkExpectedDataRegion(r['dataRegion'], dataRegionCheck), `Route ${i}: `)
      : undefined;

    return {
      path: r['path'],
      methods,
      requiredScopes,
      ...(routeAudience !== undefined ? { audience: routeAudience } : {}),
      ...(routeDataRegion !== undefined ? { dataRegion: routeDataRegion } : {}),
    };
  });

  // Credentials by reference need the gateway's own key and the auth service to
  // redeem them with; a config that turns it on without them stops the gateway.
  const credentialReference: CredentialReferenceCheck | undefined = 'credentialReference' in obj
    ? configValue(() => checkCredentialReference(obj['credentialReference']))
    : undefined;
  if (credentialReference === 'on' && (typeof obj['grantexApiKey'] !== 'string' || !obj['grantexApiKey']
      || typeof obj['grantexBaseUrl'] !== 'string' || !obj['grantexBaseUrl'])) {
    throw new GatewayError('CONFIG_INVALID', 'credentialReference: on needs grantexApiKey and grantexBaseUrl', 500);
  }

  const upstreamHeaders = typeof obj['upstreamHeaders'] === 'object' && obj['upstreamHeaders'] !== null
    ? Object.fromEntries(
        Object.entries(obj['upstreamHeaders'] as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
      )
    : undefined;

  return {
    upstream: obj['upstream'] as string,
    jwksUri: obj['jwksUri'] as string,
    port,
    routes,
    ...('currentAuthorityCheck' in obj ? { currentAuthorityCheck: obj['currentAuthorityCheck'] as boolean } : {}),
    ...(typeof obj['grantexBaseUrl'] === 'string' ? { grantexBaseUrl: obj['grantexBaseUrl'] } : {}),
    ...(typeof obj['expectedPrincipalId'] === 'string' ? { expectedPrincipalId: obj['expectedPrincipalId'] } : {}),
    ...(typeof obj['expectedAgentDid'] === 'string' ? { expectedAgentDid: obj['expectedAgentDid'] } : {}),
    ...(upstreamHeaders !== undefined ? { upstreamHeaders } : {}),
    ...(typeof obj['grantexApiKey'] === 'string' ? { grantexApiKey: obj['grantexApiKey'] } : {}),
    ...(audience !== undefined ? { audience } : {}),
    ...('audienceCheck' in obj ? { audienceCheck } : {}),
    ...(dataRegion !== undefined ? { dataRegion } : {}),
    ...('dataRegionCheck' in obj ? { dataRegionCheck } : {}),
    ...(credentialReference !== undefined ? { credentialReference } : {}),
  };
}

function configValue<T>(read: () => T, prefix = ''): T {
  try {
    return read();
  } catch (err) {
    throw new GatewayError('CONFIG_INVALID', `${prefix}${err instanceof Error ? err.message : String(err)}`, 500);
  }
}
