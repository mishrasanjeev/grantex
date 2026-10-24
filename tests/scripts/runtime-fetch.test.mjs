import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('the production runtime bundles a patched Undici version', () => {
  const [major, minor, patch] = (process.versions.undici ?? '0.0.0').split('.').map(Number);
  assert.ok(major > 8 || (major === 8 && (minor > 12 || (minor === 12 && patch >= 2))),
    `Unpatched bundled Undici: ${process.versions.undici}`);
});

for (const mode of ['integrity', 'encodings']) {
  test(`native fetch ${mode} rejects malicious responses without crashing`, () => {
    const child = spawnSync(process.execPath, ['-e', `
      const assert = require('node:assert/strict');
      const { createServer } = require('node:http');
      const { createHash } = require('node:crypto');
      (async () => {
        const server = createServer((req, res) => {
          if (req.url === '/encodings') {
            res.writeHead(200, { 'content-encoding': 'gzip, gzip, gzip, gzip, gzip, gzip',
              'content-length': '100', 'content-type': 'application/json', 'x-content-type-options': 'nosniff' });
            res.flushHeaders();
            setTimeout(() => res.destroy(), 20);
          } else {
            res.writeHead(200, { 'content-type': 'application/json', 'x-content-type-options': 'nosniff' });
            res.end('"synthetic-response"');
          }
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const base = 'http://127.0.0.1:' + server.address().port;
        try {
          if (${JSON.stringify(mode)} === 'integrity') {
            // GHSA-f72v-6w45-q472 also affects Node's bundled fetch implementation.
            const correct = createHash('sha256').update('"synthetic-response"').digest('base64');
            const wrong = createHash('sha256').update('different-response').digest('base64');
            for (const algorithm of ['sha256', 'SHA256', 'Sha256']) {
              const response = await fetch(base, { integrity: algorithm + '-' + correct });
              assert.equal(await response.text(), '"synthetic-response"');
              await assert.rejects(fetch(base, { integrity: algorithm + '-' + wrong }), /fetch failed/);
            }
          } else {
            // GHSA-xjj6-f33q-929c: rejected encodings must not leave an orphan stream.
            await assert.rejects(fetch(base + '/encodings'), /fetch failed/);
            await new Promise(resolve => setTimeout(resolve, 100));
            assert.equal(await (await fetch(base)).text(), '"synthetic-response"');
          }
        } finally {
          server.closeAllConnections();
          await new Promise(resolve => server.close(resolve));
        }
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(child.error, undefined, child.error?.message);
    assert.equal(child.status, 0, child.stderr);
  });
}
