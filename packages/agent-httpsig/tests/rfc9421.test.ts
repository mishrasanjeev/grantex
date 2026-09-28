// SPDX-License-Identifier: Apache-2.0
/**
 * RFC 9421 section 2.5 and Appendix B.2: the signature bases rebuilt from the
 * RFC's own messages and Signature-Input values, and the B.2.4 (ECDSA P-256)
 * and B.2.6 (Ed25519) signatures verified with the RFC's public test keys.
 */
import { describe, expect, it } from 'vitest';
import { AgentHttpSigError, parseDictionary, signatureBaseFor, verifySignatureValue } from '../src/index.js';
import { vectors } from './helpers.js';

function withSignature(v: (typeof vectors.rfc9421)[number]) {
  const headers: [string, string][] = [
    ...v.message.headers,
    ['Signature-Input', v.signature_input],
    ['Signature', v.signature],
  ];
  return v.message.kind === 'request'
    ? { method: v.message.method, url: v.message.url, headers, body: v.message.body }
    : { status: v.message.status, headers, body: v.message.body };
}

describe('RFC 9421 signature bases', () => {
  for (const v of vectors.rfc9421) {
    it(`section ${v.section}`, () => {
      expect(signatureBaseFor(withSignature(v), v.label)).toBe(v.signature_base);
    });
  }
});

describe('RFC 9421 signatures with the RFC test keys', () => {
  for (const v of vectors.rfc9421.filter((x) => x.verify)) {
    it(`section ${v.section} (${v.verify!.alg})`, () => {
      const member = parseDictionary(v.signature).get(v.label);
      if (!member || 'items' in member || member.value.type !== 'binary') throw new Error('bad vector');
      const signature = member.value.value;
      expect(verifySignatureValue(v.verify!.public_jwk, v.signature_base, signature)).toBe(true);
      // One changed octet of the base fails.
      expect(verifySignatureValue(v.verify!.public_jwk, v.signature_base.replace('application/json', 'application/jsoN'), signature)).toBe(false);
    });
  }
});

describe('RFC 9421 section 2.5 errors', () => {
  const request = (signatureInput: string, headers: [string, string][] = []) => ({
    method: 'POST',
    url: 'https://example.com/foo?param=Value&Pet=dog',
    headers: [...headers, ['Signature-Input', signatureInput] as [string, string]],
  });

  it('refuses a component that appears twice (step 2.1)', () => {
    expect(() => signatureBaseFor(request('sig1=("@method" "@method");created=1'), 'sig1')).toThrow(AgentHttpSigError);
  });

  it('refuses a header field that is not in the message (step 2.5)', () => {
    expect(() => signatureBaseFor(request('sig1=("date");created=1'), 'sig1')).toThrow(AgentHttpSigError);
  });

  it('refuses a derived component it does not know', () => {
    expect(() => signatureBaseFor(request('sig1=("@unknown");created=1'), 'sig1')).toThrow(AgentHttpSigError);
  });

  it('refuses component parameters it does not implement', () => {
    expect(() => signatureBaseFor(request('sig1=("date";sf);created=1', [['Date', 'x']]), 'sig1')).toThrow(AgentHttpSigError);
    expect(() => signatureBaseFor(request('sig1=("@query-param";name="Pet");created=1'), 'sig1')).toThrow(AgentHttpSigError);
  });

  it('refuses @signature-params as a covered component (section 2.3)', () => {
    expect(() => signatureBaseFor(request('sig1=("@signature-params");created=1'), 'sig1')).toThrow(AgentHttpSigError);
  });

  it('refuses @status in a request (section 2.2.9)', () => {
    expect(() => signatureBaseFor(request('sig1=("@status");created=1'), 'sig1')).toThrow(AgentHttpSigError);
  });

  it('refuses a non-ASCII value (step 4)', () => {
    expect(() => signatureBaseFor(request('sig1=("x-name");created=1', [['X-Name', 'café']]), 'sig1')).toThrow(AgentHttpSigError);
  });

  it('refuses a label that is not in Signature-Input', () => {
    expect(() => signatureBaseFor(request('sig1=("@method");created=1'), 'sig2')).toThrow(AgentHttpSigError);
  });

  it('derives @query as "?" when there is no query (section 2.2.7) and @scheme lowercased (section 2.2.4)', () => {
    const base = signatureBaseFor(
      { method: 'GET', url: 'HTTPS://example.com/foo', headers: [['Signature-Input', 'sig1=("@query" "@scheme");created=1']] },
      'sig1',
    );
    expect(base).toBe('"@query": ?\n"@scheme": https\n"@signature-params": ("@query" "@scheme");created=1');
  });

  it('combines several field lines with ", " after trimming each (section 2.1)', () => {
    const base = signatureBaseFor(
      {
        method: 'GET',
        url: 'https://example.com/',
        headers: [
          ['Cache-Control', '  max-age=60 '],
          ['cache-control', 'must-revalidate'],
          ['Signature-Input', 'sig1=("cache-control");created=1'],
        ],
      },
      'sig1',
    );
    expect(base).toBe('"cache-control": max-age=60, must-revalidate\n"@signature-params": ("cache-control");created=1');
  });
});
