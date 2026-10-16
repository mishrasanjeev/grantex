import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { createLoopbackFetch, RegistryDemo } from '../../scripts/lib/registry-demo.mjs';
import { emergencyStopReport, releaseLoopbackUrl } from '../../scripts/lib/release-report.mjs';

const origin = 'http://127.0.0.1:3199';

test('demo transport rejects external, DNS, ambiguous and unregistered origins', async () => {
  for (const value of ['https://provider.example', 'http://localhost:3199',
    'http://127.0.0.1', `${origin}/path`, `${origin}?x=1`, 'http://user:secret@127.0.0.1:3199']) {
    assert.throws(() => createLoopbackFetch([value]));
  }
  const request = createLoopbackFetch([origin]);
  for (const value of ['https://provider.example', 'http://127.0.0.1:3200',
    'http://127.0.0.1.provider.example:3199', 'http://user:secret@127.0.0.1:3199', `${origin}/#hidden`]) {
    assert.throws(() => request(value), /registered loopback/);
  }
});

test('demo POST cannot redirect its credential or passport body to another server', async () => {
  let forwarded = 0;
  const destination = createServer((_request, response) => { forwarded++; response.end('unexpected'); });
  destination.listen(0, '127.0.0.1');
  await once(destination, 'listening');
  const destinationUrl = `http://127.0.0.1:${destination.address().port}`;
  const source = createServer((_request, response) => {
    response.writeHead(307, { location: destinationUrl }); response.end();
  });
  source.listen(0, '127.0.0.1');
  await once(source, 'listening');
  try {
    const sourceUrl = `http://127.0.0.1:${source.address().port}`;
    await assert.rejects(createLoopbackFetch([sourceUrl])(sourceUrl, {
      method: 'POST', headers: { authorization: 'Bearer synthetic-fixture' }, body: 'synthetic-passport',
      redirect: 'follow',
    }));
    assert.equal(forwarded, 0);
  } finally {
    source.closeAllConnections(); destination.closeAllConnections();
    await new Promise(resolve => source.close(resolve));
    await new Promise(resolve => destination.close(resolve));
  }
});

test('demo status mapping rejects unknown issuer origins', () => {
  const demo = Object.create(RegistryDemo.prototype);
  demo.baseUrl = origin;
  demo.serve = { origin: 'http://127.0.0.1:3200' };
  assert.equal(demo.mapUrl('https://registry.example/status/1'), `${origin}/status/1`);
  assert.throws(() => demo.mapUrl('https://provider.example/status/1'), /unexpected issuer/);
});

test('destructive release rehearsals refuse non-loopback targets', () => {
  assert.equal(releaseLoopbackUrl(undefined), undefined);
  assert.equal(releaseLoopbackUrl(origin), origin);
  for (const value of ['https://api.grantex.dev', 'http://provider.example:3199',
    'http://127.0.0.1.provider.example:3199', `${origin}/v1`, `${origin}?x=1`,
    'http://secret@127.0.0.1:3199', 'http://127.0.0.1']) {
    assert.throws(() => releaseLoopbackUrl(value));
  }
});

function fixture() {
  return { runId: 'd2e5bb74-0338-4dbc-9ac7-7826d8fe8e44',
    agents: [{ name: 'synthetic-agent', mode: 'online', depth: 1, allowedCalls: 3 }],
    budgetMs: 2000, liveBefore: 2, latencies: [12.5],
    stop: { status: 'completed', lockout: false, sweeps: 2, grantsRevoked: 2,
      agentsStopped: ['ag_fixture'], stopId: '<script>untrusted-response</script>', extra: 'private-response' },
  };
}

test('release report retains measurements and local correlation, not response strings', () => {
  const report = emergencyStopReport(fixture());
  assert.equal(report.max_ms, 12.5);
  assert.equal(report.grants_revoked, 2);
  assert.equal(report.status, 'completed');
  assert.equal(report.run_id, fixture().runId);
  assert.ok(!JSON.stringify(report).includes('untrusted-response'));
  assert.ok(!JSON.stringify(report).includes('private-response'));
  assert.ok(!Object.hasOwn(report, 'stop_id'));
});

test('release report refuses malformed state, string counts and non-finite measurements', () => {
  for (const change of [
    f => { f.stop.status = 'unexpected'; }, f => { f.stop.lockout = true; },
    f => { f.stop.sweeps = '2'; }, f => { f.stop.grantsRevoked = -1; },
    f => { f.latencies = [NaN]; }, f => { f.latencies = [Infinity]; },
    f => { f.latencies = []; }, f => { f.runId = 'untrusted'; },
  ]) {
    const f = fixture(); change(f);
    assert.throws(() => emergencyStopReport(f));
  }
});
