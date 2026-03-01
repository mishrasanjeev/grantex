import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { GatewayConfig } from './types.js';
import { GatewayError } from './errors.js';

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

  if (typeof obj['upstream'] !== 'string' || !obj['upstream']) {
    throw new GatewayError('CONFIG_INVALID', 'Config must include a non-empty "upstream" URL', 500);
  }

  if (typeof obj['jwksUri'] !== 'string' || !obj['jwksUri']) {
    throw new GatewayError('CONFIG_INVALID', 'Config must include a non-empty "jwksUri"', 500);
  }

  const port = typeof obj['port'] === 'number' ? obj['port'] : 8080;

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

    return { path: r['path'], methods, requiredScopes };
  });

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
    ...(upstreamHeaders !== undefined ? { upstreamHeaders } : {}),
    ...(typeof obj['grantexApiKey'] === 'string' ? { grantexApiKey: obj['grantexApiKey'] } : {}),
  };
}
