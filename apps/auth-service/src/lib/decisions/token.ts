/**
 * Decision-grant and approver-session tokens (PRD G-3).
 *
 * A decision grant is a JWT with header `typ: decision+jwt` and audience
 * `urn:grantex:decision`, signed with the platform key that signs grant
 * tokens, so SDKs verify it with the same JWKS. The profile is specified in
 * spec/decision-grant.md.
 */
import { SignJWT, jwtVerify, decodeProtectedHeader, type JWTPayload } from 'jose';
import { config } from '../../config.js';
import { getKeyPair } from '../crypto.js';
import { isActionHash, parseDecisionAction, type DecisionAction } from './action.js';

export const DECISION_GRANT_TYP = 'decision+jwt';
export const DECISION_GRANT_AUDIENCE = 'urn:grantex:decision';
export const APPROVER_SESSION_TYP = 'approver-session+jwt';
export const APPROVER_SESSION_AUDIENCE = 'urn:grantex:decision-approver';

export interface FourEyesClaim {
  approvals_required: 2;
  position: 1 | 2;
  /** On the second approval: the first decision grant's `jti` and `sub`. */
  first_jti?: string;
  first_sub?: string;
}

/** The claims of a decision grant, as signed. */
export interface DecisionGrantClaims {
  iss: string;
  sub: string;
  aud: string;
  jti: string;
  iat: number;
  exp: number;
  dev: string;
  idp: string;
  approver_auth: string;
  acr?: string;
  amr: string[];
  auth_time: number;
  action: DecisionAction;
  action_hash: string;
  connector: string;
  case_version: string;
  dwell_ms: number;
  decision_request: string;
  memo_ref?: string;
  policy_score_ref?: string;
  four_eyes?: FourEyesClaim;
}

function signingKey(): { privateKey: CryptoKey; publicKey: CryptoKey; kid: string; alg: string } {
  const pair = getKeyPair() as ReturnType<typeof getKeyPair> & { alg?: string };
  return { privateKey: pair.privateKey, publicKey: pair.publicKey, kid: pair.kid, alg: pair.alg ?? 'RS256' };
}

/** Signs a decision grant. `iss` and `aud` are always this service's; any given are ignored. */
export async function signDecisionGrant(
  claims: Omit<DecisionGrantClaims, 'iss' | 'aud'> & { iss?: string; aud?: string },
): Promise<string> {
  const { privateKey, kid, alg } = signingKey();
  const { sub, jti, iat, exp, iss: _iss, aud: _aud, ...rest } = claims;
  return new SignJWT({ ...rest })
    .setProtectedHeader({ alg, kid, typ: DECISION_GRANT_TYP })
    .setIssuer(config.jwtIssuer)
    .setAudience(DECISION_GRANT_AUDIENCE)
    .setSubject(sub)
    .setJti(jti)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(privateKey);
}

export class DecisionTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecisionTokenError';
  }
}

const JTI_RE = /^dgnt_[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Verifies a decision grant's signature, type, issuer and audience and
 * returns its claims. Expiry is not checked here (`currentDate` is set far in
 * the past): the caller reports `expired` itself, after the signature is
 * known to be good.
 */
export async function verifyDecisionGrantSignature(token: string): Promise<DecisionGrantClaims> {
  if (typeof token !== 'string' || token.length === 0 || token.length > 16_384) {
    throw new DecisionTokenError('decision grant must be a compact JWT');
  }
  let header;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    throw new DecisionTokenError('decision grant is not a JWT');
  }
  if (header.typ !== DECISION_GRANT_TYP) {
    throw new DecisionTokenError(`decision grant typ must be ${DECISION_GRANT_TYP}`);
  }
  const { publicKey, alg } = signingKey();
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, publicKey, {
      issuer: config.jwtIssuer,
      audience: DECISION_GRANT_AUDIENCE,
      algorithms: [alg],
      typ: DECISION_GRANT_TYP,
      currentDate: new Date(0),
    }));
  } catch {
    throw new DecisionTokenError('decision grant signature, issuer or audience is invalid');
  }
  return parseDecisionGrantClaims(payload);
}

/** Validates the claim set of a decision grant. */
export function parseDecisionGrantClaims(payload: JWTPayload): DecisionGrantClaims {
  const p = payload as Record<string, unknown>;
  const str = (key: string): string => {
    const value = p[key];
    if (typeof value !== 'string' || value.length === 0) throw new DecisionTokenError(`decision grant claim ${key} is missing`);
    return value;
  };
  const int = (key: string): number => {
    const value = p[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new DecisionTokenError(`decision grant claim ${key} is invalid`);
    return value;
  };
  const jti = str('jti');
  if (!JTI_RE.test(jti)) throw new DecisionTokenError('decision grant jti is malformed');
  let action: DecisionAction;
  try {
    action = parseDecisionAction(p['action']);
  } catch {
    throw new DecisionTokenError('decision grant action is malformed');
  }
  const actionHash = str('action_hash');
  if (!isActionHash(actionHash)) throw new DecisionTokenError('decision grant action_hash is malformed');
  const amr = p['amr'];
  if (!Array.isArray(amr) || !amr.every((v) => typeof v === 'string')) throw new DecisionTokenError('decision grant amr is invalid');
  const fourEyes = p['four_eyes'];
  let fourEyesClaim: FourEyesClaim | undefined;
  if (fourEyes !== undefined) {
    const f = fourEyes as Record<string, unknown>;
    if (typeof fourEyes !== 'object' || fourEyes === null || f['approvals_required'] !== 2 || (f['position'] !== 1 && f['position'] !== 2)) {
      throw new DecisionTokenError('decision grant four_eyes is invalid');
    }
    if (f['position'] === 2 && (typeof f['first_jti'] !== 'string' || typeof f['first_sub'] !== 'string')) {
      throw new DecisionTokenError('decision grant four_eyes must name the first approval');
    }
    fourEyesClaim = {
      approvals_required: 2,
      position: f['position'],
      ...(typeof f['first_jti'] === 'string' ? { first_jti: f['first_jti'] } : {}),
      ...(typeof f['first_sub'] === 'string' ? { first_sub: f['first_sub'] } : {}),
    };
  }
  const acr = p['acr'];
  if (acr !== undefined && typeof acr !== 'string') throw new DecisionTokenError('decision grant acr is invalid');
  const claims: DecisionGrantClaims = {
    iss: str('iss'),
    sub: str('sub'),
    aud: DECISION_GRANT_AUDIENCE,
    jti,
    iat: int('iat'),
    exp: int('exp'),
    dev: str('dev'),
    idp: str('idp'),
    approver_auth: str('approver_auth'),
    ...(typeof acr === 'string' ? { acr } : {}),
    amr: amr as string[],
    auth_time: int('auth_time'),
    action,
    action_hash: actionHash,
    connector: str('connector'),
    case_version: str('case_version'),
    dwell_ms: int('dwell_ms'),
    decision_request: str('decision_request'),
    ...(typeof p['memo_ref'] === 'string' ? { memo_ref: p['memo_ref'] } : {}),
    ...(typeof p['policy_score_ref'] === 'string' ? { policy_score_ref: p['policy_score_ref'] } : {}),
    ...(fourEyesClaim !== undefined ? { four_eyes: fourEyesClaim } : {}),
  };
  if (claims.exp <= claims.iat) throw new DecisionTokenError('decision grant exp must be after iat');
  return claims;
}

export async function signApproverSession(sessionId: string, developerId: string, expiresAt: number): Promise<string> {
  const { privateKey, kid, alg } = signingKey();
  return new SignJWT({ dev: developerId })
    .setProtectedHeader({ alg, kid, typ: APPROVER_SESSION_TYP })
    .setIssuer(config.jwtIssuer)
    .setAudience(APPROVER_SESSION_AUDIENCE)
    .setSubject(sessionId)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(privateKey);
}

/** Returns the session id and developer of a valid approver-session token. */
export async function verifyApproverSession(token: string): Promise<{ sessionId: string; developerId: string }> {
  if (typeof token !== 'string' || token.length === 0 || token.length > 4_096) {
    throw new DecisionTokenError('approver session token is missing');
  }
  const { publicKey, alg } = signingKey();
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, publicKey, {
      issuer: config.jwtIssuer,
      audience: APPROVER_SESSION_AUDIENCE,
      algorithms: [alg],
      typ: APPROVER_SESSION_TYP,
    }));
  } catch {
    throw new DecisionTokenError('approver session token is invalid or expired');
  }
  const sessionId = payload.sub;
  const developerId = payload['dev'];
  if (typeof sessionId !== 'string' || !sessionId.startsWith('dsess_') || typeof developerId !== 'string' || developerId.length === 0) {
    throw new DecisionTokenError('approver session token claims are invalid');
  }
  return { sessionId, developerId };
}
