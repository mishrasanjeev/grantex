// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * The HTTP Message Signatures directory (draft-meunier-webbotauth-httpsig-directory-00)
 * and a request carrying a grantex and a web-bot-auth signature together,
 * the second naming the agent's directory in Signature-Agent (G50).
 */
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AgentHttpSigError,
  InMemoryNonceStore,
  SIGNATURE_DIRECTORY_MEDIA_TYPE,
  buildSignatureDirectory,
  combineSignatures,
  jwkThumbprint,
  publicJwk,
  signDirectoryResponse,
  signWithProfile,
  verifyDirectoryResponse,
  verifyWithProfile,
} from '../src/index.js';
import type { AgentJwk } from '../src/index.js';

const NOW = 1_790_000_000;
const ed: AgentJwk = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
const ec: AgentJwk = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' });

function served(keys: AgentJwk[], signing: AgentJwk[], created = NOW) {
  const body = JSON.stringify(buildSignatureDirectory(keys));
  const headers = signDirectoryResponse(body, { authority: 'agents.example', signingKeys: signing, created });
  return { status: 200, headers, body };
}

describe('signature directory', () => {
  it('lists each key once with kid = thumbprint and use = sig, public members only', () => {
    const doc = buildSignatureDirectory([ed, ec, ed]);
    expect(doc.keys.map((k) => k.kid)).toEqual([jwkThumbprint(ed), jwkThumbprint(ec)]);
    for (const k of doc.keys) {
      expect(k.use).toBe('sig');
      expect('d' in k).toBe(false);
    }
  });

  it('signs the response once per key over "@authority";req and content-digest', () => {
    const response = served([ed, ec], [ed, ec]);
    expect(response.headers['Content-Type']).toBe(SIGNATURE_DIRECTORY_MEDIA_TYPE);
    expect(response.headers['Signature-Input']).toBe(
      `sig1=("@authority";req "content-digest");created=${NOW};expires=${NOW + 300};keyid="${jwkThumbprint(ed)}";tag="http-message-signatures-directory", ` +
        `sig2=("@authority";req "content-digest");created=${NOW};expires=${NOW + 300};keyid="${jwkThumbprint(ec)}";tag="http-message-signatures-directory"`,
    );
    const out = verifyDirectoryResponse(response, { authority: 'agents.example', now: NOW + 10 });
    expect(out.keys.map((k) => k.kid)).toEqual([jwkThumbprint(ed), jwkThumbprint(ec)]);
    expect(out.ignored).toEqual([]);
  });

  it('ignores keys without their own valid signature (section 5.2)', () => {
    const partly = served([ed, ec], [ed]);
    expect(verifyDirectoryResponse(partly, { authority: 'agents.example', now: NOW + 10 })).toEqual({
      keys: [expect.objectContaining({ kid: jwkThumbprint(ed) })],
      ignored: [jwkThumbprint(ec)],
    });
    // Fetched from another authority, or after the signatures expired, or with a changed body.
    expect(verifyDirectoryResponse(partly, { authority: 'elsewhere.example', now: NOW + 10 }).keys).toEqual([]);
    expect(verifyDirectoryResponse(partly, { authority: 'agents.example', now: NOW + 400 }).keys).toEqual([]);
    const changed = { ...partly, body: partly.body.replace('"use":"sig"', '"use":"sig" ') };
    expect(verifyDirectoryResponse(changed, { authority: 'agents.example', now: NOW + 10 }).keys).toEqual([]);
  });

  it('ignores a key whose kid is not its thumbprint', () => {
    const doc = buildSignatureDirectory([ed]);
    doc.keys[0]!.kid = 'not-the-thumbprint';
    const body = JSON.stringify(doc);
    const headers = signDirectoryResponse(body, { authority: 'agents.example', signingKeys: [ed], created: NOW });
    expect(verifyDirectoryResponse({ status: 200, headers, body }, { authority: 'agents.example', now: NOW }).keys).toEqual([]);
  });

  it('is not a directory without the media type or a 200', () => {
    const response = served([ed], [ed]);
    expect(() => verifyDirectoryResponse({ ...response, headers: { ...response.headers, 'Content-Type': 'application/json' } }, { authority: 'agents.example', now: NOW })).toThrow(AgentHttpSigError);
    expect(() => verifyDirectoryResponse({ ...response, status: 302 }, { authority: 'agents.example', now: NOW })).toThrow(/200/);
  });
});

describe('grantex and web-bot-auth signatures on one request', () => {
  it('both verify, and the web-bot-auth one names the directory in Signature-Agent', async () => {
    const request = { method: 'POST', url: 'https://merchant.example/v1/checkout', body: '{"cart_id":"c-1001"}' };
    const grantex = signWithProfile(request, { key: ed, agentPassport: 'passport-placeholder', agentGrant: 'grant-placeholder', created: NOW });
    const wba = signWithProfile(request, {
      profile: 'web-bot-auth',
      key: ed,
      label: 'sig2',
      created: NOW,
      components: ['@method', '@authority', '@path', 'content-digest', 'signature-agent'],
      signatureAgent: { url: 'https://registry.example' },
    });
    const headers = combineSignatures(grantex, wba);
    expect(headers['Signature-Agent']).toBe('sig2="https://registry.example"');
    expect(Object.keys(headers)).toEqual(['Content-Digest', 'Agent-Passport', 'Agent-Grant', 'Signature-Agent', 'Signature-Input', 'Signature']);
    const message = { ...request, headers };
    const pub = publicJwk(ed);
    const g = await verifyWithProfile(message, { expectedAuthority: 'merchant.example', now: NOW + 1, nonceStore: new InMemoryNonceStore(), resolveKey: () => pub });
    expect(g).toMatchObject({ ok: true, profile: 'grantex', label: 'sig1' });
    const w = await verifyWithProfile(message, {
      profile: 'web-bot-auth', expectedAuthority: 'merchant.example', now: NOW + 1, nonceStore: new InMemoryNonceStore(),
      resolveKey: (ref) => (ref.signatureAgent?.url === 'https://registry.example' ? pub : null),
    });
    expect(w).toMatchObject({ ok: true, label: 'sig2', signatureAgent: { url: 'https://registry.example' } });
  });

  it('refuses a label used twice', () => {
    const request = { method: 'GET', url: 'https://merchant.example/' };
    const one = signWithProfile(request, { profile: 'web-bot-auth', key: ed, signatureAgent: { url: 'https://a.example' } });
    expect(() => combineSignatures(one, one)).toThrow(/used twice/);
  });
});
