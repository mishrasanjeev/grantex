// SPDX-License-Identifier: Apache-2.0
/**
 * spec/registry-federation.md ("Status reconciliation"), the runbook
 * docs/runbooks/status-list-incident.md, the alert rules and
 * docs/self-hosting.md say what the auth service does: the decision table is
 * deriveAcceptance, the metrics table is the metrics the service registers,
 * every alert reads one of them, and the configuration defaults are the code's.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POLL_MIN_INTERVAL_MS,
  MAX_POLL_MIN_INTERVAL_MS,
  deriveAcceptance,
} from '../src/lib/registry/status-reconciliation.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
// Line endings as checked out (core.autocrlf on Windows) do not matter.
const read = (...path: string[]) => readFileSync(join(root, ...path), 'utf-8').replace(/\r\n/g, '\n');
const SPEC = read('spec', 'registry-federation.md');
const SECTION = SPEC.slice(SPEC.indexOf('## Status reconciliation'));
const RUNBOOK = read('docs', 'runbooks', 'status-list-incident.md');
const ALERTS = read('deploy', 'prometheus', 'registry-status-alerts.yml');
const SELF_HOSTING = read('docs', 'self-hosting.md');
const METRICS_SOURCE = read('apps', 'auth-service', 'src', 'lib', 'registry', 'reconciliation-metrics.ts');

/** The rows of the table after `<!-- name -->`, as arrays of cells. */
function table(name: string): string[][] {
  const start = SECTION.indexOf(`<!-- ${name} -->`);
  if (start < 0) throw new Error(`the Status reconciliation section has no ${name}`);
  const lines = SECTION.slice(start).split('\n').slice(1);
  const rows: string[][] = [];
  for (const line of lines) {
    if (!line.startsWith('|')) break;
    rows.push(line.split('|').slice(1, -1).map((cell) => cell.trim()));
  }
  return rows.slice(2);
}

const NOW = new Date('2026-09-28T12:00:00Z');
const ISSUERS = {
  active: { status: 'active' as const, suspendedEffectiveFrom: null },
  suspended: { status: 'suspended' as const, suspendedEffectiveFrom: new Date(NOW.getTime() - 1000) },
  withdrawn: { status: 'withdrawn' as const, suspendedEffectiveFrom: null },
};
const ENTRY = { VALID: 'valid', SUSPENDED: 'suspended', INVALID: 'invalid' } as const;

describe('spec/registry-federation.md, Status reconciliation', () => {
  it('the decision table is deriveAcceptance', () => {
    const rows = table('decision-table');
    expect(rows).toHaveLength(5);
    const reads = { fresh: new Date(NOW.getTime() + 60_000), stale: new Date(NOW.getTime() - 1) };
    for (const [listSays, read, issuer, entry, cause] of rows) {
      const statuses = listSays === 'any' ? ['valid', 'suspended', 'revoked'] as const : [listSays as 'valid' | 'suspended' | 'revoked'];
      const freshness = read === 'any' ? [reads.fresh, reads.stale] : [reads[read as keyof typeof reads]];
      const issuers = issuer === 'any'
        ? [ISSUERS.active, ISSUERS.suspended, ISSUERS.withdrawn]
        : issuer === 'active' ? [ISSUERS.active] : [ISSUERS.suspended, ISSUERS.withdrawn];
      const expected = entry === 'unchanged'
        ? null
        : { status: ENTRY[entry as keyof typeof ENTRY], cause: cause!.replace(/`/g, '') };
      for (const issuerStatus of statuses) {
        // First match wins: a row only speaks for the inputs no earlier row took.
        if (listSays === 'any' && issuerStatus === 'revoked') continue;
        for (const issuerStatusFreshUntil of freshness) {
          for (const record of issuers) {
            expect(deriveAcceptance({ issuerStatus, issuerStatusFreshUntil, issuer: record }, NOW), `${listSays} / ${read} / ${issuer}`)
              .toEqual(expected);
          }
        }
      }
    }
  });

  it('the metrics table is every metric the service registers, with its labels', () => {
    const documented = new Map(table('metrics-table').map(([name, labels]) => [
      name!.replace(/`/g, ''),
      labels === 'none' ? [] : labels!.split(',').map((label) => label.trim().replace(/`/g, '')),
    ]));
    const registered = new Map<string, string[]>();
    for (const match of METRICS_SOURCE.matchAll(/name: '([a-z_]+)',[\s\S]*?registers:/g)) {
      const labels = /labelNames: \[([^\]]*)\]/.exec(match[0]);
      registered.set(match[1]!, labels ? [...labels[1]!.matchAll(/'([a-z_]+)'/g)].map((label) => label[1]!) : []);
    }
    expect(registered.size).toBe(9);
    expect(Object.fromEntries(documented)).toEqual(Object.fromEntries(registered));
  });

  it('every alert reads a documented metric', () => {
    const documented = new Set(table('metrics-table').map(([name]) => name!.replace(/`/g, '')));
    const used = [...ALERTS.matchAll(/expr: [^\n]*|expr: >-\n(?:\s+[^\n]+\n)+/g)]
      .flatMap((match) => [...match[0].matchAll(/grantex_[a-z_]+/g)].map((name) => name[0]));
    expect(used.length).toBeGreaterThanOrEqual(5);
    for (const name of used) expect(documented, name).toContain(name);
    // One alert is for a list unreadable past its staleness.
    expect(ALERTS).toContain('max(grantex_registry_status_lists_stale) > 0');
  });

  it('the runbook explains every poll failure reason the spec lists', () => {
    const reasonsCell = table('metrics-table').find(([name]) => name === '`grantex_registry_status_list_poll_failures_total`')![2]!;
    const reasons = [...reasonsCell.matchAll(/`([a-z_]+)`/g)].map((match) => match[1]!);
    expect(reasons).toHaveLength(10);
    expect(reasons).toContain('issuer_changed');
    const explained = [...RUNBOOK.matchAll(/^ *\| `([a-z_]+)` \|/gm)].map((match) => match[1]!);
    expect(explained.sort()).toEqual([...reasons].sort());
  });

  it('the configuration defaults are the code\'s, and self-hosting lists both variables', () => {
    const rows = Object.fromEntries(table('config-table').map(([name, value]) => [name!.replace(/`/g, ''), value!.replace(/`/g, '')]));
    expect(rows).toEqual({
      REGISTRY_STATUS_RECONCILIATION_ENABLED: 'false',
      REGISTRY_STATUS_POLL_MIN_INTERVAL_MS: String(DEFAULT_POLL_MIN_INTERVAL_MS),
    });
    expect(SECTION).toContain(`at most ${MAX_POLL_MIN_INTERVAL_MS}`);
    expect(SELF_HOSTING).toMatch(/^\| `REGISTRY_STATUS_RECONCILIATION_ENABLED` \| No \| `false` \|.*`DATABASE_POOL_MAX` of at least 2/m);
    // Reconciliation needs a pool of two (validateConfig refuses one).
    expect(SECTION).toContain('Needs `DATABASE_POOL_MAX` of at least 2');
    expect(SELF_HOSTING).toMatch(new RegExp(`^\\| \`REGISTRY_STATUS_POLL_MIN_INTERVAL_MS\` \\| No \\| \`${DEFAULT_POLL_MIN_INTERVAL_MS}\` \\|`, 'm'));
  });
});
