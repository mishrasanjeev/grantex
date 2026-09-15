import type {
  AuthorizationCode,
  ClientRegistration,
  ConsentRecord,
  PendingAuthorization,
  RefreshTokenBinding,
  RevocationRecord,
} from '../types.js';

/**
 * Durable authorization state for `@grantex/mcp-auth`.
 *
 * Every piece of state the server keeps goes through this interface, so a
 * restart or a second replica sees exactly what the first one wrote.
 * Implementations must honour these rules — the shared contract suite in
 * `tests/storage-contract.ts` checks each one against every implementation:
 *
 * - **Single use is atomic.** `take*` and `consume*` return a record to at
 *   most one caller, however many race for it; every other caller gets
 *   `undefined`.
 * - **Expired records do not exist.** A record whose `expiresAt` (unix ms)
 *   has passed is never returned.
 * - **Secrets are not stored in the clear.** Codes, consent ids, pending
 *   authorization ids and refresh tokens are looked up by their SHA-256.
 * - **Errors propagate.** An implementation that cannot reach its backend
 *   throws; the server turns that into a refusal, never into access.
 */
export interface McpAuthStorage {
  /** Short, stable name used in logs and errors (`postgres`, `redis`, `memory`). */
  readonly kind: string;

  getClient(clientId: string): Promise<ClientRegistration | undefined>;
  putClient(client: ClientRegistration): Promise<void>;
  deleteClient(clientId: string): Promise<boolean>;

  /** Stores an authorization waiting for upstream consent, keyed by its opaque id. */
  putPendingAuthorization(id: string, record: PendingAuthorization): Promise<void>;
  /** Atomically returns and deletes a pending authorization. */
  takePendingAuthorization(id: string): Promise<PendingAuthorization | undefined>;

  putAuthorizationCode(code: string, record: AuthorizationCode): Promise<void>;
  /** Atomically returns and deletes an authorization code (single use). */
  consumeAuthorizationCode(code: string): Promise<AuthorizationCode | undefined>;

  putRefreshTokenBinding(refreshToken: string, binding: RefreshTokenBinding): Promise<void>;
  /**
   * Atomically returns and deletes the binding, but only when it belongs to
   * `clientId`. A binding held by another client is left untouched and
   * `undefined` is returned.
   */
  takeRefreshTokenBinding(refreshToken: string, clientId: string): Promise<RefreshTokenBinding | undefined>;

  putConsent(id: string, record: ConsentRecord): Promise<void>;
  /** Atomically returns and deletes a consent record (one form submission). */
  takeConsent(id: string): Promise<ConsentRecord | undefined>;

  /** Records a revocation. Revoking an already revoked `jti` keeps the later expiry. */
  revokeToken(jti: string, record: RevocationRecord): Promise<void>;
  isTokenRevoked(jti: string): Promise<boolean>;

  /** Releases connections owned by the storage (never ones passed in by the caller). */
  close?(): Promise<void>;
}

/** Narrow view used by token verifiers that only need revocation state. */
export type RevocationChecker = Pick<McpAuthStorage, 'isTokenRevoked'>;
