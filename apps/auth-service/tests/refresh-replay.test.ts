import { describe, expect, it } from 'vitest';
import { openRefreshReplayToken, sealRefreshReplayToken } from '../src/lib/refresh-replay.js';

describe('encrypted refresh replay state', () => {
  it('round-trips an access token without retaining it as plaintext', () => {
    const token = 'header.payload.signature';
    const sealed = sealRefreshReplayToken(token);

    expect(sealed).toMatch(/^enc:v1:/);
    expect(sealed).not.toContain(token);
    expect(openRefreshReplayToken(sealed)).toBe(token);
  });

  it('rejects plaintext, unknown envelopes, and tampered ciphertext', () => {
    const sealed = sealRefreshReplayToken('header.payload.signature');
    const bytes = Buffer.from(sealed.slice('enc:v1:'.length), 'base64');
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    const tampered = `enc:v1:${bytes.toString('base64')}`;

    expect(openRefreshReplayToken('header.payload.signature')).toBeNull();
    expect(openRefreshReplayToken(`enc:v2:${sealed.slice(7)}`)).toBeNull();
    expect(openRefreshReplayToken(tampered)).toBeNull();
  });
});
