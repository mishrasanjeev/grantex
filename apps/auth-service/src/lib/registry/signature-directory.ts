// SPDX-License-Identifier: LicenseRef-Orchestrum-Personal-Use-1.0
/**
 * The registry's HTTP Message Signatures key directory (G50):
 * `GET /.well-known/http-message-signatures-directory`, media type
 * `application/http-message-signatures-directory+json`
 * (draft-meunier-webbotauth-httpsig-directory-00 section 3), a JWK Set of
 * the usable keys of the agents whose developers opted in
 * (agents.http_signature_directory, migration 136).
 *
 *   - A key is listed while evaluateAgentKey (agent-keys.ts) finds it usable
 *     at the database clock: active, or rotated and still inside its
 *     overlap; never pending, unproven or compromised. Its agent must be
 *     active.
 *   - Only P-256 (ES256, `ecdsa-p256-sha256`) and Ed25519 (EdDSA, `ed25519`)
 *     keys are listed: the algorithms of the HTTP Signature Algorithms
 *     registry that the agent request signing library verifies.
 *   - `kid` is the key's RFC 7638 thumbprint, which the draft requires when
 *     `kid` is present and Web Bot Auth uses as `keyid`; `nbf` and `exp`
 *     are the key's valid_from and valid_to (UNIX seconds); `use` is `sig`.
 *     Removing a key from the directory is how it is deactivated (section 7).
 *
 * Response signatures. Section 5.2 RECOMMENDS one RFC 9421 signature per
 * listed key, by that key, over `"@authority";req` and `content-digest` with
 * `tag="http-message-signatures-directory"`. The registry does not hold
 * agents' private keys and so cannot produce those; an operator that hosts
 * its own directory produces them with `signDirectoryResponse` in
 * @grantex/agent-httpsig. The registry instead signs the response once with
 * its platform key, over the same components, with
 * `tag="grantex-registry-directory"` and the platform kid (resolvable from
 * /.well-known/jwks.json): a registry attestation that these keys are the
 * registered agents' keys, which a relying party that trusts the registry
 * can check. A client that strictly applies section 5.2 ignores keys without
 * their own signature; such a client should resolve these agents' keys
 * through the registry lookup instead.
 */
import { createHash, KeyObject, webcrypto } from 'node:crypto';
import type postgres from 'postgres';
import { config } from '../../config.js';
import { getKeyPair } from '../crypto.js';
import { evaluateAgentKey, type AgentKeyStatus } from './agent-keys.js';
import { jwkThumbprint } from './jwk-thumbprint.js';

type Sql = ReturnType<typeof postgres>;
type Row = Record<string, unknown>;

export const SIGNATURE_DIRECTORY_PATH = '/.well-known/http-message-signatures-directory';
export const SIGNATURE_DIRECTORY_MEDIA_TYPE = 'application/http-message-signatures-directory+json';
/** The registry's own response signature (not the per-key tag of section 5.2). */
export const REGISTRY_DIRECTORY_TAG = 'grantex-registry-directory';
/** Cache-Control max-age; a removed key stops being served within this. */
export const SIGNATURE_DIRECTORY_MAX_AGE_SECONDS = 300;
/** The registry signature's lifetime: created to expires. */
export const SIGNATURE_DIRECTORY_SIGNATURE_SECONDS = 300;
export const SIGNATURE_DIRECTORY_RATE_LIMIT_PER_MINUTE = 60;

export interface DirectoryKey {
  kty: 'EC' | 'OKP';
  crv: 'P-256' | 'Ed25519';
  x: string;
  y?: string;
  kid: string;
  use: 'sig';
  nbf: number;
  exp?: number;
}

const B64URL_32 = /^[A-Za-z0-9_-]{43}$/;

function seconds(value: unknown): number {
  return Math.floor(new Date(value as string).getTime() / 1000);
}

/** One agent_keys row as a directory entry, or null when it is not listed. */
export function directoryKeyFromRow(row: Row, at: Date): DirectoryKey | null {
  const evaluation = evaluateAgentKey({
    status: row['status'] as AgentKeyStatus,
    validFrom: new Date(row['valid_from'] as string),
    validTo: row['valid_to'] ? new Date(row['valid_to'] as string) : null,
    possessionProvedAt: row['possession_proved_at'] ? new Date(row['possession_proved_at'] as string) : null,
  }, at);
  if (!evaluation.usable) return null;
  const jwk = row['jwk'] as Record<string, unknown> | null;
  if (jwk === null || typeof jwk !== 'object') return null;
  const alg = row['alg'];
  let entry: Omit<DirectoryKey, 'kid' | 'use' | 'nbf'>;
  if (alg === 'ES256' && jwk['kty'] === 'EC' && jwk['crv'] === 'P-256'
      && typeof jwk['x'] === 'string' && B64URL_32.test(jwk['x']) && typeof jwk['y'] === 'string' && B64URL_32.test(jwk['y'])) {
    entry = { kty: 'EC', crv: 'P-256', x: jwk['x'], y: jwk['y'] };
  } else if (alg === 'EdDSA' && jwk['kty'] === 'OKP' && jwk['crv'] === 'Ed25519'
      && typeof jwk['x'] === 'string' && B64URL_32.test(jwk['x'])) {
    entry = { kty: 'OKP', crv: 'Ed25519', x: jwk['x'] };
  } else {
    return null;
  }
  let kid: string;
  try {
    kid = jwkThumbprint(entry);
  } catch {
    // A stored key whose thumbprint cannot be computed is not published.
    return null;
  }
  // The stored thumbprint is the row's primary key; a disagreement means the
  // row is not what it claims to be, and it is not published.
  if (row['thumbprint'] !== undefined && row['thumbprint'] !== kid) return null;
  const out: DirectoryKey = { ...entry, kid, use: 'sig', nbf: seconds(row['valid_from']) };
  if (row['valid_to']) out.exp = seconds(row['valid_to']);
  return out;
}

/** The JWK Set, keys in kid order so the same registry state gives the same bytes. */
export function buildDirectoryDocument(rows: readonly Row[], at: Date): { keys: DirectoryKey[] } {
  const byKid = new Map<string, DirectoryKey>();
  for (const row of rows) {
    const key = directoryKeyFromRow(row, at);
    if (key !== null) byKid.set(key.kid, key);
  }
  return { keys: [...byKid.values()].sort((a, b) => (a.kid < b.kid ? -1 : a.kid > b.kid ? 1 : 0)) };
}

/** The listed keys of opted-in, active agents, read at the database clock. */
export async function loadDirectoryDocument(sql: Sql): Promise<{ keys: DirectoryKey[] }> {
  const rows = await sql<Row[]>`
    SELECT ak.thumbprint, ak.jwk, ak.alg, ak.status, ak.valid_from, ak.valid_to,
           ak.possession_proved_at, NOW() AS db_now
    FROM agent_keys ak
    JOIN agents a ON a.id = ak.agent_id
    WHERE a.http_signature_directory AND a.status = 'active'
      AND ak.status IN ('active', 'rotated')
      AND ak.alg IN ('ES256', 'EdDSA')
    ORDER BY ak.thumbprint`;
  const at = rows[0] ? new Date(rows[0]['db_now'] as string) : new Date();
  return buildDirectoryDocument(rows, at);
}

/** RFC 9530 section 2: `sha-256=:<base64>:`. */
export function contentDigest(body: string): string {
  return `sha-256=:${createHash('sha256').update(body, 'utf8').digest('base64')}:`;
}

/** The authority of the registry's public base URL (RFC 9421 section 2.2.3): never the Host header. */
export function registryAuthority(): string {
  const url = new URL(config.publicBaseUrl);
  return url.host.toLowerCase();
}

/**
 * The response fields: Content-Type, Content-Digest, Cache-Control and the
 * registry's RFC 9421 signature over `"@authority";req` and
 * `content-digest` with the platform key.
 */
export async function signDirectoryResponse(
  body: string,
  options: { now?: Date; authority?: string; key?: { privateKey: unknown; kid: string; alg: string } } = {},
): Promise<Record<string, string>> {
  const created = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const expires = created + SIGNATURE_DIRECTORY_SIGNATURE_SECONDS;
  const { privateKey, kid, alg } = options.key ?? getKeyPair();
  const httpAlg = alg === 'ES256' ? 'ecdsa-p256-sha256' : alg === 'RS256' ? 'rsa-v1_5-sha256' : null;
  if (httpAlg === null) throw new Error(`the platform key algorithm ${alg} has no RFC 9421 counterpart here`);
  const digest = contentDigest(body);
  const params = `("@authority";req "content-digest");created=${created};expires=${expires};keyid=${JSON.stringify(kid)};alg="${httpAlg}";tag="${REGISTRY_DIRECTORY_TAG}"`;
  // RFC 9421 section 2.5: one line per component, then @signature-params.
  const base = [
    `"@authority";req: ${options.authority ?? registryAuthority()}`,
    `"content-digest": ${digest}`,
    `"@signature-params": ${params}`,
  ].join('\n');
  const data = Buffer.from(base, 'ascii');
  const key = privateKey instanceof KeyObject ? privateKey.toCryptoKey(
    httpAlg === 'ecdsa-p256-sha256' ? { name: 'ECDSA', namedCurve: 'P-256' } : { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  ) : privateKey as webcrypto.CryptoKey;
  // Sections 3.3.1 (RSASSA-PKCS1-v1_5 SHA-256) and 3.3.4 (ECDSA, r || s as WebCrypto returns it).
  const signature = Buffer.from(await webcrypto.subtle.sign(
    httpAlg === 'ecdsa-p256-sha256' ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'RSASSA-PKCS1-v1_5' },
    key,
    data,
  ));
  return {
    'Content-Type': SIGNATURE_DIRECTORY_MEDIA_TYPE,
    'Content-Digest': digest,
    'Cache-Control': `public, max-age=${SIGNATURE_DIRECTORY_MAX_AGE_SECONDS}`,
    'Signature-Input': `registry=${params}`,
    Signature: `registry=:${signature.toString('base64')}:`,
  };
}
