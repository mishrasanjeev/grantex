import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);
for (const location of [
  'apps/auth-service/node_modules/fast-uri',
  'apps/auth-service/node_modules/fastify/node_modules/fast-uri',
]) {
  const uri = require(`${root}${location}`);
  test(`${location}: encoded schemes do not become active schemes`, () => {
    // GHSA-w74x-v6f9-j3xg: encoded scheme bytes must not become a live scheme.
    for (const input of ['%6Aavascript:alert(1)', '%u006Aavascript:alert(1)']) {
      assert.notEqual(uri.parse(input).scheme, 'javascript');
      assert.doesNotMatch(uri.normalize(input), /^javascript:/i);
    }
    assert.equal(uri.equal('%68ttp://issuer.example/', 'http://issuer.example/'), false);
  });
  test(`${location}: relative normalization preserves the resolved resource`, () => {
    // GHSA-xhq7-xmqj-769h: preserve document-relative path semantics.
    for (const reference of ['a/../b', '../x']) {
      const base = 'https://issuer.example/tenant/document';
      assert.equal(uri.resolve(base, uri.normalize(reference)), uri.resolve(base, reference));
    }
  });
  test(`${location}: malformed authorities are rejected`, () => {
    // GHSA-wjr9-j795-jxcr: do not silently canonicalize a different authority.
    for (const input of ['http://a@b@issuer.example/', 'http://iss\tuer.example/']) {
      assert.ok(uri.parse(input).error);
    }
    assert.equal(uri.parse('https://issuer.example/path').host, 'issuer.example');
  });
  test(`${location}: suffix references cannot introduce a scheme`, () => {
    // GHSA-333x-w4r6-6crp: suffix output must escape first-segment colons.
    const output = uri.serialize({ scheme: 'https', path: 'javascript:alert(1)' }, { reference: 'suffix' });
    assert.doesNotMatch(output, /^javascript:/i);
    assert.equal(uri.parse(output).scheme, undefined);
  });
}

for (const location of ['packages/vercel-ai/node_modules/undici', 'apps/portal/node_modules/undici']) {
  test(`${location}: EventSource retained parser state is bounded`, async () => {
    // GHSA-4qv8-2p9j-2685: tiny fields/chunks must not bypass the byte bound.
    const { finished } = await import('node:stream/promises');
    const { EventSourceStream } = require(`${root}${location}/lib/web/eventsource/eventsource-stream.js`);
    for (const mode of ['fields', 'chunks']) {
      const stream = new EventSourceStream({ maxEventSize: 131072 });
      stream.resume();
      const completion = finished(stream);
      const rejection = assert.rejects(completion, /EventSource message size exceeded/);
      if (mode === 'fields') {
        stream.end(Buffer.from('data:\n'.repeat(1025)));
      } else {
        for (let i = 0; i < 1025; i++) stream.write(Buffer.from('x'));
        stream.end();
      }
      await rejection;
    }
  });
  test(`${location}: integrity denial and excessive encodings preserve process liveness`, () => {
    // A child process makes an unhandled stream error a visible test failure.
    const code = `
      const assert = require('node:assert/strict');
      const { createServer } = require('node:http');
      const { createHash } = require('node:crypto');
      const { fetch, Agent } = require(${JSON.stringify(`${root}${location}`)});
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
        const dispatcher = new Agent();
        try {
          const correct = createHash('sha256').update('"synthetic-response"').digest('base64');
          const wrong = createHash('sha256').update('different-response').digest('base64');
          for (const algorithm of ['sha256', 'SHA256', 'Sha256']) {
            const response = await fetch(base, { dispatcher, integrity: algorithm + '-' + correct });
            assert.equal(await response.text(), '"synthetic-response"');
            await assert.rejects(fetch(base, { dispatcher, integrity: algorithm + '-' + wrong }), /fetch failed/);
          }
          await assert.rejects(fetch(base + '/encodings', { dispatcher }), /fetch failed/);
          await new Promise(resolve => setTimeout(resolve, 100));
          assert.equal(await (await fetch(base, { dispatcher })).text(), '"synthetic-response"');
        } finally {
          await dispatcher.close();
          server.closeAllConnections();
          await new Promise(resolve => server.close(resolve));
        }
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `;
    const child = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 15_000 });
    assert.equal(child.error, undefined, child.error?.message);
    assert.equal(child.status, 0, child.stderr);
  });
}
