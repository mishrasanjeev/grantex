/**
 * Token Status List reading for OACP artifacts (draft-ietf-oauth-status-list,
 * the revision the auth service implements: -21).
 *
 * An OACP envelope is a Referenced Token (§6.2): it carries
 * `status.status_list = { idx, uri }`. The issuer serves the list at `uri` as
 * a Status List Token (§5.1), media type `application/statuslist+jwt`
 * (§8.2), signed with a key from the same JWK Set as the artifact. The list is
 * `bits` wide per entry, packed from the least significant bit of each byte,
 * DEFLATE-compressed in the ZLIB format and base64url encoded (§4.1, §4.2).
 *
 * Everything here fails closed: a list that cannot be fetched, verified or
 * decoded never reads as VALID.
 */
import { inflateSync } from 'node:zlib';
import { decodeBase64urlStrict, decodeJsonSegment, selectVerificationKey, verifyJwsSignature } from './jose.js';

/** draft-ietf-oauth-status-list §7.1 status types. */
export const OACP_TOKEN_STATUS = Object.freeze({ VALID: 0x00, INVALID: 0x01, SUSPENDED: 0x02 } as const);

/** §5.1 `typ` of a Status List Token. */
export const STATUS_LIST_TOKEN_TYP = 'statuslist+jwt';

/** §8.2 media type of a Status List Token response. */
export const STATUS_LIST_TOKEN_MEDIA_TYPE = 'application/statuslist+jwt';

/** Upper bound on an inflated list, so a hostile list cannot exhaust memory. */
export const STATUS_LIST_MAX_DECODED_BYTES = 16 * 1024 * 1024;

/** Seconds of clock skew allowed on the list's `iat`. */
export const STATUS_LIST_CLOCK_SKEW_SECONDS = 60;

const STATUS_LIST_ALGORITHMS = new Set(['ES256', 'RS256']);
const ALLOWED_BITS = new Set([1, 2, 4, 8]);

export class OacpStatusListError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OacpStatusListError';
  }
}

export interface DecodedOacpStatusList {
  bits: 1 | 2 | 4 | 8;
  /** Number of entries the byte array holds. */
  size: number;
  /** The status at `idx`; throws for an index outside the list (§8.3 step 6). */
  statusAt(idx: number): number;
}

/** Reads a §4.2 StatusList object `{ bits, lst }`. Throws on anything malformed. */
export function decodeOacpStatusList(statusList: unknown): DecodedOacpStatusList {
  if (typeof statusList !== 'object' || statusList === null) throw new OacpStatusListError('status_list must be an object');
  const { bits, lst } = statusList as { bits?: unknown; lst?: unknown };
  if (typeof bits !== 'number' || !ALLOWED_BITS.has(bits)) throw new OacpStatusListError('bits must be 1, 2, 4 or 8');
  if (typeof lst !== 'string' || lst.length === 0) throw new OacpStatusListError('lst must be a base64url string');
  const compressed = decodeBase64urlStrict(lst);
  if (compressed === null) throw new OacpStatusListError('lst must be a base64url string');
  let bytes: Buffer;
  try {
    // §8.3 step 5: a decompressor for DEFLATE in the ZLIB format.
    bytes = inflateSync(compressed, { maxOutputLength: STATUS_LIST_MAX_DECODED_BYTES });
  } catch (err) {
    throw new OacpStatusListError(`lst is not ZLIB data: ${(err as Error).message}`);
  }
  const perByte = 8 / bits;
  const size = bytes.length * perByte;
  const mask = (1 << bits) - 1;
  return {
    bits: bits as 1 | 2 | 4 | 8,
    size,
    statusAt(idx: number): number {
      if (!Number.isInteger(idx) || idx < 0 || idx >= size) {
        throw new OacpStatusListError(`index ${idx} is outside a list of ${size} entries`);
      }
      // §4.1 step 3: entries are packed from the least significant bit.
      return (bytes[Math.floor(idx / perByte)]! >> ((idx % perByte) * bits)) & mask;
    },
  };
}

export interface ReadOacpStatusOptions {
  /** The Status List Token text. */
  token: string;
  /** The URI the artifact names; the token's `sub` must equal it (§8.3). */
  uri: string;
  idx: number;
  /** The issuer's JWK Set (the same one the artifact verified against). */
  jwks: unknown;
  /** The pinned issuer; a token with an `iss` must name it. */
  issuer: string;
  now: Date;
}

export interface OacpStatusRead {
  status: number;
  /** Seconds the read may be reused for (the list's `ttl`), when it states one. */
  ttlSeconds: number | null;
}

/**
 * Verifies a Status List Token (§5.1, §8.3) and returns the status at `idx`.
 * Throws `OacpStatusListError` for anything that prevents reading the entry.
 */
export function readOacpStatus(options: ReadOacpStatusOptions): OacpStatusRead {
  const { token, uri, idx, jwks, issuer, now } = options;
  if (typeof token !== 'string') throw new OacpStatusListError('the status list is not a compact JWS');
  const parts = token.trim().split('.');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new OacpStatusListError('the status list is not a compact JWS');
  }
  const [headerSegment, payloadSegment, signatureSegment] = parts as [string, string, string];
  const header = decodeJsonSegment(headerSegment);
  if (header === null) throw new OacpStatusListError('the status list header is not a JSON object');
  if (header['typ'] !== STATUS_LIST_TOKEN_TYP) throw new OacpStatusListError(`the status list typ is not ${STATUS_LIST_TOKEN_TYP}`);
  const alg = header['alg'];
  if (typeof alg !== 'string' || !STATUS_LIST_ALGORITHMS.has(alg)) throw new OacpStatusListError('the status list algorithm is not ES256 or RS256');
  if ('crit' in header) throw new OacpStatusListError('the status list header has crit parameters');
  const kid = header['kid'];
  if (typeof kid !== 'string' || kid.length === 0) throw new OacpStatusListError('the status list header has no kid');
  const key = selectVerificationKey(jwks, kid, alg as 'ES256' | 'RS256');
  if (!key.ok) throw new OacpStatusListError(`status list key: ${key.reason}`);
  const signature = decodeBase64urlStrict(signatureSegment);
  if (signature === null || !verifyJwsSignature(alg as 'ES256' | 'RS256', key.key, `${headerSegment}.${payloadSegment}`, signature)) {
    throw new OacpStatusListError('the status list signature does not verify');
  }

  const claims = decodeJsonSegment(payloadSegment);
  if (claims === null) throw new OacpStatusListError('the status list claims are not a JSON object');
  if (claims['sub'] !== uri) throw new OacpStatusListError('the status list sub is not the URI the artifact names');
  if (claims['iss'] !== undefined && claims['iss'] !== issuer) throw new OacpStatusListError('the status list iss is not the pinned issuer');
  const nowS = Math.floor(now.getTime() / 1000);
  const { iat, exp, ttl } = claims;
  const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  if (!isTime(iat)) throw new OacpStatusListError('the status list iat must be an integer');
  if (exp !== undefined && !isTime(exp)) throw new OacpStatusListError('the status list exp must be an integer');
  if (ttl !== undefined && (!isTime(ttl) || ttl === 0)) throw new OacpStatusListError('the status list ttl must be a positive integer');
  if (iat > nowS + STATUS_LIST_CLOCK_SKEW_SECONDS) throw new OacpStatusListError('the status list iat is in the future');
  if (exp !== undefined) {
    if (nowS >= exp) throw new OacpStatusListError('the status list has expired');
  } else if (ttl !== undefined) {
    if (nowS >= iat + ttl) throw new OacpStatusListError('the status list is older than its ttl');
  } else {
    throw new OacpStatusListError('the status list has neither exp nor ttl');
  }
  const list = decodeOacpStatusList(claims['status_list']);
  return { status: list.statusAt(idx), ttlSeconds: ttl === undefined ? null : ttl };
}
