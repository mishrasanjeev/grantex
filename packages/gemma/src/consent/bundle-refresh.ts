import type { ConsentBundle } from './consent-bundle.js';

/**
 * Returns `true` when the bundle has less than 20 % of its total offline
 * TTL remaining — i.e. it's time to refresh while connectivity is available.
 */
export function shouldRefresh(bundle: ConsentBundle): boolean {
  const expiresAtMs = new Date(bundle.offlineExpiresAt).getTime();
  // Use checkpointAt as the "created" baseline (last sync = start of window).
  const checkpointMs = bundle.checkpointAt;
  const totalTTL = expiresAtMs - checkpointMs;
  const remaining = expiresAtMs - Date.now();

  if (totalTTL <= 0) return true;
  return remaining / totalTTL < 0.2;
}

/**
 * Refresh a consent bundle by calling the Grantex API.
 *
 * The server returns a fresh bundle with an extended `offlineExpiresAt`,
 * new JWKS snapshot, and rotated audit keys.
 */
export async function refreshBundle(
  bundle: ConsentBundle,
  apiKey: string,
  baseUrl = 'https://api.grantex.dev',
): Promise<ConsentBundle> {
  const res = await fetch(
    `${baseUrl.replace(/\/+$/, '')}/v1/consent-bundles/${bundle.bundleId}/refresh`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
    },
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Failed to refresh consent bundle: HTTP ${res.status} — ${body}`,
    );
  }

  return (await res.json()) as ConsentBundle;
}
