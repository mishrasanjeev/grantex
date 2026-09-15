/**
 * Security Event Token verification (RFC 8417, delivered per RFC 8935, with
 * the SSF 1.0 / CAEP profile's `typ` and `sub_id`).
 *
 * Everything fails closed with a reason code: a token is accepted only when
 * its `typ` is `secevent+jwt`, its algorithm is on the source's allow list,
 * its signature verifies against the transmitter's JWK Set, `iss` and `aud`
 * match the registration, `iat` is present and inside the age window, `jti`
 * is present, and `events` names at least one event.
 */
import { decodeProtectedHeader, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { EventVerificationError } from './errors.js';
import {
  MAX_EVENT_ID_LENGTH,
  MAX_EVENT_TYPE_LENGTH,
  MAX_EVENTS_PER_SET,
  isPlainObject,
  type NormalizedEvent,
} from './normalize.js';

export const SET_ALGORITHMS = ['RS256', 'PS256', 'ES256', 'ES384', 'EdDSA'] as const;
export type SetAlgorithm = (typeof SET_ALGORITHMS)[number];

/** RFC 8417 section 2.3: the media type of a SET, with or without the `application/` prefix. */
const SET_TYP = /^(application\/)?secevent\+jwt$/i;

export interface SetSourceConfig {
  id: string;
  developerId: string;
  issuer: string;
  audience: string;
  algorithms: readonly string[];
  maxAgeSeconds: number;
}

export interface VerifySetOptions {
  /** Current time in milliseconds (tests freeze it). */
  now?: number;
  /** Allowed clock skew for `iat` in the future and `exp`, in seconds. */
  clockSkewSeconds?: number;
}

export interface VerifiedSet {
  jti: string;
  events: NormalizedEvent[];
}

const MAX_TOKEN_LENGTH = 64_000;

export async function verifySecurityEventToken(
  token: string,
  source: SetSourceConfig,
  getKey: JWTVerifyGetKey,
  options: VerifySetOptions = {},
): Promise<VerifiedSet> {
  const now = options.now ?? Date.now();
  const skew = options.clockSkewSeconds ?? 60;
  const compact = token.trim();
  if (compact.length === 0 || compact.length > MAX_TOKEN_LENGTH || compact.split('.').length !== 3) {
    throw new EventVerificationError('malformed', 'body is not a compact JWS');
  }

  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(compact);
  } catch {
    throw new EventVerificationError('malformed', 'protected header cannot be decoded');
  }
  if (typeof header.typ !== 'string' || !SET_TYP.test(header.typ)) {
    throw new EventVerificationError('unsupported_typ', 'typ must be secevent+jwt');
  }
  const allowed = source.algorithms.filter((alg): alg is SetAlgorithm =>
    (SET_ALGORITHMS as readonly string[]).includes(alg));
  if (typeof header.alg !== 'string' || !allowed.includes(header.alg as SetAlgorithm)) {
    throw new EventVerificationError('unsupported_alg', 'alg is not allowed for this source');
  }

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(compact, getKey, {
      algorithms: allowed,
      currentDate: new Date(now),
      clockTolerance: skew,
    }));
  } catch (err) {
    throw mapJoseError(err);
  }

  if (payload.iss !== source.issuer) {
    throw new EventVerificationError('issuer_mismatch', 'iss does not match the registered transmitter');
  }
  const audiences = typeof payload.aud === 'string' ? [payload.aud] : Array.isArray(payload.aud) ? payload.aud : [];
  if (!audiences.includes(source.audience)) {
    throw new EventVerificationError('audience_mismatch', 'aud does not include this receiver');
  }
  if (typeof payload.iat !== 'number' || !Number.isFinite(payload.iat)) {
    throw new EventVerificationError('iat_missing', 'iat is required');
  }
  const nowSeconds = Math.floor(now / 1000);
  if (payload.iat > nowSeconds + skew) {
    throw new EventVerificationError('iat_in_future', 'iat is in the future');
  }
  if (nowSeconds - payload.iat > source.maxAgeSeconds + skew) {
    throw new EventVerificationError('stale', 'iat is older than the source allows');
  }
  if (typeof payload.jti !== 'string' || payload.jti.length === 0 || payload.jti.length > MAX_EVENT_ID_LENGTH) {
    throw new EventVerificationError('jti_missing', `jti is required (at most ${MAX_EVENT_ID_LENGTH} characters)`);
  }
  const events = (payload as Record<string, unknown>)['events'];
  if (!isPlainObject(events)) {
    throw new EventVerificationError('events_missing', 'events claim is required');
  }
  const entries = Object.entries(events);
  if (entries.length === 0 || entries.length > MAX_EVENTS_PER_SET) {
    throw new EventVerificationError('events_missing', `events must name 1 to ${MAX_EVENTS_PER_SET} events`);
  }

  const topSubject = (payload as Record<string, unknown>)['sub_id'];
  const normalized: NormalizedEvent[] = [];
  for (const [type, body] of entries) {
    if (type.length === 0 || type.length > MAX_EVENT_TYPE_LENGTH || !isPlainObject(body)) {
      throw new EventVerificationError('events_missing', 'each event must be an object keyed by its type');
    }
    // SSF 1.0 puts the subject at the top level (`sub_id`); earlier CAEP drafts
    // put it inside the event (`subject`). The top level wins when both exist.
    const subject = isPlainObject(topSubject)
      ? topSubject
      : isPlainObject(body['subject']) ? body['subject'] : {};
    const eventTimestamp = body['event_timestamp'];
    normalized.push({
      sourceId: source.id,
      sourceKind: 'ssf',
      developerId: source.developerId,
      eventId: payload.jti,
      type,
      subject,
      data: body,
      occurredAt: typeof eventTimestamp === 'number' && Number.isFinite(eventTimestamp)
        ? new Date(eventTimestamp * 1000).toISOString()
        : new Date(payload.iat * 1000).toISOString(),
    });
  }
  return { jti: payload.jti, events: normalized };
}

function mapJoseError(err: unknown): EventVerificationError {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  const claim = typeof err === 'object' && err !== null ? (err as { claim?: unknown }).claim : undefined;
  switch (code) {
    case 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED':
      return new EventVerificationError('signature_invalid', 'signature does not verify');
    case 'ERR_JWKS_NO_MATCHING_KEY':
    case 'ERR_JWKS_MULTIPLE_MATCHING_KEYS':
    case 'ERR_JWKS_INVALID':
    case 'ERR_JWKS_TIMEOUT':
    case 'ERR_JWK_INVALID':
      return new EventVerificationError('key_unavailable', 'no usable transmitter key for this token');
    case 'ERR_JOSE_ALG_NOT_ALLOWED':
    case 'ERR_JOSE_NOT_SUPPORTED':
      return new EventVerificationError('unsupported_alg', 'alg is not allowed for this source');
    case 'ERR_JWT_EXPIRED':
      return new EventVerificationError('expired', 'token has expired');
    case 'ERR_JWT_CLAIM_VALIDATION_FAILED':
      if (claim === 'iat') return new EventVerificationError('iat_in_future', 'iat is not acceptable');
      if (claim === 'nbf') return new EventVerificationError('iat_in_future', 'token is not yet valid');
      return new EventVerificationError('malformed', 'claims are not acceptable');
    default:
      if (err instanceof EventVerificationError) return err;
      return new EventVerificationError(
        code === undefined ? 'key_unavailable' : 'malformed',
        code === undefined ? 'transmitter keys could not be resolved' : 'token is not a valid JWS',
      );
  }
}
