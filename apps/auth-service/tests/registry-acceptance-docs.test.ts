// SPDX-License-Identifier: Apache-2.0
/**
 * The examples in spec/registry-federation.md ("Attestation acceptance status
 * lists") are what the auth service publishes: each marked JSON block is
 * compared with the output built for the same list at the same instant.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeProtectedHeader } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { initKeys } from '../src/lib/crypto.js';
import {
  acceptanceListUri,
  resetAcceptanceStatusCache,
  signBitstringStatusListCredential,
  signTokenStatusList,
  type AcceptanceSnapshot,
} from '../src/lib/registry/acceptance-status.js';
import {
  ACCEPTANCE_LIST_CAPACITY,
  decodeBitstringStatusList,
  decodeTokenStatusList,
} from '../src/lib/registry/status-list-codec.js';

const here = dirname(fileURLToPath(import.meta.url));
const SPEC = readFileSync(join(here, '..', '..', '..', 'spec', 'registry-federation.md'), 'utf-8');
const EXAMPLE_HOST = 'https://registry.example';
const LIST_ID = 'racl_01J8Z3K4M5N6P7Q8R9S0T1V2W3';
const NOW = new Date('2026-09-28T12:00:00Z');

function example(name: string, source: string = SPEC): Record<string, unknown> {
  const match = source.replace(/\r\n/g, '\n').match(new RegExp(`<!-- example: ${name} -->\\s*\`\`\`json\\n([\\s\\S]*?)\\n\`\`\``));
  if (!match) throw new Error(`spec/registry-federation.md has no example ${name}`);
  return JSON.parse(match[1]!) as Record<string, unknown>;
}

/** The service's own base URL, written as the example host. */
function asExample<T>(value: T): T {
  const base = acceptanceListUri(LIST_ID).slice(0, -`/status/attestations/${LIST_ID}`.length);
  return JSON.parse(JSON.stringify(value).split(base).join(EXAMPLE_HOST)) as T;
}

const snapshot: AcceptanceSnapshot = {
  listId: LIST_ID,
  uri: acceptanceListUri(LIST_ID),
  capacity: ACCEPTANCE_LIST_CAPACITY,
  version: 1,
  updatedAt: new Date('2026-09-28T11:00:00Z'),
  cascadeAt: null,
  entries: [],
};

beforeAll(async () => {
  await initKeys();
  resetAcceptanceStatusCache();
});

describe('spec/registry-federation.md examples', () => {
  it('extracts identical examples from LF and CRLF checkouts', () => {
    const lf = SPEC.replace(/\r\n/g, '\n');
    const crlf = lf.replace(/\n/g, '\r\n');
    for (const name of ['tsl-header', 'tsl-payload', 'bsl-header', 'bsl-payload']) {
      expect(example(name, crlf)).toEqual(example(name, lf));
    }
  });
  it('Token Status List header and claims', async () => {
    const signed = await signTokenStatusList(snapshot, NOW);
    const header = decodeProtectedHeader(signed.token);
    const documented = example('tsl-header');
    expect(header.typ).toBe(documented['typ']);
    expect(Object.keys(header).sort()).toEqual(Object.keys(documented).sort());

    const documentedClaims = example('tsl-payload');
    const claims = asExample(signed.claims);
    expect(claims).toEqual(documentedClaims);
    const list = decodeTokenStatusList(documentedClaims['status_list'] as { bits: 2; lst: string });
    expect(list.size).toBe(ACCEPTANCE_LIST_CAPACITY);
  });

  it('Bitstring Status List header and credential', async () => {
    const signed = await signBitstringStatusListCredential(snapshot, 'revocation', NOW);
    const header = decodeProtectedHeader(signed.token);
    const documented = example('bsl-header');
    expect(header.typ).toBe(documented['typ']);
    expect(header.cty).toBe(documented['cty']);
    expect(Object.keys(header).sort()).toEqual(Object.keys(documented).sort());

    const documentedClaims = example('bsl-payload');
    const claims = asExample(signed.claims);
    // GZIP output differs between compressors; the bitstrings must not.
    const subject = claims['credentialSubject'] as Record<string, unknown>;
    const documentedSubject = documentedClaims['credentialSubject'] as Record<string, unknown>;
    const ours = decodeBitstringStatusList(subject['encodedList'] as string);
    const theirs = decodeBitstringStatusList(documentedSubject['encodedList'] as string);
    expect(ours.length).toBe(theirs.length);
    expect({ ...claims, credentialSubject: { ...subject, encodedList: '' } })
      .toEqual({ ...documentedClaims, credentialSubject: { ...documentedSubject, encodedList: '' } });
  });
});
