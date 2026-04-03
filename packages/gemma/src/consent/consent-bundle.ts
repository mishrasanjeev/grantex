import type { JWK } from 'jose';

/* ------------------------------------------------------------------ */
/*  Public types                                                       */
/* ------------------------------------------------------------------ */

export interface CreateConsentBundleOptions {
  /** Grantex developer API key. */
  apiKey: string;
  /** Grantex API base URL (default: https://api.grantex.dev). */
  baseUrl?: string;
  /** Agent ID requesting the bundle. */
  agentId: string;
  /** End-user / principal ID granting consent. */
  userId: string;
  /** Scopes the agent is requesting. */
  scopes: string[];
  /** How long the bundle is valid offline (default '72h'). */
  offlineTTL?: string;
  /** Algorithm for the offline audit signing key (default 'Ed25519'). */
  offlineAuditKeyAlgorithm?: string;
  /** Where to persist the bundle locally. */
  storage?: 'encrypted-file' | 'keychain' | 'secure-enclave';
  /** File path when `storage` is `'encrypted-file'`. */
  storagePath?: string;
}

export interface ConsentBundle {
  /** Unique bundle identifier. */
  bundleId: string;
  /** Grantex grant token (JWT). */
  grantToken: string;
  /** JWKS snapshot for offline verification. */
  jwksSnapshot: {
    keys: JWK[];
    fetchedAt: string;
    validUntil: string;
  };
  /** Ed25519 key pair for signing offline audit entries. */
  offlineAuditKey: {
    publicKey: string;
    privateKey: string;
    algorithm: string;
  };
  /** Unix-ms timestamp of last successful cloud sync. */
  checkpointAt: number;
  /** URL for syncing audit entries back to cloud. */
  syncEndpoint: string;
  /** ISO-8601 timestamp after which offline operation is disallowed. */
  offlineExpiresAt: string;
}

/* ------------------------------------------------------------------ */
/*  Factory                                                            */
/* ------------------------------------------------------------------ */

/**
 * Request a consent bundle from the Grantex API.
 *
 * This call happens **online** — the returned bundle is then used for
 * offline operation (verification, audit, scope enforcement).
 */
export async function createConsentBundle(
  options: CreateConsentBundleOptions,
): Promise<ConsentBundle> {
  const {
    apiKey,
    baseUrl = 'https://api.grantex.dev',
    agentId,
    userId,
    scopes,
    offlineTTL = '72h',
    offlineAuditKeyAlgorithm = 'Ed25519',
  } = options;

  const res = await fetch(
    `${baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl}/v1/consent-bundles`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        agentId,
        userId,
        scopes,
        offlineTTL,
        offlineAuditKeyAlgorithm,
      }),
    },
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Failed to create consent bundle: HTTP ${res.status} — ${body}`,
    );
  }

  const bundle = (await res.json()) as ConsentBundle;
  return bundle;
}
