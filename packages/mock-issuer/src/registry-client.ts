// SPDX-License-Identifier: Apache-2.0
//
// Hand an attestation to a registry: POST the compact JWS itself as the body,
// with Content-Type application/grantex-attestation+jwt, to
// <registry base URL>/v1/registry/attestations (spec/attestation-1.0.md §5).
// The registry refuses JSON with 415. The route takes no API key: the
// issuer's signature over the attestation is the authentication, so no
// credential is sent.

import { MockIssuerError } from './errors.ts';

export const DEFAULT_ATTESTATION_PATH = '/v1/registry/attestations';
/** The attestation's own media type (typ grantex-attestation+jwt); the registry also takes application/jwt. */
export const ATTESTATION_MEDIA_TYPE = 'application/grantex-attestation+jwt';
/** How long to wait for the registry before giving up. */
export const REGISTRY_TIMEOUT_MS = 10_000;
/** The most of the registry's answer that is read; a refusal or record is far smaller. */
export const MAX_REGISTRY_RESPONSE_BYTES = 65_536;

export interface PostAttestationParams {
  registryBaseUrl: string;
  attestation: string;
  path?: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export interface PostAttestationResult {
  status: number;
  body: unknown;
}

/** Read at most `limit` bytes of the body; more than that is a refusal, never buffered. */
async function boundedText(response: Response, limit: number): Promise<string> {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new MockIssuerError('registry_refused', `the registry's answer is larger than ${limit} bytes`, {
        httpStatus: response.status,
      });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function postAttestation(params: PostAttestationParams): Promise<PostAttestationResult> {
  let url: URL;
  try {
    url = new URL(`${params.registryBaseUrl.replace(/\/+$/, '')}${params.path ?? DEFAULT_ATTESTATION_PATH}`);
  } catch (cause) {
    throw new MockIssuerError('invalid_request', 'the registry base URL is not a URL', { cause });
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new MockIssuerError('invalid_request', 'the registry base URL must be http or https');
  }
  const signal = AbortSignal.timeout(params.timeoutMs ?? REGISTRY_TIMEOUT_MS);
  let response: Response;
  let text: string;
  try {
    response = await (params.fetch ?? globalThis.fetch)(url, {
      method: 'POST',
      headers: { 'content-type': ATTESTATION_MEDIA_TYPE, accept: 'application/json' },
      body: params.attestation,
      redirect: 'error',
      signal,
    });
    text = await boundedText(response, MAX_REGISTRY_RESPONSE_BYTES);
  } catch (cause) {
    // Fail closed: a refusal is rethrown as is; a network error or timeout is unreachable.
    if (cause instanceof MockIssuerError) throw cause;
    throw new MockIssuerError('registry_unreachable', `the registry at ${url.origin} could not be reached`, { cause });
  }
  let body: unknown = text;
  try {
    body = text === '' ? null : JSON.parse(text);
  } catch {
    // Not JSON: keep the text as the body; the status alone decides the outcome.
  }
  if (!response.ok) {
    // Fail closed: anything but 2xx means the registry did not take the attestation.
    throw new MockIssuerError('registry_refused', `the registry answered ${response.status}`, {
      httpStatus: response.status,
      body,
    });
  }
  return { status: response.status, body };
}
