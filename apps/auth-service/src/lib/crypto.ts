import {
  generateKeyPair,
  importPKCS8,
  importSPKI,
  exportJWK,
  SignJWT,
  decodeJwt,
  type KeyLike,
} from 'jose';
import { config } from '../config.js';

export interface KeyPair {
  privateKey: KeyLike;
  publicKey: KeyLike;
  kid: string;
}

export interface GrantTokenPayload {
  sub: string;
  agt: string;
  dev: string;
  scp: string[];
  jti: string;
  grnt?: string;
  aud?: string;
  exp: number;
  parentAgt?: string;
  parentGrnt?: string;
  delegationDepth?: number;
}

let _keyPair: KeyPair | null = null;

function buildKid(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `grantex-${year}-${month}`;
}

export async function initKeys(): Promise<void> {
  if (config.rsaPrivateKey) {
    const pem = config.rsaPrivateKey.replace(/\\n/g, '\n');
    const privateKey = await importPKCS8(pem, 'RS256');

    // Extract public key by exporting the private key as JWK, then re-importing
    // only the public components (n, e) via Node's crypto module + importSPKI
    const privateJwk = await exportJWK(privateKey);
    const { n, e } = privateJwk;
    if (!n || !e) throw new Error('Cannot extract RSA public key components');

    // Build a minimal public JWK for importSPKI workaround
    const { createPublicKey } = await import('node:crypto');
    const nodePk = createPublicKey({
      key: { kty: 'RSA', n, e },
      format: 'jwk',
    });
    const spkiPem = nodePk.export({ type: 'spki', format: 'pem' }) as string;
    const publicKey = await importSPKI(spkiPem, 'RS256');

    _keyPair = { privateKey, publicKey, kid: buildKid() };
    return;
  }

  if (config.autoGenerateKeys) {
    const { privateKey, publicKey } = await generateKeyPair('RS256', {
      modulusLength: 2048,
    });
    _keyPair = { privateKey, publicKey, kid: buildKid() };
    return;
  }

  throw new Error('No RSA key configured');
}

export function getKeyPair(): KeyPair {
  if (!_keyPair) throw new Error('Keys not initialized — call initKeys() first');
  return _keyPair;
}

export async function signGrantToken(
  payload: GrantTokenPayload,
): Promise<string> {
  const { privateKey, kid } = getKeyPair();
  const builder = new SignJWT({
    agt: payload.agt,
    dev: payload.dev,
    scp: payload.scp,
    ...(payload.grnt !== undefined ? { grnt: payload.grnt } : {}),
    ...(payload.parentAgt !== undefined ? { parentAgt: payload.parentAgt } : {}),
    ...(payload.parentGrnt !== undefined ? { parentGrnt: payload.parentGrnt } : {}),
    ...(payload.delegationDepth !== undefined ? { delegationDepth: payload.delegationDepth } : {}),
  })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuer(config.jwtIssuer)
    .setSubject(payload.sub)
    .setJti(payload.jti)
    .setIssuedAt()
    .setExpirationTime(payload.exp);

  if (payload.aud !== undefined) {
    builder.setAudience(payload.aud);
  }

  return builder.sign(privateKey);
}

export async function buildJwks(): Promise<{ keys: Record<string, unknown>[] }> {
  const { publicKey, kid } = getKeyPair();
  const jwk = await exportJWK(publicKey);
  return {
    keys: [
      {
        ...jwk,
        alg: 'RS256',
        use: 'sig',
        kid,
      },
    ],
  };
}

export function decodeTokenClaims(jwt: string): Record<string, unknown> {
  return decodeJwt(jwt) as Record<string, unknown>;
}

export function parseExpiresIn(expiresIn: string): number {
  const match = /^(\d+)([smhd])$/.exec(expiresIn);
  if (!match) throw new Error(`Invalid expiresIn format: ${expiresIn}`);
  const [, amount, unit] = match;
  const n = parseInt(amount!, 10);
  switch (unit) {
    case 's': return n;
    case 'm': return n * 60;
    case 'h': return n * 3600;
    case 'd': return n * 86400;
    default: throw new Error(`Unknown unit: ${unit}`);
  }
}
