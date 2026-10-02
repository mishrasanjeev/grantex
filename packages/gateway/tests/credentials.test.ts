import { describe, it, expect, vi } from 'vitest';
import {
  CREDENTIAL_REF_HEADER,
  checkCredentialReference,
  readCredentialRef,
  resolveCredentialReference,
} from '../src/credentials.js';
import { GatewayError } from '../src/errors.js';

const REFERENCE = 'vcr_01J9ZK3X6Q0Z6W7F0X2Y1V8K3M';
const OPTIONS = { grantexBaseUrl: 'https://auth.example.com/', grantexApiKey: 'gx_key_1' };

function answer(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body),
  }) as unknown as typeof fetch;
}

async function denial(promise: Promise<unknown>): Promise<GatewayError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof GatewayError) return err;
    throw err;
  }
  throw new Error('expected a GatewayError');
}

describe('checkCredentialReference', () => {
  it('accepts on and off and refuses anything else', () => {
    expect(checkCredentialReference('on')).toBe('on');
    expect(checkCredentialReference('off')).toBe('off');
    expect(() => checkCredentialReference('yes')).toThrow("credentialReference must be 'on' or 'off'");
    expect(() => checkCredentialReference(true)).toThrow();
  });
});

describe('readCredentialRef', () => {
  it('returns the presented reference, trimmed, or undefined when none was presented', () => {
    expect(readCredentialRef({})).toBeUndefined();
    expect(readCredentialRef({ [CREDENTIAL_REF_HEADER]: ` ${REFERENCE} ` })).toBe(REFERENCE);
    expect(readCredentialRef({ [CREDENTIAL_REF_HEADER]: [REFERENCE] })).toBe(REFERENCE);
  });

  it('refuses a malformed reference with 400 rather than forwarding it', () => {
    for (const value of ['', 'not-a-reference', 'vcr_short', `${REFERENCE},${REFERENCE}`]) {
      let error: GatewayError | undefined;
      try {
        readCredentialRef({ [CREDENTIAL_REF_HEADER]: value });
      } catch (err) {
        error = err as GatewayError;
      }
      expect(error?.code).toBe('CREDENTIAL_REF_INVALID');
      expect(error?.statusCode).toBe(400);
    }
  });
});

describe('resolveCredentialReference', () => {
  it('redeems the reference for the grant with the gateway key and returns the credential', async () => {
    const fetchImpl = answer(200, { accessToken: 'ya29.token', service: 'google', credentialType: 'oauth2' });
    const resolved = await resolveCredentialReference(REFERENCE, 'grnt_1', { ...OPTIONS, fetchImpl });
    expect(resolved).toEqual({ accessToken: 'ya29.token', service: 'google', credentialType: 'oauth2' });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://auth.example.com/v1/vault/credentials/resolve');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer gx_key_1');
    expect(JSON.parse(init.body as string)).toEqual({ credentialRef: REFERENCE, grantId: 'grnt_1' });
  });

  it('denies the request when the auth service refuses the reference', async () => {
    for (const [status, code] of [[403, 'GRANT_INACTIVE'], [404, 'NOT_FOUND'], [410, 'CREDENTIAL_REFERENCE_EXPIRED']] as const) {
      const error = await denial(resolveCredentialReference(REFERENCE, 'grnt_1', { ...OPTIONS, fetchImpl: answer(status, { code }) }));
      expect(error.code).toBe('CREDENTIAL_REF_INVALID');
      expect(error.statusCode).toBe(403);
      expect(error.message).toContain(code);
    }
  });

  it('answers 502 when the auth service cannot be reached, refuses the gateway key, fails or answers without a credential', async () => {
    const unreachable = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
    for (const fetchImpl of [unreachable, answer(401, { code: 'UNAUTHORIZED' }), answer(500, {}), answer(200, { service: 'google' })]) {
      const error = await denial(resolveCredentialReference(REFERENCE, 'grnt_1', { ...OPTIONS, fetchImpl }));
      expect(error.code).toBe('CREDENTIAL_RESOLVE_FAILED');
      expect(error.statusCode).toBe(502);
    }
  });
});
