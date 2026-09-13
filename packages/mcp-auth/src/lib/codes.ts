import { randomBytes } from 'node:crypto';
import type {
  CodeStore,
  AuthorizationCode,
  PendingAuthorization,
  PendingAuthorizationStore,
  RefreshTokenBinding,
  RefreshTokenStore,
} from '../types.js';

class InMemoryExpiringStore<T extends { expiresAt: number }> {
  readonly #entries = new Map<string, T>();

  async get(key: string): Promise<T | undefined> {
    const data = this.#entries.get(key);
    if (!data) return undefined;
    if (Date.now() > data.expiresAt) {
      this.#entries.delete(key);
      return undefined;
    }
    return data;
  }

  async set(key: string, data: T): Promise<void> {
    this.#entries.set(key, data);
  }

  async delete(key: string): Promise<boolean> {
    return this.#entries.delete(key);
  }
}

export class InMemoryCodeStore
  extends InMemoryExpiringStore<AuthorizationCode>
  implements CodeStore {}

export class InMemoryPendingAuthorizationStore
  extends InMemoryExpiringStore<PendingAuthorization>
  implements PendingAuthorizationStore {}

export class InMemoryRefreshTokenStore
  extends InMemoryExpiringStore<RefreshTokenBinding>
  implements RefreshTokenStore {}

export function generateCode(): string {
  return randomBytes(32).toString('base64url');
}
