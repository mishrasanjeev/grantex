/**
 * The auth service builds and verifies evidence packages with a copy of the
 * TypeScript SDK's evidence modules (the service does not depend on the SDK
 * package). These tests keep the copy identical and check it against the
 * shared fixtures and the service's own audit hash.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { computeAuditHash } from '../src/lib/hash.js';
import { auditEntryHash } from '../src/lib/evidence/hashing.js';
import { verifyPackage } from '../src/lib/evidence/verify.js';

const here = dirname(fileURLToPath(import.meta.url));
const COPY = join(here, '..', 'src', 'lib', 'evidence');
const SDK = join(here, '..', '..', '..', 'packages', 'sdk-ts', 'src', 'evidence');
const FIXTURES = join(here, '..', '..', '..', 'spec', 'examples', 'evidence');
const normalise = (text: string): string => text.replace(/\r\n/g, '\n');
const expected = JSON.parse(readFileSync(join(FIXTURES, 'expected.json'), 'utf8')) as Record<string, { root: string; anchor_hash?: string }>;

describe('evidence modules shared with the TypeScript SDK', () => {
  it('are byte-for-byte copies of packages/sdk-ts/src/evidence', () => {
    const copied = readdirSync(COPY).filter((name) => name.endsWith('.ts')).sort();
    expect(copied).toEqual([
      'build.ts', 'canonical.ts', 'checks.ts', 'document.ts', 'hashing.ts', 'result.ts', 'schema-1.0.ts', 'schema.ts', 'signature.ts', 'verify.ts',
    ]);
    for (const name of copied) {
      // The SDK's evidence/canonical.ts re-exports the shared src/canonical.ts; the service copies that file.
      const source = name === 'canonical.ts' ? join(SDK, '..', 'canonical.ts') : join(SDK, name);
      expect(normalise(readFileSync(join(COPY, name), 'utf8')), `${name} differs from the SDK; copy it again`)
        .toBe(normalise(readFileSync(source, 'utf8')));
    }
  });

  it('verify the shared fixture packages', () => {
    for (const name of ['evidence-package.json', 'evidence-package-disclosed.json']) {
      const result = verifyPackage(readFileSync(join(FIXTURES, name)), { expectedRoot: expected[name]!.root });
      expect(result.ok, `${name}: ${result.code}`).toBe(true);
    }
  });

  it('compute anchor hashes exactly as the audit chain does', () => {
    const anchor = (JSON.parse(readFileSync(join(FIXTURES, 'evidence-package.json'), 'utf8')) as { anchor: { audit_entry: Record<string, any> } }).anchor.audit_entry; // eslint-disable-line @typescript-eslint/no-explicit-any
    const serviceHash = computeAuditHash({
      id: anchor['id'], agentId: anchor['agentId'], agentDid: anchor['agentDid'], grantId: anchor['grantId'],
      principalId: anchor['principalId'], developerId: anchor['developerId'], action: anchor['action'],
      metadata: anchor['metadata'], timestamp: anchor['timestamp'], prevHash: anchor['prevHash'], status: anchor['status'],
    });
    expect(serviceHash).toBe(anchor['hash']);
    expect(auditEntryHash(anchor)).toBe(serviceHash);
    expect(serviceHash).toBe(expected['evidence-package.json']!.anchor_hash);
  });
});
