import type { ClientStore, ClientRegistration } from '../types.js';

export class InMemoryClientStore implements ClientStore {
  readonly #clients = new Map<string, ClientRegistration>();

  async get(clientId: string): Promise<ClientRegistration | undefined> {
    return this.#clients.get(clientId);
  }

  async set(clientId: string, registration: ClientRegistration): Promise<void> {
    this.#clients.set(clientId, registration);
  }

  async delete(clientId: string): Promise<boolean> {
    return this.#clients.delete(clientId);
  }
}
