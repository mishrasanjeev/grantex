import { randomBytes } from 'node:crypto';
import type { CodeStore, AuthorizationCode } from '../types.js';

export class InMemoryCodeStore implements CodeStore {
  readonly #codes = new Map<string, AuthorizationCode>();

  async get(code: string): Promise<AuthorizationCode | undefined> {
    const data = this.#codes.get(code);
    if (!data) return undefined;
    if (Date.now() > data.expiresAt) {
      this.#codes.delete(code);
      return undefined;
    }
    return data;
  }

  async set(code: string, data: AuthorizationCode): Promise<void> {
    this.#codes.set(code, data);
  }

  async delete(code: string): Promise<boolean> {
    return this.#codes.delete(code);
  }
}

export function generateCode(): string {
  return randomBytes(32).toString('base64url');
}
