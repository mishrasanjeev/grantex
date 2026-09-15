import type {
  AuthorizationCode,
  ClientRegistration,
  ConsentRecord,
  PendingAuthorization,
  RefreshTokenBinding,
  RevocationRecord,
} from '../types.js';
import type { McpAuthStorage } from './types.js';
import { assertExpiry, remainingMs, secretKey } from './keys.js';

/**
 * The one capability `RedisStorage` needs from a client: send a raw command
 * and return its reply. Wrap ioredis with {@link fromIoredis}; for
 * node-redis use `{ send: (c, a) => client.sendCommand([c, ...a]) }`.
 */
export interface RedisCommandSender {
  send(command: string, args: string[]): Promise<unknown>;
}

/** Minimal shape of an ioredis client. */
export interface IoredisLike {
  call(command: string, ...args: string[]): Promise<unknown>;
}

/** Adapts an ioredis client to {@link RedisCommandSender}. */
export function fromIoredis(redis: IoredisLike): RedisCommandSender {
  return { send: (command, args) => redis.call(command, ...args) };
}

export interface RedisStorageOptions {
  redis: RedisCommandSender;
  /** Key prefix, so several deployments can share one Redis (default `grantex:mcp-auth:`). */
  keyPrefix?: string;
}

// Returns the binding and deletes it only when it belongs to ARGV[1]. Runs
// atomically inside Redis, so two refreshes of one token cannot both win.
const TAKE_IF_CLIENT = `
local value = redis.call('GET', KEYS[1])
if not value then return false end
local ok, record = pcall(cjson.decode, value)
if not ok or type(record) ~= 'table' or record['clientId'] ~= ARGV[1] then return false end
redis.call('DEL', KEYS[1])
return value
`;

// Keeps the later of the stored and new expiry when a jti is revoked twice.
const REVOKE = `
local ttl = tonumber(ARGV[2])
local current = redis.call('PTTL', KEYS[1])
if current > ttl then ttl = current end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ttl)
return 1
`;

function parseRecord<T>(value: unknown, what: string): T | undefined {
  if (value === null || value === undefined || value === false) return undefined;
  const text = typeof value === 'string' ? value : Buffer.isBuffer(value) ? value.toString('utf8') : undefined;
  if (text === undefined) throw new Error(`RedisStorage: unexpected reply type for ${what}`);
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`RedisStorage: stored ${what} is not a JSON object`);
  }
  return parsed as T;
}

/**
 * Redis-backed {@link McpAuthStorage} (Redis 6.2 or later).
 *
 * Expiring records carry a matching `PX` TTL. Single use relies on `GETDEL`
 * and a Lua script, both atomic in Redis. Client registrations have no TTL,
 * so the instance must persist data (AOF or RDB) for registrations to
 * survive a Redis restart.
 */
export class RedisStorage implements McpAuthStorage {
  readonly kind = 'redis';
  readonly #redis: RedisCommandSender;
  readonly #prefix: string;

  constructor(options: RedisStorageOptions) {
    if (!options?.redis || typeof options.redis.send !== 'function') {
      throw new TypeError('RedisStorage requires a redis client with send(command, args); see fromIoredis()');
    }
    this.#redis = options.redis;
    this.#prefix = options.keyPrefix ?? 'grantex:mcp-auth:';
  }

  async getClient(clientId: string): Promise<ClientRegistration | undefined> {
    return parseRecord(await this.#redis.send('GET', [this.#key('client', clientId)]), 'client');
  }

  async putClient(client: ClientRegistration): Promise<void> {
    await this.#redis.send('SET', [this.#key('client', client.clientId), JSON.stringify(client)]);
  }

  async deleteClient(clientId: string): Promise<boolean> {
    return Number(await this.#redis.send('DEL', [this.#key('client', clientId)])) > 0;
  }

  async putPendingAuthorization(id: string, record: PendingAuthorization): Promise<void> {
    await this.#put(this.#key('pending', secretKey(id)), record);
  }

  async takePendingAuthorization(id: string): Promise<PendingAuthorization | undefined> {
    return this.#take(this.#key('pending', secretKey(id)), 'pending authorization');
  }

  async putAuthorizationCode(code: string, record: AuthorizationCode): Promise<void> {
    await this.#put(this.#key('code', secretKey(code)), record);
  }

  async consumeAuthorizationCode(code: string): Promise<AuthorizationCode | undefined> {
    return this.#take(this.#key('code', secretKey(code)), 'authorization code');
  }

  async putRefreshTokenBinding(refreshToken: string, binding: RefreshTokenBinding): Promise<void> {
    await this.#put(this.#key('refresh', secretKey(refreshToken)), binding);
  }

  async takeRefreshTokenBinding(refreshToken: string, clientId: string): Promise<RefreshTokenBinding | undefined> {
    const reply = await this.#redis.send('EVAL', [TAKE_IF_CLIENT, '1', this.#key('refresh', secretKey(refreshToken)), clientId]);
    return this.#live(parseRecord<RefreshTokenBinding>(reply, 'refresh token binding'));
  }

  async putConsent(id: string, record: ConsentRecord): Promise<void> {
    await this.#put(this.#key('consent', secretKey(id)), record);
  }

  async takeConsent(id: string): Promise<ConsentRecord | undefined> {
    return this.#take(this.#key('consent', secretKey(id)), 'consent');
  }

  async revokeToken(jti: string, record: RevocationRecord): Promise<void> {
    assertExpiry(record.expiresAt, 'revocation');
    const ttl = remainingMs(record.expiresAt);
    if (ttl === 0) return; // The token has expired; nothing can present it any more.
    await this.#redis.send('EVAL', [REVOKE, '1', this.#key('revoked', jti), JSON.stringify(record), String(ttl)]);
  }

  async isTokenRevoked(jti: string): Promise<boolean> {
    return Number(await this.#redis.send('EXISTS', [this.#key('revoked', jti)])) > 0;
  }

  #key(kind: string, id: string): string {
    return `${this.#prefix}${kind}:${id}`;
  }

  async #put(key: string, record: { expiresAt: number }): Promise<void> {
    assertExpiry(record.expiresAt, 'record');
    const ttl = remainingMs(record.expiresAt);
    if (ttl === 0) {
      // Already expired: make sure no older value survives under the key.
      await this.#redis.send('DEL', [key]);
      return;
    }
    await this.#redis.send('SET', [key, JSON.stringify(record), 'PX', String(ttl)]);
  }

  async #take<T extends { expiresAt: number }>(key: string, what: string): Promise<T | undefined> {
    return this.#live(parseRecord<T>(await this.#redis.send('GETDEL', [key]), what));
  }

  // TTLs expire keys, but a record is also checked against its own expiry so
  // a clock or TTL mismatch can only shorten a record's life, never extend it.
  #live<T extends { expiresAt: number }>(record: T | undefined): T | undefined {
    if (record === undefined) return undefined;
    return typeof record.expiresAt === 'number' && Date.now() < record.expiresAt ? record : undefined;
  }
}
