import { describe, it, expect, vi, beforeEach } from 'vitest';
import { A2AGrantexClient } from '../src/client.js';

// Create a valid JWT for testing (header.payload.signature)
function createTestToken(payload: Record<string, unknown> = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({
    iss: 'https://grantex.dev',
    sub: 'user_123',
    agt: 'did:grantex:ag_TEST',
    dev: 'dev_TEST',
    scp: ['read', 'write'],
    jti: 'tok_TEST',
    grnt: 'grnt_TEST',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...payload,
  })).toString('base64url');
  const sig = Buffer.from('test-signature').toString('base64url');
  return `${header}.${body}.${sig}`;
}

function createExpiredToken(): string {
  return createTestToken({ exp: Math.floor(Date.now() / 1000) - 3600 });
}

describe('A2AGrantexClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('creates client with valid token', () => {
    const client = new A2AGrantexClient({
      agentUrl: 'https://agent.example.com/a2a',
      grantToken: createTestToken(),
    });
    expect(client).toBeDefined();
  });

  it('throws on expired token', () => {
    expect(() => new A2AGrantexClient({
      agentUrl: 'https://agent.example.com/a2a',
      grantToken: createExpiredToken(),
    })).toThrow('expired');
  });

  it('throws on missing required scope', () => {
    expect(() => new A2AGrantexClient({
      agentUrl: 'https://agent.example.com/a2a',
      grantToken: createTestToken({ scp: ['read'] }),
      requiredScope: 'admin',
    })).toThrow('missing required scope');
  });

  it('accepts token with required scope', () => {
    const client = new A2AGrantexClient({
      agentUrl: 'https://agent.example.com/a2a',
      grantToken: createTestToken({ scp: ['read', 'admin'] }),
      requiredScope: 'admin',
    });
    expect(client).toBeDefined();
  });

  it('sends task via JSON-RPC', async () => {
    const mockResponse = {
      jsonrpc: '2.0',
      id: 1,
      result: { id: 'task_1', status: { state: 'submitted' } },
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    } as Response);

    const client = new A2AGrantexClient({
      agentUrl: 'https://agent.example.com/a2a',
      grantToken: createTestToken(),
    });

    const task = await client.sendTask({
      message: { role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
    });

    expect(task.id).toBe('task_1');
    expect(task.status.state).toBe('submitted');

    const fetchCall = vi.mocked(fetch).mock.calls[0]!;
    expect(fetchCall[0]).toBe('https://agent.example.com/a2a');
    const reqInit = fetchCall[1]!;
    expect(reqInit.headers).toHaveProperty('Authorization');
  });

  it('gets task status', async () => {
    const mockResponse = {
      jsonrpc: '2.0',
      id: 1,
      result: { id: 'task_1', status: { state: 'completed' } },
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    } as Response);

    const client = new A2AGrantexClient({
      agentUrl: 'https://agent.example.com/a2a',
      grantToken: createTestToken(),
    });

    const task = await client.getTask({ id: 'task_1' });
    expect(task.status.state).toBe('completed');
  });

  it('cancels task', async () => {
    const mockResponse = {
      jsonrpc: '2.0',
      id: 1,
      result: { id: 'task_1', status: { state: 'canceled' } },
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    } as Response);

    const client = new A2AGrantexClient({
      agentUrl: 'https://agent.example.com/a2a',
      grantToken: createTestToken(),
    });

    const task = await client.cancelTask({ id: 'task_1' });
    expect(task.status.state).toBe('canceled');
  });

  it('throws on JSON-RPC error response', async () => {
    const mockResponse = {
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32600, message: 'Invalid Request' },
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    } as Response);

    const client = new A2AGrantexClient({
      agentUrl: 'https://agent.example.com/a2a',
      grantToken: createTestToken(),
    });

    await expect(client.sendTask({
      message: { role: 'user', parts: [{ type: 'text', text: 'test' }] },
    })).rejects.toThrow('A2A error -32600');
  });

  it('throws on HTTP error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    } as Response);

    const client = new A2AGrantexClient({
      agentUrl: 'https://agent.example.com/a2a',
      grantToken: createTestToken(),
    });

    await expect(client.sendTask({
      message: { role: 'user', parts: [{ type: 'text', text: 'test' }] },
    })).rejects.toThrow('A2A request failed: 500');
  });

  it('includes Bearer token in request headers', async () => {
    const token = createTestToken();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: { id: 't1', status: { state: 'submitted' } } }),
    } as Response);

    const client = new A2AGrantexClient({
      agentUrl: 'https://agent.example.com/a2a',
      grantToken: token,
    });

    await client.sendTask({ message: { role: 'user', parts: [{ type: 'text', text: 'hi' }] } });

    const fetchCall = vi.mocked(fetch).mock.calls[0]!;
    const headers = fetchCall[1]!.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${token}`);
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('returns token info', () => {
    const client = new A2AGrantexClient({
      agentUrl: 'https://agent.example.com/a2a',
      grantToken: createTestToken(),
    });

    const info = client.getTokenInfo();
    expect(info.sub).toBe('user_123');
    expect(info.agt).toBe('did:grantex:ag_TEST');
    expect(info.scp).toEqual(['read', 'write']);
  });

  it('strips trailing slash from agent URL', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: { id: 't1', status: { state: 'submitted' } } }),
    } as Response);

    const client = new A2AGrantexClient({
      agentUrl: 'https://agent.example.com/a2a/',
      grantToken: createTestToken(),
    });

    await client.sendTask({ message: { role: 'user', parts: [{ type: 'text', text: 'hi' }] } });

    const fetchCall = vi.mocked(fetch).mock.calls[0]!;
    expect(fetchCall[0]).toBe('https://agent.example.com/a2a');
  });
});
