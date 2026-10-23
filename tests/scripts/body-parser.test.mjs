import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { deflateSync, gzipSync } from 'node:zlib';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const childIndex = process.argv.indexOf('--parser-child');
if (childIndex >= 0) {
  const directory = process.argv[childIndex + 1];
  const require = createRequire(new URL(`${directory}/package.json`, root));
  const parser = require('body-parser').json();
  const server = createServer((req, res) => {
    if (req.url === '/health') { res.end('ready'); return; }
    parser(req, res, error => {
      if (error) { res.statusCode = error.status ?? 500; res.end('rejected'); return; }
      // Complete the HTTP body only after decoding finished, exercising late bytes.
      req.once('end', () => res.end(JSON.stringify(req.body)));
      req.resume();
      process.send({ decoded: true });
    });
  });
  server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
} else {
  for (const directory of [
    'apps/mpp-demo-service', 'examples/x402-weather-api', 'packages/mcp', 'packages/mpp',
    'packages/express', 'packages/mcp-auth', 'packages/x402',
  ]) {
    for (const encoding of ['deflate', 'gzip']) {
      test(`${directory}: ${encoding} trailing bytes preserve parser liveness`, { timeout: 20_000 }, async () => {
        const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--parser-child', directory],
          { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
        let stderr = '';
        child.stderr.on('data', chunk => { stderr += chunk; });
        const exited = once(child, 'exit');
        let client;
        try {
          const port = await new Promise((resolve, reject) => {
            child.once('error', reject);
            child.once('exit', code => reject(new Error(`Parser exited before listening: ${code}: ${stderr}`)));
            child.on('message', message => { if (message.port) resolve(message.port); });
          });
          const plain = Buffer.from(JSON.stringify({ synthetic: true }));
          const frame = encoding === 'gzip' ? gzipSync(plain) : deflateSync(plain);
          const prefix = Buffer.concat([frame, Buffer.from([0])]);
          const tail = Buffer.alloc(4096, 0x58);
          const result = await new Promise((resolve, reject) => {
            client = request({ host: '127.0.0.1', port, method: 'POST', path: '/', agent: false,
              headers: { 'content-type': 'application/json', 'content-encoding': encoding,
                'content-length': prefix.length + tail.length } }, response => {
              let body = '';
              response.setEncoding('utf8');
              response.on('data', chunk => { body += chunk; });
              response.on('end', () => resolve({ status: response.statusCode, body }));
              response.on('error', reject);
            });
            child.on('message', message => { if (message.decoded) client.end(tail); });
            child.once('exit', code => reject(new Error(`Parser crashed: ${code}: ${stderr}`)));
            client.on('error', reject);
            client.setTimeout(5000, () => client.destroy(new Error('Parser did not finish HTTP body')));
            client.write(prefix);
          });
          assert.equal(result.status, 200);
          assert.deepEqual(JSON.parse(result.body), { synthetic: true });
          const health = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(5000) });
          assert.equal(await health.text(), 'ready');
          assert.equal(child.exitCode, null, stderr);
        } finally {
          client?.destroy();
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
          await exited;
        }
      });
    }
  }
}
