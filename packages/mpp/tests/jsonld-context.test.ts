import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type TermDefinition = string | {
  '@id': string;
  '@type'?: string;
  '@container'?: string;
};

function readJson(relativeUrl: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(relativeUrl, import.meta.url), 'utf8')) as Record<string, unknown>;
}

describe('MPP JSON-LD context interoperability fixture', () => {
  it('defines every custom credential-subject term, including nested amount fields', () => {
    const contextDocument = readJson('../../../web/contexts/mpp-v1.json');
    const context = contextDocument['@context'] as Record<string, TermDefinition | boolean | number>;
    const fixture = readJson('./fixtures/agent-passport.jsonld.json');
    const subject = fixture['credentialSubject'] as Record<string, unknown>;

    for (const term of Object.keys(subject)) {
      if (term !== 'id' && term !== 'type') {
        expect(context[term], `missing JSON-LD definition for ${term}`).toBeDefined();
      }
    }

    const amount = subject['maxTransactionAmount'] as Record<string, unknown>;
    for (const term of Object.keys(amount)) {
      expect(context[term], `missing nested JSON-LD definition for ${term}`).toBeDefined();
    }

    expect(context['maxTransactionAmount']).toBe('grantex:maxTransactionAmount');
    expect(context['amount']).toEqual({
      '@id': 'grantex:amount',
      '@type': 'xsd:decimal',
    });
    expect(context['currency']).toBe('grantex:currency');
  });
});
