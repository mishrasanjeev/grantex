import { describe, it, expect } from 'vitest';
import * as allManifests from '../src/manifests/index.js';

describe('Pre-built manifests', () => {
  const manifestEntries = Object.entries(allManifests);

  it('exports at least 50 manifests', () => {
    expect(manifestEntries.length).toBeGreaterThanOrEqual(50);
  });

  for (const [exportName, manifest] of manifestEntries) {
    describe(exportName, () => {
      it('has a non-empty connector name', () => {
        expect(manifest.connector).toBeTruthy();
        expect(typeof manifest.connector).toBe('string');
      });

      it('has at least one tool', () => {
        expect(manifest.toolCount).toBeGreaterThanOrEqual(1);
      });

      it('every tool has a valid permission', () => {
        const validPerms = ['read', 'write', 'delete', 'admin'];
        for (const [, perm] of Object.entries(manifest.tools)) {
          expect(validPerms).toContain(perm);
        }
      });
    });
  }
});
