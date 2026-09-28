// SPDX-License-Identifier: Apache-2.0
/**
 * The auth service's copy of the Agent Passport verifier accepts exactly the
 * DIDs packages/agent-passport accepts (DID Core §3.1 syntax, no DID URL):
 * a `sub` or `provider.did` that a conforming implementation refuses is
 * refused here too.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isPassportDid } from '../src/lib/registry/passport-verify.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('isPassportDid', () => {
  it.each([
    'did:web:provider.example',
    'did:web:provider.example:agents:shopper-01',
    'did:grantex:ag_01',
    'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
    'did:web:provider.example%3A8443',
  ])('accepts %s', (did) => {
    expect(isPassportDid(did)).toBe(true);
  });

  it.each([
    'did:web:provider.example#key-1',
    'did:web:provider.example/path',
    'did:web:provider.example?service=x',
    'did:web:provider.example:',
    'did:web:provider example',
    'did:web: provider.example',
    'did:web:provider.example\n',
    'did:web:%zz',
    'did:Web:provider.example',
    'did:web:',
    'did:',
    'web:provider.example',
    42,
    null,
  ])('refuses %j', (value) => {
    expect(isPassportDid(value)).toBe(false);
  });

  it('uses the same expression as packages/agent-passport', () => {
    const pkg = readFileSync(join(repoRoot, 'packages', 'agent-passport', 'src', 'passport.ts'), 'utf8');
    const svc = readFileSync(join(repoRoot, 'apps', 'auth-service', 'src', 'lib', 'registry', 'passport-verify.ts'), 'utf8');
    const expr = /^const DID = (\/.+\/);$/m;
    const fromPkg = expr.exec(pkg)?.[1];
    expect(fromPkg).toBeDefined();
    expect(expr.exec(svc)?.[1]).toBe(fromPkg);
  });
});
