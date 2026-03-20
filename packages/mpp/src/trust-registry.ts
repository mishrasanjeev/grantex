import type { OrgTrustRecord, TrustRegistryOptions } from './types.js';

const DEFAULT_ENDPOINT = 'https://api.grantex.dev/v1/trust-registry';
const DEFAULT_CACHE_MAX_AGE = 3600;

interface CacheEntry {
  record: OrgTrustRecord | null;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();

export async function lookupOrgTrust(
  organizationDID: string,
  options?: TrustRegistryOptions,
): Promise<OrgTrustRecord | null> {
  const endpoint = options?.endpoint ?? DEFAULT_ENDPOINT;
  const cacheMaxAge = options?.cacheMaxAge ?? DEFAULT_CACHE_MAX_AGE;

  // Check cache
  const cached = cache.get(organizationDID);
  if (cached && (Date.now() - cached.fetchedAt) / 1000 < cacheMaxAge) {
    return cached.record;
  }

  const url = `${endpoint}/${encodeURIComponent(organizationDID)}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: { 'Accept': 'application/json' },
  });

  if (response.status === 404) {
    cache.set(organizationDID, { record: null, fetchedAt: Date.now() });
    return null;
  }

  if (!response.ok) {
    throw new Error(`Trust registry lookup failed: ${response.status}`);
  }

  const body = await response.json() as {
    organizationDID: string;
    verifiedAt: string;
    verificationMethod: 'dns-txt' | 'manual' | 'soc2';
    trustLevel: 'basic' | 'verified' | 'soc2';
    domains: string[];
  };

  const record: OrgTrustRecord = {
    organizationDID: body.organizationDID,
    verifiedAt: new Date(body.verifiedAt),
    verificationMethod: body.verificationMethod,
    trustLevel: body.trustLevel,
    domains: body.domains,
  };

  cache.set(organizationDID, { record, fetchedAt: Date.now() });

  return record;
}

/** Clear the in-memory trust registry cache. Useful for testing. */
export function clearTrustRegistryCache(): void {
  cache.clear();
}
