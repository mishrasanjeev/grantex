import { calculateJwkThumbprint, importJWK, type JWK } from 'jose';
import { assertValidRedirectUri, validateOutboundUrl } from './url-security.js';

const PRIVATE_JWK_FIELDS = new Set(['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k']);
const SUPPORTED_KEY_TYPES = new Set(['EC', 'OKP', 'RSA']);

export function validateRedirectUris(value: unknown): string[] {
  return validateUriList(value, 'redirectUris', assertValidRedirectUri);
}

export function validateResourceServers(value: unknown): string[] {
  return validateUriList(value, 'resourceServers', (uri) => {
    const parsed = validateOutboundUrl(uri, {
      allowedProtocols: ['https:'],
      allowPrivateHosts: process.env.NODE_ENV !== 'production',
    });
    if (parsed.hash) throw new Error('resource URI must not contain a fragment');
  });
}

export async function validateAgentPublicJwk(value: unknown): Promise<{ jwk: JWK; thumbprint: string }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('publicJwk must be a public asymmetric JWK object');
  }

  const jwk = { ...(value as Record<string, unknown>) } as JWK;
  if (typeof jwk.kty !== 'string' || !SUPPORTED_KEY_TYPES.has(jwk.kty)) {
    throw new Error('publicJwk kty must be EC, OKP, or RSA');
  }
  for (const field of PRIVATE_JWK_FIELDS) {
    if (field in jwk) throw new Error(`publicJwk must not contain private key field ${field}`);
  }
  if (jwk.use !== undefined && jwk.use !== 'sig') {
    throw new Error('publicJwk use must be sig when present');
  }
  if (jwk.key_ops !== undefined
      && (!Array.isArray(jwk.key_ops) || jwk.key_ops.some((op) => op !== 'verify'))) {
    throw new Error('publicJwk key_ops may contain only verify');
  }

  let algorithm: string;
  if (jwk.kty === 'RSA') {
    if (typeof jwk.n !== 'string' || typeof jwk.e !== 'string'
        || Buffer.from(jwk.n, 'base64url').length < 256) {
      throw new Error('publicJwk RSA keys must contain a modulus of at least 2048 bits and an exponent');
    }
    algorithm = 'RS256';
  } else if (jwk.kty === 'EC') {
    const algorithms: Record<string, string> = {
      'P-256': 'ES256',
      'P-384': 'ES384',
      'P-521': 'ES512',
    };
    if (typeof jwk.crv !== 'string' || !algorithms[jwk.crv]
        || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
      throw new Error('publicJwk EC keys must use P-256, P-384, or P-521 and include x and y');
    }
    algorithm = algorithms[jwk.crv]!;
  } else {
    if (jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') {
      throw new Error('publicJwk OKP keys must use Ed25519 and include x');
    }
    algorithm = 'EdDSA';
  }
  if (jwk.alg !== undefined && jwk.alg !== algorithm) {
    throw new Error(`publicJwk alg must be ${algorithm} for this key`);
  }

  try {
    await importJWK(jwk, algorithm);
    return { jwk, thumbprint: await calculateJwkThumbprint(jwk, 'sha256') };
  } catch {
    throw new Error('publicJwk contains invalid public key parameters');
  }
}

function validateUriList(
  value: unknown,
  field: string,
  validate: (uri: string) => void,
): string[] {
  if (!Array.isArray(value) || value.length > 20) {
    throw new Error(`${field} must be an array with at most 20 entries`);
  }

  const unique = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0 || item.length > 2048) {
      throw new Error(`${field} entries must be non-empty URI strings`);
    }
    validate(item);
    unique.add(item);
  }
  return [...unique];
}
