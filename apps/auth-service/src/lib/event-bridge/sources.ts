/**
 * Event source registration: per-developer SSF transmitters and signed
 * webhook senders. Webhook secrets are generated here, returned once, and
 * stored encrypted and bound to the source id.
 */
import { randomBytes } from 'node:crypto';
import type postgres from 'postgres';
import { ulid } from 'ulid';
import { config } from '../../config.js';
import { decryptWithContext, encryptWithContext } from '../vault-crypto.js';
import { validateOutboundUrl } from '../url-security.js';
import { jwksUriPolicy, validatePublicJwks } from './keys.js';
import { isPlainObject, type EventSourceKind } from './normalize.js';
import { SET_ALGORITHMS } from './set-verify.js';

type Sql = ReturnType<typeof postgres>;

export const MAX_SOURCES_PER_DEVELOPER = 50;
export const DEFAULT_PREVIOUS_SECRET_TTL_SECONDS = 86_400;
export const MAX_PREVIOUS_SECRET_TTL_SECONDS = 7 * 86_400;

export interface EventSourceRow {
  id: string;
  developer_id: string;
  kind: EventSourceKind;
  name: string;
  status: 'active' | 'disabled';
  issuer: string | null;
  audience: string | null;
  jwks_uri: string | null;
  jwks: unknown;
  algorithms: string[];
  max_age_seconds: number;
  encrypted_secret: string | null;
  encrypted_previous_secret: string | null;
  previous_secret_expires_at: Date | string | null;
  secret_rotated_at: Date | string | null;
  tolerance_seconds: number;
  created_at: Date | string;
  updated_at: Date | string;
}

export class SourceValidationError extends Error {
  readonly fields: Record<string, string>;

  constructor(fields: Record<string, string>) {
    super('Request validation failed');
    this.name = 'SourceValidationError';
    this.fields = fields;
  }
}

/** Webhook sources cannot be registered or rotated without VAULT_ENCRYPTION_KEY. */
export class SourceSecretStorageUnavailableError extends Error {
  constructor() {
    super('Webhook sources need VAULT_ENCRYPTION_KEY to store their secret');
    this.name = 'SourceSecretStorageUnavailableError';
  }
}

export const newEventSourceId = (): string => `evsrc_${ulid()}`;
const newWebhookSecret = (): string => `gxevs_${randomBytes(32).toString('base64url')}`;
const secretContext = (sourceId: string): string => `event-bridge-source:${sourceId}`;

function iso(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

export function ingestPath(row: Pick<EventSourceRow, 'id' | 'kind'>): string {
  return row.kind === 'ssf' ? `/v1/event-bridge/ssf/${row.id}` : `/v1/event-bridge/webhooks/${row.id}`;
}

export function toSourceResponse(row: EventSourceRow): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: row.id,
    kind: row.kind,
    name: row.name,
    status: row.status,
    ingestUrl: `${config.publicBaseUrl.replace(/\/$/, '')}${ingestPath(row)}`,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
  if (row.kind === 'ssf') {
    return {
      ...base,
      issuer: row.issuer,
      audience: row.audience,
      ...(row.jwks_uri !== null ? { jwksUri: row.jwks_uri } : {}),
      ...(row.jwks !== null && row.jwks !== undefined ? { jwks: row.jwks } : {}),
      algorithms: row.algorithms,
      maxAgeSeconds: row.max_age_seconds,
    };
  }
  return {
    ...base,
    toleranceSeconds: row.tolerance_seconds,
    secretRotatedAt: iso(row.secret_rotated_at),
    previousSecretExpiresAt: iso(row.previous_secret_expires_at),
  };
}

function boundedInt(value: unknown, field: string, min: number, max: number, errors: Record<string, string>): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    errors[field] = `must be an integer between ${min} and ${max}`;
    return undefined;
  }
  return value;
}

function shortString(value: unknown, field: string, max: number, errors: Record<string, string>): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    errors[field] = `must be a non-empty string of at most ${max} characters`;
    return undefined;
  }
  return value;
}

interface SsfFields {
  issuer?: string;
  audience?: string;
  jwksUri?: string | null;
  jwks?: unknown;
  algorithms?: string[];
  maxAgeSeconds?: number;
}

function parseSsfFields(body: Record<string, unknown>, errors: Record<string, string>): SsfFields {
  const fields: SsfFields = {};
  const issuer = shortString(body['issuer'], 'issuer', 512, errors);
  if (issuer !== undefined) fields.issuer = issuer;
  const audience = shortString(body['audience'], 'audience', 512, errors);
  if (audience !== undefined) fields.audience = audience;
  if (body['jwksUri'] !== undefined) {
    if (body['jwksUri'] === null) {
      fields.jwksUri = null;
    } else {
      try {
        validateOutboundUrl(body['jwksUri'] as string, jwksUriPolicy());
        fields.jwksUri = body['jwksUri'] as string;
      } catch (err) {
        errors['jwksUri'] = err instanceof Error ? err.message : 'invalid URL';
      }
    }
  }
  if (body['jwks'] !== undefined) {
    if (body['jwks'] === null) {
      fields.jwks = null;
    } else {
      try {
        fields.jwks = validatePublicJwks(body['jwks']);
      } catch (err) {
        errors['jwks'] = err instanceof Error ? err.message : 'invalid JWK Set';
      }
    }
  }
  if (body['algorithms'] !== undefined) {
    const algorithms = body['algorithms'];
    if (!Array.isArray(algorithms) || algorithms.length === 0
        || algorithms.some((alg) => typeof alg !== 'string' || !(SET_ALGORITHMS as readonly string[]).includes(alg))) {
      errors['algorithms'] = `must be a non-empty subset of ${SET_ALGORITHMS.join(', ')}`;
    } else {
      fields.algorithms = [...new Set(algorithms as string[])];
    }
  }
  const maxAge = boundedInt(body['maxAgeSeconds'], 'maxAgeSeconds', 30, 86_400, errors);
  if (maxAge !== undefined) fields.maxAgeSeconds = maxAge;
  return fields;
}

export interface CreatedSource {
  row: EventSourceRow;
  /** Returned once, for webhook sources only. */
  secret?: string;
}

export async function createEventSource(sql: Sql, developerId: string, body: unknown): Promise<CreatedSource> {
  if (!isPlainObject(body)) throw new SourceValidationError({ body: 'must be a JSON object' });
  const errors: Record<string, string> = {};
  const kind = body['kind'];
  if (kind !== 'ssf' && kind !== 'webhook') errors['kind'] = 'must be ssf or webhook';
  const name = shortString(body['name'], 'name', 128, errors);
  if (name === undefined && errors['name'] === undefined) errors['name'] = 'required';
  const id = newEventSourceId();

  if (kind === 'ssf') {
    const allowed = new Set(['kind', 'name', 'issuer', 'audience', 'jwksUri', 'jwks', 'algorithms', 'maxAgeSeconds']);
    for (const key of Object.keys(body)) if (!allowed.has(key)) errors[key] = 'unknown field';
    const fields = parseSsfFields(body, errors);
    if (fields.issuer === undefined && errors['issuer'] === undefined) errors['issuer'] = 'required';
    if (!fields.jwksUri && !fields.jwks && errors['jwksUri'] === undefined && errors['jwks'] === undefined) {
      errors['jwks'] = 'jwks or jwksUri is required';
    }
    if (Object.keys(errors).length > 0) throw new SourceValidationError(errors);
    const audience = fields.audience ?? `${config.publicBaseUrl.replace(/\/$/, '')}${ingestPath({ id, kind: 'ssf' })}`;
    const rows = await sql<EventSourceRow[]>`
      INSERT INTO event_bridge_sources (id, developer_id, kind, name, issuer, audience, jwks_uri, jwks, algorithms, max_age_seconds)
      SELECT ${id}, ${developerId}, 'ssf', ${name!}, ${fields.issuer!}, ${audience}, ${fields.jwksUri ?? null},
             ${fields.jwks ? sql.json(fields.jwks as postgres.JSONValue) : null},
             ${fields.algorithms ?? ['RS256', 'ES256']}, ${fields.maxAgeSeconds ?? 300}
      WHERE (SELECT COUNT(*) FROM event_bridge_sources WHERE developer_id = ${developerId}) < ${MAX_SOURCES_PER_DEVELOPER}
      RETURNING *
    `;
    if (!rows[0]) throw new SourceValidationError({ kind: `at most ${MAX_SOURCES_PER_DEVELOPER} event sources per developer` });
    return { row: rows[0] };
  }

  const allowed = new Set(['kind', 'name', 'toleranceSeconds']);
  for (const key of Object.keys(body)) if (!allowed.has(key)) errors[key] = 'unknown field';
  const tolerance = boundedInt(body['toleranceSeconds'], 'toleranceSeconds', 30, 3_600, errors);
  if (Object.keys(errors).length > 0) throw new SourceValidationError(errors);
  if (!config.vaultEncryptionKey) throw new SourceSecretStorageUnavailableError();
  const secret = newWebhookSecret();
  const rows = await sql<EventSourceRow[]>`
    INSERT INTO event_bridge_sources (id, developer_id, kind, name, encrypted_secret, secret_rotated_at, tolerance_seconds)
    SELECT ${id}, ${developerId}, 'webhook', ${name!}, ${encryptWithContext(secret, secretContext(id))}, NOW(), ${tolerance ?? 300}
    WHERE (SELECT COUNT(*) FROM event_bridge_sources WHERE developer_id = ${developerId}) < ${MAX_SOURCES_PER_DEVELOPER}
    RETURNING *
  `;
  if (!rows[0]) throw new SourceValidationError({ kind: `at most ${MAX_SOURCES_PER_DEVELOPER} event sources per developer` });
  return { row: rows[0], secret };
}

export async function listEventSources(sql: Sql, developerId: string): Promise<EventSourceRow[]> {
  return sql<EventSourceRow[]>`
    SELECT * FROM event_bridge_sources WHERE developer_id = ${developerId} ORDER BY created_at DESC, id DESC
  `;
}

export async function getEventSource(sql: Sql, developerId: string, id: string): Promise<EventSourceRow | null> {
  const rows = await sql<EventSourceRow[]>`
    SELECT * FROM event_bridge_sources WHERE id = ${id} AND developer_id = ${developerId}
  `;
  return rows[0] ?? null;
}

/** Look up a source for ingestion, by id alone (the delivery is authenticated by its signature). */
export async function loadEventSourceForIngest(sql: Sql, id: string): Promise<EventSourceRow | null> {
  if (!/^evsrc_[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) return null;
  const rows = await sql<EventSourceRow[]>`SELECT * FROM event_bridge_sources WHERE id = ${id}`;
  return rows[0] ?? null;
}

export async function updateEventSource(
  sql: Sql,
  developerId: string,
  id: string,
  body: unknown,
): Promise<EventSourceRow | null> {
  if (!isPlainObject(body)) throw new SourceValidationError({ body: 'must be a JSON object' });
  const existing = await getEventSource(sql, developerId, id);
  if (!existing) return null;
  const errors: Record<string, string> = {};
  const common = new Set(['name', 'status']);
  const specific = existing.kind === 'ssf'
    ? new Set(['issuer', 'audience', 'jwksUri', 'jwks', 'algorithms', 'maxAgeSeconds'])
    : new Set(['toleranceSeconds']);
  for (const key of Object.keys(body)) if (!common.has(key) && !specific.has(key)) errors[key] = 'unknown field';
  const name = shortString(body['name'], 'name', 128, errors);
  const status = body['status'];
  if (status !== undefined && status !== 'active' && status !== 'disabled') errors['status'] = 'must be active or disabled';

  if (existing.kind === 'ssf') {
    const fields = parseSsfFields(body, errors);
    const jwksUri = fields.jwksUri !== undefined ? fields.jwksUri : existing.jwks_uri;
    const jwks = fields.jwks !== undefined ? fields.jwks : existing.jwks;
    if (!jwksUri && (jwks === null || jwks === undefined)) errors['jwks'] = 'jwks or jwksUri is required';
    if (Object.keys(errors).length > 0) throw new SourceValidationError(errors);
    const rows = await sql<EventSourceRow[]>`
      UPDATE event_bridge_sources SET
        name = ${name ?? existing.name},
        status = ${(status as string | undefined) ?? existing.status},
        issuer = ${fields.issuer ?? existing.issuer},
        audience = ${fields.audience ?? existing.audience},
        jwks_uri = ${jwksUri ?? null},
        jwks = ${jwks !== null && jwks !== undefined ? sql.json(jwks as postgres.JSONValue) : null},
        algorithms = ${fields.algorithms ?? existing.algorithms},
        max_age_seconds = ${fields.maxAgeSeconds ?? existing.max_age_seconds},
        updated_at = NOW()
      WHERE id = ${id} AND developer_id = ${developerId}
      RETURNING *
    `;
    return rows[0] ?? null;
  }

  const tolerance = boundedInt(body['toleranceSeconds'], 'toleranceSeconds', 30, 3_600, errors);
  if (Object.keys(errors).length > 0) throw new SourceValidationError(errors);
  const rows = await sql<EventSourceRow[]>`
    UPDATE event_bridge_sources SET
      name = ${name ?? existing.name},
      status = ${(status as string | undefined) ?? existing.status},
      tolerance_seconds = ${tolerance ?? existing.tolerance_seconds},
      updated_at = NOW()
    WHERE id = ${id} AND developer_id = ${developerId}
    RETURNING *
  `;
  return rows[0] ?? null;
}

/**
 * Rotate a webhook source secret. The previous secret keeps verifying for
 * `previousSecretTtlSeconds` (default one day, at most seven; 0 stops it
 * immediately, for a leaked secret).
 */
export async function rotateWebhookSecret(
  sql: Sql,
  developerId: string,
  id: string,
  body: unknown,
): Promise<CreatedSource | null> {
  const input = body === undefined || body === null ? {} : body;
  if (!isPlainObject(input)) throw new SourceValidationError({ body: 'must be a JSON object' });
  const errors: Record<string, string> = {};
  for (const key of Object.keys(input)) if (key !== 'previousSecretTtlSeconds') errors[key] = 'unknown field';
  const ttl = boundedInt(input['previousSecretTtlSeconds'], 'previousSecretTtlSeconds', 0, MAX_PREVIOUS_SECRET_TTL_SECONDS, errors)
    ?? DEFAULT_PREVIOUS_SECRET_TTL_SECONDS;
  if (Object.keys(errors).length > 0) throw new SourceValidationError(errors);

  const existing = await getEventSource(sql, developerId, id);
  if (!existing) return null;
  if (existing.kind !== 'webhook' || existing.encrypted_secret === null) {
    throw new SourceValidationError({ kind: 'only webhook sources have a secret to rotate' });
  }
  if (!config.vaultEncryptionKey) throw new SourceSecretStorageUnavailableError();
  const secret = newWebhookSecret();
  const context = secretContext(id);
  // Re-encrypt the outgoing secret so the column always holds a value bound
  // to this source, then swap both in one statement guarded on the old value.
  const previous = ttl > 0 ? encryptWithContext(decryptWithContext(existing.encrypted_secret, context), context) : null;
  const rows = await sql<EventSourceRow[]>`
    UPDATE event_bridge_sources SET
      encrypted_secret = ${encryptWithContext(secret, context)},
      encrypted_previous_secret = ${previous},
      previous_secret_expires_at = ${ttl > 0 ? new Date(Date.now() + ttl * 1000) : null},
      secret_rotated_at = NOW(),
      updated_at = NOW()
    WHERE id = ${id} AND developer_id = ${developerId} AND encrypted_secret = ${existing.encrypted_secret}
    RETURNING *
  `;
  if (!rows[0]) throw new SourceValidationError({ id: 'source changed concurrently; retry the rotation' });
  return { row: rows[0], secret };
}

/** Secrets that currently verify a webhook delivery. Throws if a stored secret cannot be decrypted. */
export function acceptedWebhookSecrets(row: EventSourceRow, now: number = Date.now()): string[] {
  if (row.encrypted_secret === null) return [];
  const context = secretContext(row.id);
  const secrets = [decryptWithContext(row.encrypted_secret, context)];
  if (row.encrypted_previous_secret !== null && row.previous_secret_expires_at !== null
      && new Date(row.previous_secret_expires_at).getTime() > now) {
    secrets.push(decryptWithContext(row.encrypted_previous_secret, context));
  }
  return secrets;
}
