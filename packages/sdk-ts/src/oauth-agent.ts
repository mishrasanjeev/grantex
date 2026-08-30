import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  importJWK,
  jwtVerify,
  SignJWT,
  type CryptoKey,
  type JWK,
} from 'jose';
import { generatePkce } from './pkce.js';

const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';

export interface OAuthAuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  revocation_endpoint: string;
  pushed_authorization_request_endpoint: string;
  require_pushed_authorization_requests: true;
  response_types_supported: string[];
  grant_types_supported: string[];
  code_challenge_methods_supported: string[];
  authorization_response_iss_parameter_supported: true;
  dpop_signing_alg_values_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  revocation_endpoint_auth_methods_supported: string[];
}

export interface OAuthAgentClientOptions {
  issuer: string;
  clientId: string;
  redirectUri: string;
  resource: string;
  privateKey?: CryptoKey;
  publicJwk?: JWK;
  allowInsecureLoopback?: boolean;
}

export interface OAuthAgentKeyPair {
  privateKey: CryptoKey;
  publicJwk: JWK;
  thumbprint: string;
}

export async function generateOAuthAgentKey(): Promise<OAuthAgentKeyPair> {
  const generated = await generateKeyPair('ES256', { extractable: true });
  const publicJwk = await exportJWK(generated.publicKey);
  return {
    privateKey: generated.privateKey,
    publicJwk,
    thumbprint: await calculateJwkThumbprint(publicJwk, 'sha256'),
  };
}

export interface BeginAgentAuthorizationOptions {
  scopes: string[];
  principalHint?: string;
  authorizationDetails?: Array<Record<string, unknown>>;
}

export interface PendingAgentAuthorization {
  authorizationUrl: string;
  requestUri: string;
  state: string;
  expiresIn: number;
}

export interface OAuthAgentTokenResponse {
  access_token: string;
  token_type: 'DPoP';
  expires_in: number;
  refresh_token?: string;
  scope: string;
  issued_token_type?: string;
}

interface PendingState {
  codeVerifier: string;
  redirectUri: string;
  issuer: string;
  consumed: boolean;
}

export class OAuthAgentClient {
  readonly metadata: OAuthAuthorizationServerMetadata;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly resource: string;
  readonly publicJwk: JWK;
  readonly keyThumbprint: string;

  readonly #privateKey: CryptoKey;
  readonly #allowInsecureLoopback: boolean;
  readonly #pending = new Map<string, PendingState>();

  private constructor(options: {
    metadata: OAuthAuthorizationServerMetadata;
    clientId: string;
    redirectUri: string;
    resource: string;
    privateKey: CryptoKey;
    publicJwk: JWK;
    keyThumbprint: string;
    allowInsecureLoopback: boolean;
  }) {
    this.metadata = options.metadata;
    this.clientId = options.clientId;
    this.redirectUri = options.redirectUri;
    this.resource = options.resource;
    this.#privateKey = options.privateKey;
    this.#allowInsecureLoopback = options.allowInsecureLoopback;
    this.publicJwk = options.publicJwk;
    this.keyThumbprint = options.keyThumbprint;
  }

  static async create(options: OAuthAgentClientOptions): Promise<OAuthAgentClient> {
    const expectedIssuer = options.issuer;
    const allowInsecureLoopback = options.allowInsecureLoopback === true;
    assertSecureEndpoint(expectedIssuer, allowInsecureLoopback);
    const issuerUrl = new URL(expectedIssuer);
    if (issuerUrl.search || issuerUrl.hash) {
      throw new Error('issuer must not contain a query or fragment');
    }
    assertSecureEndpoint(options.redirectUri, allowInsecureLoopback);
    assertSecureEndpoint(options.resource, allowInsecureLoopback);
    if (new URL(options.redirectUri).hash || new URL(options.resource).hash) {
      throw new Error('redirectUri and resource must not contain fragments');
    }
    const metadataUrl = authorizationServerMetadataUrl(expectedIssuer);
    assertSecureEndpoint(metadataUrl, options.allowInsecureLoopback === true);
    const response = await fetch(metadataUrl, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Authorization-server metadata request failed with HTTP ${response.status}`);
    const metadata = response.json() as Promise<OAuthAuthorizationServerMetadata>;
    const validatedMetadata = validateMetadata(await metadata, expectedIssuer, allowInsecureLoopback);

    let privateKey = options.privateKey;
    let publicJwk = options.publicJwk;
    if ((privateKey === undefined) !== (publicJwk === undefined)) {
      throw new Error('privateKey and publicJwk must be provided together');
    }
    if (!privateKey || !publicJwk) {
      const generated = await generateOAuthAgentKey();
      privateKey = generated.privateKey;
      publicJwk = generated.publicJwk;
    }
    await validateAgentKeyPair(privateKey, publicJwk);
    const keyThumbprint = await calculateJwkThumbprint(publicJwk, 'sha256');
    return new OAuthAgentClient({
      metadata: validatedMetadata,
      clientId: options.clientId,
      redirectUri: options.redirectUri,
      resource: options.resource,
      privateKey,
      publicJwk,
      keyThumbprint,
      allowInsecureLoopback,
    });
  }

  async beginAuthorization(options: BeginAgentAuthorizationOptions): Promise<PendingAgentAuthorization> {
    if (options.scopes.length === 0 || options.scopes.length > 100
        || new Set(options.scopes).size !== options.scopes.length
        || options.scopes.some((scope) => scope.length === 0 || scope.length > 256
          || !/^[\x21\x23-\x5B\x5D-\x7E]+$/.test(scope))) {
      throw new Error('scopes must be a non-empty set of valid OAuth scope tokens');
    }
    if (options.principalHint !== undefined
        && (options.principalHint.length === 0 || options.principalHint.length > 256)) {
      throw new Error('principalHint must contain 1 to 256 characters');
    }
    const state = randomBytes(32).toString('base64url');
    const pkce = generatePkce();
    const params = new URLSearchParams({
      client_id: this.clientId,
      response_type: 'code',
      redirect_uri: this.redirectUri,
      scope: options.scopes.join(' '),
      state,
      code_challenge: pkce.codeChallenge,
      code_challenge_method: pkce.codeChallengeMethod,
      resource: this.resource,
      dpop_jkt: this.keyThumbprint,
    });
    if (options.principalHint !== undefined) params.set('login_hint', options.principalHint);
    if (options.authorizationDetails) {
      params.set('authorization_details', JSON.stringify(options.authorizationDetails));
    }
    const proof = await this.createDpopProof('POST', this.metadata.pushed_authorization_request_endpoint);
    const response = await fetch(this.metadata.pushed_authorization_request_endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        DPoP: proof,
      },
      body: params,
    });
    const result = await oauthJson<{ request_uri: string; expires_in: number }>(response);
    this.#pending.set(state, {
      codeVerifier: pkce.codeVerifier,
      redirectUri: this.redirectUri,
      issuer: this.metadata.issuer,
      consumed: false,
    });
    const authorizationUrl = new URL(this.metadata.authorization_endpoint);
    authorizationUrl.searchParams.set('client_id', this.clientId);
    authorizationUrl.searchParams.set('request_uri', result.request_uri);
    return {
      authorizationUrl: authorizationUrl.toString(),
      requestUri: result.request_uri,
      state,
      expiresIn: result.expires_in,
    };
  }

  async completeAuthorization(callbackUrl: string): Promise<OAuthAgentTokenResponse> {
    const callback = new URL(callbackUrl);
    const state = callback.searchParams.get('state');
    if (!state) throw new Error('Authorization response is missing state');
    const pending = this.#pending.get(state);
    if (!pending || pending.consumed) throw new Error('Authorization response state is unknown or already consumed');
    assertRedirectResponse(callback, pending.redirectUri);
    pending.consumed = true;
    this.#pending.delete(state);

    const responseIssuer = callback.searchParams.get('iss');
    if (responseIssuer !== pending.issuer) throw new Error('Authorization response issuer does not match the initiating session');
    const error = callback.searchParams.get('error');
    if (error) throw new Error(`Authorization failed: ${error}`);
    const code = callback.searchParams.get('code');
    if (!code) throw new Error('Authorization response is missing code');

    return this.tokenRequest(new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: this.clientId,
      redirect_uri: pending.redirectUri,
      code_verifier: pending.codeVerifier,
    }));
  }

  refresh(refreshToken: string): Promise<OAuthAgentTokenResponse> {
    return this.tokenRequest(new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.clientId,
    }));
  }

  attenuate(accessToken: string, scopes: string[]): Promise<OAuthAgentTokenResponse> {
    return this.tokenRequest(new URLSearchParams({
      grant_type: TOKEN_EXCHANGE_GRANT,
      client_id: this.clientId,
      subject_token: accessToken,
      subject_token_type: ACCESS_TOKEN_TYPE,
      requested_token_type: ACCESS_TOKEN_TYPE,
      scope: scopes.join(' '),
      resource: this.resource,
    }));
  }

  async revoke(token: string, tokenTypeHint?: 'access_token' | 'refresh_token'): Promise<void> {
    const proof = await this.createDpopProof('POST', this.metadata.revocation_endpoint);
    const params = new URLSearchParams({ client_id: this.clientId, token });
    if (tokenTypeHint) params.set('token_type_hint', tokenTypeHint);
    const response = await fetch(this.metadata.revocation_endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        DPoP: proof,
      },
      body: params,
    });
    if (!response.ok) await oauthJson(response);
  }

  async fetch(input: string | URL, accessToken: string, init: RequestInit = {}): Promise<Response> {
    const target = new URL(input);
    const resource = new URL(this.resource);
    if (target.origin !== resource.origin) {
      throw new Error('Protected-resource request origin does not match the configured resource');
    }
    assertSecureEndpoint(target.toString(), this.#allowInsecureLoopback);
    const method = (init.method ?? 'GET').toUpperCase();
    const proof = await this.createDpopProof(method, target.toString(), accessToken);
    const headers = new Headers(init.headers);
    headers.set('Authorization', `DPoP ${accessToken}`);
    headers.set('DPoP', proof);
    return fetch(target, { ...init, method, headers });
  }

  async createDpopProof(method: string, targetUri: string, accessToken?: string): Promise<string> {
    const target = new URL(targetUri);
    target.search = '';
    target.hash = '';
    return new SignJWT({
      htm: method.toUpperCase(),
      htu: target.toString(),
      jti: randomUUID(),
      iat: Math.floor(Date.now() / 1000),
      ...(accessToken
        ? { ath: createHash('sha256').update(accessToken, 'ascii').digest('base64url') }
        : {}),
    })
      .setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256', jwk: this.publicJwk })
      .sign(this.#privateKey);
  }

  async tokenRequest(params: URLSearchParams): Promise<OAuthAgentTokenResponse> {
    const proof = await this.createDpopProof('POST', this.metadata.token_endpoint);
    const response = await fetch(this.metadata.token_endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        DPoP: proof,
      },
      body: params,
    });
    const result = await oauthJson<OAuthAgentTokenResponse>(response);
    return validateTokenResponse(result);
  }
}

function validateMetadata(
  value: OAuthAuthorizationServerMetadata,
  expectedIssuer: string,
  allowInsecureLoopback: boolean,
): OAuthAuthorizationServerMetadata {
  if (!value || typeof value !== 'object' || value.issuer !== expectedIssuer) {
    throw new Error('Authorization-server metadata issuer does not match the configured issuer');
  }
  const endpoints = [
    value.authorization_endpoint,
    value.token_endpoint,
    value.jwks_uri,
    value.revocation_endpoint,
    value.pushed_authorization_request_endpoint,
  ];
  if (endpoints.some((endpoint) => typeof endpoint !== 'string')) {
    throw new Error('Authorization-server metadata is missing a required endpoint');
  }
  for (const endpoint of endpoints) assertSecureEndpoint(endpoint, allowInsecureLoopback);
  if (value.require_pushed_authorization_requests !== true
      || value.authorization_response_iss_parameter_supported !== true
      || !value.response_types_supported?.includes('code')
      || !value.grant_types_supported?.includes('authorization_code')
      || !value.grant_types_supported?.includes(TOKEN_EXCHANGE_GRANT)
      || !value.grant_types_supported?.includes('refresh_token')
      || !value.code_challenge_methods_supported?.includes('S256')
      || !value.dpop_signing_alg_values_supported?.includes('ES256')
      || !value.token_endpoint_auth_methods_supported?.includes('none')
      || !value.revocation_endpoint_auth_methods_supported?.includes('none')) {
    throw new Error('Authorization server does not advertise the capabilities required by the agent-grants profile');
  }
  return value;
}

function assertSecureEndpoint(value: string, allowInsecureLoopback: boolean): void {
  const parsed = new URL(value);
  const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
  if (parsed.protocol !== 'https:' && !(allowInsecureLoopback && loopback && parsed.protocol === 'http:')) {
    throw new Error(`OAuth endpoint must use HTTPS: ${value}`);
  }
  if (parsed.username || parsed.password || parsed.hash) throw new Error(`OAuth endpoint is malformed: ${value}`);
}

async function validateAgentKeyPair(privateKey: CryptoKey, publicJwk: JWK): Promise<void> {
  const privateFields = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'];
  if (privateFields.some((field) => publicJwk[field as keyof JWK] !== undefined)) {
    throw new Error('publicJwk must not contain private key material');
  }
  if (publicJwk.kty !== 'EC' || publicJwk.crv !== 'P-256'
      || typeof publicJwk.x !== 'string' || typeof publicJwk.y !== 'string') {
    throw new Error('OAuthAgentClient requires an ES256 P-256 public JWK');
  }
  try {
    const probe = await new SignJWT({ probe: true })
      .setProtectedHeader({ alg: 'ES256' })
      .setIssuedAt()
      .sign(privateKey);
    const publicKey = await importJWK(publicJwk, 'ES256');
    await jwtVerify(probe, publicKey, { algorithms: ['ES256'] });
  } catch {
    throw new Error('privateKey does not match publicJwk or cannot sign ES256 proofs');
  }
}

function assertRedirectResponse(callback: URL, registeredRedirectUri: string): void {
  const registered = new URL(registeredRedirectUri);
  if (registered.hash || callback.hash || callback.origin !== registered.origin
      || callback.pathname !== registered.pathname
      || callback.username || callback.password) {
    throw new Error('Authorization response URL does not match the registered redirect URI');
  }
  for (const [name, value] of registered.searchParams) {
    if (callback.searchParams.get(name) !== value) {
      throw new Error('Authorization response URL does not match the registered redirect URI');
    }
  }
  const responseParameters = new Set([
    'code', 'state', 'iss', 'error', 'error_description', 'error_uri',
  ]);
  for (const name of responseParameters) {
    if (callback.searchParams.getAll(name).length > 1) {
      throw new Error(`Authorization response parameter ${name} must occur at most once`);
    }
  }
  for (const name of callback.searchParams.keys()) {
    if (!registered.searchParams.has(name) && !responseParameters.has(name)) {
      throw new Error('Authorization response contains an unexpected redirect parameter');
    }
  }
}

function authorizationServerMetadataUrl(issuer: string): string {
  const parsed = new URL(issuer);
  const issuerPath = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '');
  parsed.pathname = `/.well-known/oauth-authorization-server${issuerPath}`;
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

function validateTokenResponse(value: OAuthAgentTokenResponse): OAuthAgentTokenResponse {
  if (!value || typeof value !== 'object'
      || typeof value.access_token !== 'string' || value.access_token.length === 0
      || value.token_type !== 'DPoP'
      || typeof value.expires_in !== 'number' || !Number.isSafeInteger(value.expires_in)
      || value.expires_in <= 0
      || typeof value.scope !== 'string' || value.scope.length === 0
      || (value.refresh_token !== undefined
        && (typeof value.refresh_token !== 'string' || value.refresh_token.length === 0))
      || (value.issued_token_type !== undefined
        && value.issued_token_type !== ACCESS_TOKEN_TYPE)) {
    throw new Error('Authorization server returned an invalid DPoP token response');
  }
  return value;
}

async function oauthJson<T = unknown>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    const error = typeof body?.['error'] === 'string' ? body['error'] : `HTTP ${response.status}`;
    const description = typeof body?.['error_description'] === 'string' ? body['error_description'] : '';
    throw new Error(description ? `${error}: ${description}` : error);
  }
  return body as T;
}
