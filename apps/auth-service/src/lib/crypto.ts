import {
  generateKeyPair,
  importPKCS8,
  importSPKI,
  exportJWK,
  SignJWT,
  jwtVerify,
  decodeJwt,
  type CryptoKey as KeyLike,
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
  clientId?: string;
  scp: string[];
  jti: string;
  grnt?: string;
  aud?: string;
  exp: number;
  iat?: number;
  cnf?: { jkt: string };
  act?: Record<string, unknown>;
  authorizationDetails?: Array<Record<string, unknown>>;
  parentAgt?: string;
  parentGrnt?: string;
  delegationDepth?: number;
  bdg?: number;
}

export interface VerifiedGrantTokenClaims {
  sub: string;
  agt: string;
  dev: string;
  clientId?: string;
  scp: string[];
  jti: string;
  grnt: string;
  iat: number;
  exp: number;
  aud?: string | string[];
  iss?: string;
  parentAgt?: string;
  parentGrnt?: string;
  delegationDepth?: number;
  bdg?: number;
  scope?: string;
  cnf?: { jkt: string };
  act?: Record<string, unknown>;
  authorizationDetails?: Array<Record<string, unknown>>;
}

export interface OAuthAccessTokenPayload {
  sub: string;
  clientId: string;
  scopes: string[];
  jti: string;
  aud: string;
  exp: number;
  iat?: number;
  cnf: { jkt: string };
  act?: Record<string, unknown>;
  authorizationDetails?: Array<Record<string, unknown>>;
}

export interface VerifiedOAuthAccessTokenClaims {
  sub: string;
  clientId: string;
  scopes: string[];
  scope: string;
  jti: string;
  iat: number;
  exp: number;
  aud: string;
  iss: string;
  cnf: { jkt: string };
  act?: Record<string, unknown>;
  authorizationDetails?: Array<Record<string, unknown>>;
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
    const privateKey = await importPKCS8(pem, 'RS256', { extractable: true });

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
      extractable: true,
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
    ...(payload.clientId !== undefined ? { client_id: payload.clientId } : {}),
    scp: payload.scp,
    scope: payload.scp.join(' '),
    ...(payload.cnf !== undefined ? { cnf: payload.cnf } : {}),
    ...(payload.act !== undefined ? { act: payload.act } : {}),
    ...(payload.authorizationDetails !== undefined
      ? { authorization_details: payload.authorizationDetails }
      : {}),
    ...(payload.grnt !== undefined ? { grnt: payload.grnt } : {}),
    ...(payload.parentAgt !== undefined ? { parentAgt: payload.parentAgt } : {}),
    ...(payload.parentGrnt !== undefined ? { parentGrnt: payload.parentGrnt } : {}),
    ...(payload.delegationDepth !== undefined ? { delegationDepth: payload.delegationDepth } : {}),
    ...(payload.bdg !== undefined ? { bdg: payload.bdg } : {}),
  })
    .setProtectedHeader({ alg: 'RS256', kid, typ: 'at+jwt' })
    .setIssuer(config.jwtIssuer)
    .setSubject(payload.sub)
    .setJti(payload.jti)
    .setIssuedAt(payload.iat)
    .setExpirationTime(payload.exp);

  if (payload.aud !== undefined) {
    builder.setAudience(payload.aud);
  }

  return builder.sign(privateKey);
}

export async function signOAuthAccessToken(
  payload: OAuthAccessTokenPayload,
): Promise<string> {
  const { privateKey, kid } = getKeyPair();
  const builder = new SignJWT({
    client_id: payload.clientId,
    scope: payload.scopes.join(' '),
    cnf: payload.cnf,
    ...(payload.act !== undefined ? { act: payload.act } : {}),
    ...(payload.authorizationDetails !== undefined
      ? { authorization_details: payload.authorizationDetails }
      : {}),
  })
    .setProtectedHeader({ alg: 'RS256', kid, typ: 'at+jwt' })
    .setIssuer(config.jwtIssuer)
    .setSubject(payload.sub)
    .setAudience(payload.aud)
    .setJti(payload.jti)
    .setIssuedAt(payload.iat)
    .setExpirationTime(payload.exp);

  return builder.sign(privateKey);
}

export async function verifyOAuthAccessToken(
  token: string,
): Promise<VerifiedOAuthAccessTokenClaims> {
  const { publicKey } = getKeyPair();
  const { payload, protectedHeader } = await jwtVerify(token, publicKey, {
    issuer: config.jwtIssuer,
    algorithms: ['RS256'],
  });
  if (protectedHeader.typ !== 'at+jwt') {
    throw new Error('OAuth access token typ must be at+jwt');
  }

  const clientId = payload['client_id'];
  const scope = payload['scope'];
  const cnf = payload['cnf'];
  const scopes = typeof scope === 'string' ? scope.split(' ') : [];
  if (!payload.sub || typeof clientId !== 'string' || clientId.length === 0
      || typeof scope !== 'string' || scopes.length === 0
      || scopes.some((value) => value.length === 0)
      || new Set(scopes).size !== scopes.length
      || typeof payload.jti !== 'string'
      || typeof payload.iat !== 'number'
      || typeof payload.exp !== 'number'
      || typeof payload.iss !== 'string'
      || typeof payload.aud !== 'string'
      || !cnf || typeof cnf !== 'object' || Array.isArray(cnf)
      || typeof (cnf as Record<string, unknown>)['jkt'] !== 'string') {
    throw new Error('Missing or invalid OAuth access token claims');
  }

  const act = payload['act'];
  if (act !== undefined && (!act || typeof act !== 'object' || Array.isArray(act))) {
    throw new Error('OAuth access token act claim is invalid');
  }
  const authorizationDetails = payload['authorization_details'];
  if (authorizationDetails !== undefined && !Array.isArray(authorizationDetails)) {
    throw new Error('OAuth access token authorization_details claim is invalid');
  }

  return {
    sub: payload.sub,
    clientId,
    scopes,
    scope,
    jti: payload.jti,
    iat: payload.iat,
    exp: payload.exp,
    aud: payload.aud,
    iss: payload.iss,
    cnf: cnf as { jkt: string },
    ...(act !== undefined ? { act: act as Record<string, unknown> } : {}),
    ...(authorizationDetails !== undefined
      ? { authorizationDetails: authorizationDetails as Array<Record<string, unknown>> }
      : {}),
  };
}

export async function signAuditCheckpoint(payload: {
  developerId: string;
  headEntryId: string;
  headHash: string;
  entryCount: number;
  checkpointId: string;
}): Promise<string> {
  const { privateKey, kid } = getKeyPair();
  return new SignJWT({
    typ: 'grantex-audit-checkpoint+jwt',
    developer_id: payload.developerId,
    head_entry_id: payload.headEntryId,
    head_hash: payload.headHash,
    entry_count: payload.entryCount,
  })
    .setProtectedHeader({ alg: 'RS256', kid, typ: 'JWT' })
    .setIssuer(config.jwtIssuer)
    .setJti(payload.checkpointId)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(privateKey);
}

export async function verifyGrantToken(
  token: string,
): Promise<VerifiedGrantTokenClaims> {
  const { publicKey } = getKeyPair();
  const { payload } = await jwtVerify(token, publicKey, {
    issuer: config.jwtIssuer,
    algorithms: ['RS256'],
  });

  const sub = payload.sub;
  const agt = payload['agt'] as string | undefined;
  const dev = payload['dev'] as string | undefined;
  const scp = payload['scp'] as string[] | undefined;
  const jti = payload.jti;
  const iat = payload.iat;
  const exp = payload.exp;
  if (!sub || !agt || !dev || !scp || !jti || typeof iat !== 'number' || typeof exp !== 'number') {
    throw new Error('Missing required grant token claims');
  }

  return {
    sub,
    agt,
    dev,
    ...(typeof payload['client_id'] === 'string' ? { clientId: payload['client_id'] } : {}),
    scp,
    jti,
    grnt: typeof payload['grnt'] === 'string' ? payload['grnt'] : jti,
    iat,
    exp,
    ...(payload.aud !== undefined ? { aud: payload.aud as string | string[] } : {}),
    ...(payload.iss !== undefined ? { iss: payload.iss } : {}),
    ...(payload['parentAgt'] !== undefined ? { parentAgt: payload['parentAgt'] as string } : {}),
    ...(payload['parentGrnt'] !== undefined ? { parentGrnt: payload['parentGrnt'] as string } : {}),
    ...(payload['delegationDepth'] !== undefined ? { delegationDepth: payload['delegationDepth'] as number } : {}),
    ...(payload['bdg'] !== undefined ? { bdg: payload['bdg'] as number } : {}),
    ...(typeof payload['scope'] === 'string' ? { scope: payload['scope'] } : {}),
    ...(payload['cnf'] && typeof payload['cnf'] === 'object'
      ? { cnf: payload['cnf'] as { jkt: string } }
      : {}),
    ...(payload['act'] && typeof payload['act'] === 'object'
      ? { act: payload['act'] as Record<string, unknown> }
      : {}),
    ...(Array.isArray(payload['authorization_details'])
      ? { authorizationDetails: payload['authorization_details'] as Array<Record<string, unknown>> }
      : {}),
  };
}

// ─── Ed25519 key support (optional — for VC Data Integrity proofs) ────────────

export interface EdKeyPair {
  privateKey: KeyLike;
  publicKey: KeyLike;
  kid: string;
}

let _edKeyPair: EdKeyPair | null = null;

function buildEdKid(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `grantex-ed25519-${year}-${month}`;
}

export async function initEdKey(): Promise<void> {
  if (config.ed25519PrivateKey) {
    const pem = config.ed25519PrivateKey.replace(/\\n/g, '\n');
    const privateKey = await importPKCS8(pem, 'EdDSA', { extractable: true });
    const jwk = await exportJWK(privateKey);
    if (!jwk.crv || !jwk.x) throw new Error('Cannot extract Ed25519 public key components');
    const { createPublicKey } = await import('node:crypto');
    const nodePk = createPublicKey({
      key: { kty: jwk.kty as string, crv: jwk.crv, x: jwk.x },
      format: 'jwk',
    });
    const spkiPem = nodePk.export({ type: 'spki', format: 'pem' }) as string;
    const publicKey = await importSPKI(spkiPem, 'EdDSA');
    _edKeyPair = { privateKey, publicKey, kid: buildEdKid() };
    return;
  }

  // Auto-generate Ed25519 key pair
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', {
    crv: 'Ed25519',
    extractable: true,
  });
  _edKeyPair = { privateKey, publicKey, kid: buildEdKid() };
}

export function getEdKeyPair(): EdKeyPair | null {
  return _edKeyPair;
}

export async function signWithEd25519(payload: Record<string, unknown>): Promise<string> {
  if (!_edKeyPair) throw new Error('Ed25519 key not initialized — call initEdKey() first');
  const { privateKey, kid } = _edKeyPair;
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'EdDSA', kid })
    .setIssuer(config.jwtIssuer)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(privateKey);
}

// ─── End Ed25519 ─────────────────────────────────────────────────────────────

export async function buildJwks(): Promise<{ keys: Record<string, unknown>[] }> {
  const { publicKey, kid } = getKeyPair();
  const jwk = await exportJWK(publicKey);
  const keys: Record<string, unknown>[] = [
    {
      ...jwk,
      alg: 'RS256',
      use: 'sig',
      kid,
    },
  ];

  // Include Ed25519 key if initialized
  if (_edKeyPair) {
    const edJwk = await exportJWK(_edKeyPair.publicKey);
    keys.push({
      ...edJwk,
      alg: 'EdDSA',
      use: 'sig',
      kid: _edKeyPair.kid,
    });
  }

  // Commerce Passport ES256 keys (M2). Include both active and retired so
  // passports signed with a recently-rotated key keep verifying through
  // the rotation grace window. Lazy-imported to avoid pulling the
  // commerce module surface into pure-platform call sites that may run
  // before commerce config is wired.
  try {
    const { getSql } = await import('../db/client.js');
    const { listCommercePassportKeysForJwks } = await import('./commerce/passport-keys.js');
    const commerceKeys = await listCommercePassportKeysForJwks(getSql());
    for (const k of commerceKeys) {
      // public_key_jwk in DB already carries kid + alg + use=sig; emit as-is.
      keys.push(k.publicKeyJwk);
    }
  } catch {
    // Commerce keys are optional in the JWKS — if the DB is unavailable
    // here we still serve the platform RS256/EdDSA keys. Log via the
    // route layer (this lib should not depend on pino directly).
  }

  return { keys };
}

export function decodeTokenClaims(jwt: string): Record<string, unknown> {
  return decodeJwt(jwt) as Record<string, unknown>;
}

export function parseExpiresIn(expiresIn: string): number {
  const match = /^(\d+)([smhd])$/.exec(expiresIn);
  if (!match) throw new Error(`Invalid expiresIn format: ${expiresIn}`);
  const [, amount, unit] = match;
  const n = parseInt(amount!, 10);
  let multiplier: number;
  switch (unit) {
    case 's': multiplier = 1; break;
    case 'm': multiplier = 60; break;
    case 'h': multiplier = 3600; break;
    case 'd': multiplier = 86400; break;
    default: throw new Error(`Unknown unit: ${unit}`);
  }
  const seconds = n * multiplier;
  if (seconds <= 0 || !Number.isSafeInteger(seconds)) {
    throw new Error(`Invalid expiresIn duration: ${expiresIn}`);
  }
  return seconds;
}

// ─── Principal session tokens ────────────────────────────────────────────────

export interface PrincipalSessionPayload {
  principalId: string;
  developerId: string;
}

export async function signPrincipalSessionToken(
  payload: PrincipalSessionPayload,
  expiresInSeconds: number,
): Promise<string> {
  const { privateKey, kid } = getKeyPair();
  return new SignJWT({
    dev: payload.developerId,
    purpose: 'principal_dashboard',
  })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuer(config.jwtIssuer)
    .setSubject(payload.principalId)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + expiresInSeconds)
    .sign(privateKey);
}

export async function verifyPrincipalSessionToken(
  token: string,
): Promise<PrincipalSessionPayload> {
  const { publicKey } = getKeyPair();
  const { payload } = await jwtVerify(token, publicKey, {
    issuer: config.jwtIssuer,
    algorithms: ['RS256'],
  });

  if (payload['purpose'] !== 'principal_dashboard') {
    throw new Error('Invalid token purpose');
  }

  const principalId = payload.sub;
  const developerId = payload['dev'] as string | undefined;
  if (!principalId || !developerId) {
    throw new Error('Missing required claims');
  }

  return { principalId, developerId };
}

// ─── Prepaid-wallet payment authorizations ─────────────────────────────────

const PREPAID_WALLET_AUDIENCE = 'urn:grantex:x402:prepaid-wallet';

export interface WalletAuthorizationPayload {
  authorizationId: string;
  reservationId: string;
  walletId: string;
  assignmentId: string;
  agentId: string;
  principalId: string;
  developerId: string;
  grantId: string;
  amount: string;
  asset: string;
  network: string;
  recipient: string;
  resource: string;
  scope: string;
  merchantId?: string | null;
  purpose?: string | null;
  projectId?: string | null;
  costCenter?: string | null;
  requestHash: string;
  expiresAt: number;
}

export async function signWalletAuthorizationToken(
  authorization: WalletAuthorizationPayload,
): Promise<string> {
  const { privateKey, kid } = getKeyPair();
  return new SignJWT({
    purpose: 'prepaid_wallet_payment',
    reservation_id: authorization.reservationId,
    wallet_id: authorization.walletId,
    assignment_id: authorization.assignmentId,
    agent_id: authorization.agentId,
    principal_id: authorization.principalId,
    developer_id: authorization.developerId,
    grant_id: authorization.grantId,
    amount: authorization.amount,
    asset: authorization.asset,
    network: authorization.network,
    recipient: authorization.recipient,
    resource: authorization.resource,
    scope: authorization.scope,
    merchant_id: authorization.merchantId ?? null,
    payment_purpose: authorization.purpose ?? null,
    project_id: authorization.projectId ?? null,
    cost_center: authorization.costCenter ?? null,
    request_hash: authorization.requestHash,
  })
    .setProtectedHeader({ alg: 'RS256', kid, typ: 'wallet-auth+jwt' })
    .setIssuer(config.jwtIssuer)
    .setAudience(PREPAID_WALLET_AUDIENCE)
    .setSubject(authorization.agentId)
    .setJti(authorization.authorizationId)
    .setIssuedAt()
    .setExpirationTime(authorization.expiresAt)
    .sign(privateKey);
}

export async function verifyWalletAuthorizationToken(
  token: string,
): Promise<WalletAuthorizationPayload> {
  const { publicKey } = getKeyPair();
  const { payload, protectedHeader } = await jwtVerify(token, publicKey, {
    issuer: config.jwtIssuer,
    audience: PREPAID_WALLET_AUDIENCE,
    algorithms: ['RS256'],
  });

  if (protectedHeader.typ !== 'wallet-auth+jwt'
      || payload['purpose'] !== 'prepaid_wallet_payment') {
    throw new Error('Invalid wallet authorization token type');
  }

  const claims = {
    authorizationId: payload.jti,
    reservationId: payload['reservation_id'],
    walletId: payload['wallet_id'],
    assignmentId: payload['assignment_id'],
    agentId: payload['agent_id'],
    principalId: payload['principal_id'],
    developerId: payload['developer_id'],
    grantId: payload['grant_id'],
    amount: payload['amount'],
    asset: payload['asset'],
    network: payload['network'],
    recipient: payload['recipient'],
    resource: payload['resource'],
    scope: payload['scope'],
    requestHash: payload['request_hash'],
  };
  if (Object.values(claims).some((value) => typeof value !== 'string' || value.length === 0)
      || typeof payload.exp !== 'number' || !Number.isSafeInteger(payload.exp)) {
    throw new Error('Wallet authorization token is missing required claims');
  }
  const optionalClaims = {
    merchantId: payload['merchant_id'] ?? null,
    purpose: payload['payment_purpose'] ?? null,
    projectId: payload['project_id'] ?? null,
    costCenter: payload['cost_center'] ?? null,
  };
  if (Object.values(optionalClaims).some((value) => value !== null
      && (typeof value !== 'string' || value.length === 0))) {
    throw new Error('Wallet authorization token contains invalid optional claims');
  }

  return {
    authorizationId: claims.authorizationId as string,
    reservationId: claims.reservationId as string,
    walletId: claims.walletId as string,
    assignmentId: claims.assignmentId as string,
    agentId: claims.agentId as string,
    principalId: claims.principalId as string,
    developerId: claims.developerId as string,
    grantId: claims.grantId as string,
    amount: claims.amount as string,
    asset: claims.asset as string,
    network: claims.network as string,
    recipient: claims.recipient as string,
    resource: claims.resource as string,
    scope: claims.scope as string,
    merchantId: optionalClaims.merchantId as string | null,
    purpose: optionalClaims.purpose as string | null,
    projectId: optionalClaims.projectId as string | null,
    costCenter: optionalClaims.costCenter as string | null,
    requestHash: claims.requestHash as string,
    expiresAt: payload.exp,
  };
}
