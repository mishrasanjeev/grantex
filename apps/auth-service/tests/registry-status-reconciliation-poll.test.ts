// SPDX-License-Identifier: Apache-2.0
/**
 * The poll step's workers: a database error while recording one list is
 * that list's failure (reason `error`), and every other list is still read
 * and recorded before pollDueStatusLists returns, so no worker is left
 * writing after the run has released its lock.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/registry/attestations.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/registry/attestations.js')>(),
  readIssuerStatusListEntries: vi.fn(),
  recordIssuerStatusReads: vi.fn(),
  recordIssuerStatusAttempts: vi.fn(),
}));
vi.mock('../src/lib/registry/issuers.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/registry/issuers.js')>(),
  getAccreditedIssuer: vi.fn(async () => ({ entityId: 'https://issuer.example' })),
}));

import * as attestations from '../src/lib/registry/attestations.js';
import { registryStatusListPollFailuresTotal, registryStatusListPollsTotal } from '../src/lib/registry/reconciliation-metrics.js';
import { pollDueStatusLists } from '../src/lib/registry/status-reconciliation.js';

const NOW = new Date('2026-09-28T12:00:00Z');
const FIRST = 'https://issuer.example/status/1';
const SECOND = 'https://issuer.example/status/2';

/** A stand-in for the pool: the due lists, then each list's one attestation. */
function fakeSql() {
  return ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    if (text.includes('GROUP BY a.issuer_id')) {
      return Promise.resolve([FIRST, SECOND].map((uri) => ({
        issuer_id: 'iss_1', entity_id: 'https://issuer.example', status_list_uri: uri, due_at: NOW,
      })));
    }
    if (text.includes('SELECT id, status_list_idx')) {
      return Promise.resolve([{ id: `att_${String(values[1]).slice(-1)}`, status_list_idx: 0 }]);
    }
    return Promise.reject(new Error(`unexpected query: ${text}`));
  }) as never;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('pollDueStatusLists', () => {
  it('counts a database error on one list as that list\'s failure and finishes every other list first', async () => {
    const read = vi.mocked(attestations.readIssuerStatusListEntries);
    read.mockImplementation(async (_sql, _issuer, uri) => {
      // The second list answers later than the first fails.
      if (uri === SECOND) await new Promise((resolve) => setTimeout(resolve, 50));
      return { values: new Map([[0, 0]]), freshUntil: new Date(NOW.getTime() + 1_000), kid: 'k1' };
    });
    const recorded: string[] = [];
    vi.mocked(attestations.recordIssuerStatusReads).mockImplementation(async (_sql, reads) => {
      const id = reads[0]!.id;
      if (id === 'att_1') throw new Error('connection terminated');
      recorded.push(id);
      return [];
    });
    const failures = vi.spyOn(registryStatusListPollFailuresTotal, 'inc');
    const polls = vi.spyOn(registryStatusListPollsTotal, 'inc');
    const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };

    const result = await pollDueStatusLists(fakeSql(), { now: NOW, minIntervalMs: 1_000, log: log as never });

    expect(result).toEqual({ polled: 2, failed: 1, flips: 0 });
    // The other list was read and recorded before the call returned.
    expect(recorded).toEqual(['att_2']);
    expect(failures).toHaveBeenCalledWith({ reason: 'error' });
    expect(polls).toHaveBeenCalledWith({ outcome: 'failed' });
    expect(polls).toHaveBeenCalledWith({ outcome: 'ok' });
    expect(log.error).toHaveBeenCalled();
  });
});
