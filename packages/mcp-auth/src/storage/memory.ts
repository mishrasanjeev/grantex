import type {
  AuthorizationCode,
  ClientRegistration,
  ConsentRecord,
  PendingAuthorization,
  RefreshTokenBinding,
  RevocationRecord,
} from '../types.js';
import type { McpAuthStorage } from './types.js';
import { assertExpiry, secretKey } from './keys.js';

interface Expiring {
  expiresAt: number;
}

class ExpiringMap<T extends Expiring> {
  readonly #entries = new Map<string, T>();

  put(key: string, value: T): void {
    assertExpiry(value.expiresAt, 'record');
    this.#entries.set(key, structuredClone(value));
  }

  take(key: string, accept: (value: T) => boolean = () => true): T | undefined {
    const value = this.#live(key);
    if (value === undefined || !accept(value)) return undefined;
    // Map operations are synchronous, so get-then-delete cannot interleave
    // with another caller on the single JavaScript thread.
    this.#entries.delete(key);
    return value;
  }

  has(key: string): boolean {
    return this.#live(key) !== undefined;
  }

  #live(key: string): T | undefined {
    const value = this.#entries.get(key);
    if (value === undefined) return undefined;
    if (Date.now() >= value.expiresAt) {
      this.#entries.delete(key);
      return undefined;
    }
    return structuredClone(value);
  }
}

/**
 * Process-local storage **for tests only**. State is lost on restart and not
 * shared between replicas, so it refuses to start when
 * `NODE_ENV=production`. Deploy with `PostgresStorage` or `RedisStorage`.
 */
export class InMemoryStorage implements McpAuthStorage {
  readonly kind = 'memory';
  readonly #clients = new Map<string, ClientRegistration>();
  readonly #pending = new ExpiringMap<PendingAuthorization>();
  readonly #codes = new ExpiringMap<AuthorizationCode>();
  readonly #refresh = new ExpiringMap<RefreshTokenBinding>();
  readonly #consents = new ExpiringMap<ConsentRecord>();
  readonly #revocations = new ExpiringMap<RevocationRecord>();

  constructor() {
    if (process.env['NODE_ENV'] === 'production') {
      throw new Error(
        'InMemoryStorage is for tests only and refuses to run with NODE_ENV=production; '
        + 'use PostgresStorage or RedisStorage',
      );
    }
  }

  async getClient(clientId: string): Promise<ClientRegistration | undefined> {
    const client = this.#clients.get(clientId);
    return client === undefined ? undefined : structuredClone(client);
  }

  async putClient(client: ClientRegistration): Promise<void> {
    this.#clients.set(client.clientId, structuredClone(client));
  }

  async deleteClient(clientId: string): Promise<boolean> {
    return this.#clients.delete(clientId);
  }

  async putPendingAuthorization(id: string, record: PendingAuthorization): Promise<void> {
    this.#pending.put(secretKey(id), record);
  }

  async takePendingAuthorization(id: string): Promise<PendingAuthorization | undefined> {
    return this.#pending.take(secretKey(id));
  }

  async putAuthorizationCode(code: string, record: AuthorizationCode): Promise<void> {
    this.#codes.put(secretKey(code), record);
  }

  async consumeAuthorizationCode(code: string): Promise<AuthorizationCode | undefined> {
    return this.#codes.take(secretKey(code));
  }

  async putRefreshTokenBinding(refreshToken: string, binding: RefreshTokenBinding): Promise<void> {
    this.#refresh.put(secretKey(refreshToken), binding);
  }

  async takeRefreshTokenBinding(refreshToken: string, clientId: string): Promise<RefreshTokenBinding | undefined> {
    return this.#refresh.take(secretKey(refreshToken), (binding) => binding.clientId === clientId);
  }

  async putConsent(id: string, record: ConsentRecord): Promise<void> {
    this.#consents.put(secretKey(id), record);
  }

  async takeConsent(id: string): Promise<ConsentRecord | undefined> {
    return this.#consents.take(secretKey(id));
  }

  async revokeToken(jti: string, record: RevocationRecord): Promise<void> {
    assertExpiry(record.expiresAt, 'revocation');
    const existing = this.#revocations.take(jti);
    const expiresAt = Math.max(record.expiresAt, existing?.expiresAt ?? 0);
    this.#revocations.put(jti, { ...record, expiresAt });
  }

  async isTokenRevoked(jti: string): Promise<boolean> {
    return this.#revocations.has(jti);
  }
}
