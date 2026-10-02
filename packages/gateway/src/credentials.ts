import { GatewayError } from './errors.js';

/**
 * Credentials by reference.
 *
 * With `credentialReference: on`, a client presents a credential reference
 * (`vcr_...`, from `POST /v1/vault/credentials/exchange` with
 * `delivery: "reference"`) in the `Grantex-Credential-Ref` header instead of a
 * credential. The gateway redeems it with its own API key
 * (`POST /v1/vault/credentials/resolve`) and injects the credential upstream, so
 * the agent never holds the secret. The auth service refuses a reference that
 * belongs to another grant, has expired, or whose grant is no longer active
 * (revoked or stopped), so a stopped agent's credential is never injected again.
 *
 * A request that presents no reference is proxied as before. A malformed
 * reference, or one the auth service refuses, denies the request; a failure to
 * reach the auth service is a 502. The gateway never forwards a request without
 * the credential the client asked to be injected. With the check on, the header
 * is not forwarded upstream; off, it is a header like any other.
 */

export const CREDENTIAL_REF_HEADER = 'grantex-credential-ref';
const REFERENCE_PATTERN = /^vcr_[0-9A-HJKMNP-TV-Z]{26}$/;
const RESOLVE_TIMEOUT_MS = 5_000;

export type CredentialReferenceCheck = 'on' | 'off';

export function checkCredentialReference(value: unknown): CredentialReferenceCheck {
  if (value === 'on' || value === 'off') return value;
  throw new Error("credentialReference must be 'on' or 'off'");
}

/**
 * The reference the client presented, or undefined when it presented none.
 * A malformed value is refused rather than forwarded or guessed at.
 */
export function readCredentialRef(headers: Record<string, string | string[] | undefined>): string | undefined {
  const raw = headers[CREDENTIAL_REF_HEADER];
  if (raw === undefined) return undefined;
  const value = (Array.isArray(raw) ? raw.join(',') : raw).trim();
  if (!REFERENCE_PATTERN.test(value)) {
    throw new GatewayError('CREDENTIAL_REF_INVALID', 'Grantex-Credential-Ref is not a credential reference', 400);
  }
  return value;
}

export interface ResolvedCredential {
  accessToken: string;
  service: string;
  credentialType: string;
}

export interface ResolveOptions {
  grantexBaseUrl: string;
  grantexApiKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Redeem a credential reference for the grant that presented it.
 *
 * A refusal by the auth service (another grant's reference, expired, the grant
 * no longer active, unknown) denies the request with 403; an auth service that
 * cannot be reached, refuses the gateway's own key or answers without a
 * credential is a 502.
 */
export async function resolveCredentialReference(
  credentialRef: string,
  grantId: string,
  options: ResolveOptions,
): Promise<ResolvedCredential> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${options.grantexBaseUrl.replace(/\/$/, '')}/v1/vault/credentials/resolve`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? RESOLVE_TIMEOUT_MS);
  let response: Response;
  let payload: Record<string, unknown> | null = null;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.grantexApiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ credentialRef, grantId }),
      signal: controller.signal,
    });
    // The timer stays armed until the body is read: an auth service that
    // answers its headers and then stalls on the body is a timeout too.
    try {
      payload = (await response.json()) as Record<string, unknown>;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err;
      payload = null; // not JSON: judged by the status below
    }
  } catch (err) {
    throw new GatewayError(
      'CREDENTIAL_RESOLVE_FAILED',
      `Could not resolve the credential reference: ${err instanceof Error ? err.message : String(err)}`,
      502,
    );
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401 || response.status >= 500) {
    // The gateway's own key, or the auth service itself: nothing the client did.
    throw new GatewayError(
      'CREDENTIAL_RESOLVE_FAILED',
      `The auth service could not resolve the credential reference (HTTP ${response.status})`,
      502,
    );
  }
  if (!response.ok) {
    const code = payload && typeof payload['code'] === 'string' ? payload['code'] : `HTTP ${response.status}`;
    throw new GatewayError('CREDENTIAL_REF_INVALID', `The credential reference was refused: ${code}`, 403);
  }
  const accessToken = payload?.['accessToken'];
  if (typeof accessToken !== 'string' || !accessToken) {
    throw new GatewayError('CREDENTIAL_RESOLVE_FAILED', 'The auth service answered without a credential', 502);
  }
  return {
    accessToken,
    service: typeof payload?.['service'] === 'string' ? payload['service'] : '',
    credentialType: typeof payload?.['credentialType'] === 'string' ? payload['credentialType'] : '',
  };
}
