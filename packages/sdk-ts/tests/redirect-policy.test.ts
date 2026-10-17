import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpClient } from '../src/http.js';
import { Grantex } from '../src/client.js';

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
async function listen(server: Server) {
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

describe('opt-in transport redirect refusal', () => {
  it.each(['request', 'stream'])('does not redirect a %s credential-bearing call', async (kind) => {
    let outsideCalls = 0;
    const outside = await listen(createServer((_req, res) => { outsideCalls++; res.end('{}'); }));
    const source = await listen(createServer((_req, res) => { res.writeHead(307, { Location: outside }); res.end(); }));
    const http = new HttpClient({ baseUrl: source, apiKey: 'synthetic-only', maxRetries: 0, rejectRedirects: true });
    await expect(kind === 'stream' ? http.rawGet('/events') : http.post('/operation', { synthetic: true })).rejects.toThrow();
    expect(outsideCalls).toBe(0);
  });
  it('preserves legacy following only when restriction is absent', async () => {
    let followed = 0;
    const outside = await listen(createServer((_req, res) => { followed++; res.end('{}'); }));
    const source = await listen(createServer((_req, res) => { res.writeHead(307, { Location: outside }); res.end(); }));
    const http = new HttpClient({ baseUrl: source, apiKey: 'synthetic-only', maxRetries: 0 });
    await http.get('/legacy');
    expect(followed).toBe(1);
  });
  it('propagates the public client option and rejects malformed values', async () => {
    const source = await listen(createServer((_req, res) => { res.writeHead(307, { Location: '/redirect' }); res.end(); }));
    const client = new Grantex({ baseUrl: source, apiKey: 'synthetic-only', maxRetries: 0, rejectRedirects: true });
    await expect(client.agents.list()).rejects.toThrow();
    expect(() => new HttpClient({ baseUrl: source, apiKey: 'synthetic-only', rejectRedirects: 'false' as never })).toThrow(TypeError);
  });
});
