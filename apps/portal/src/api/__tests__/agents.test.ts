import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/constants', () => ({ API_BASE_URL: 'http://localhost:3000' }));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function ok(data: unknown, status = 200) {
  mockFetch.mockResolvedValueOnce({ ok: true, status, json: () => Promise.resolve(data) });
}
function noContent() {
  mockFetch.mockResolvedValueOnce({ ok: true, status: 204, json: () => Promise.resolve(undefined) });
}
function err(status: number, code: string, msg: string) {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    statusText: msg,
    json: () => Promise.resolve({ code, message: msg }),
  });
}

import { listAgents, getAgent, createAgent, updateAgent, deleteAgent } from '../agents';

describe('agents', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  // ── listAgents ─────────────────────────────────────────────────────────

  it('listAgents sends GET /v1/agents and unwraps .agents', async () => {
    const agents = [{ agentId: 'a1', name: 'Agent 1' }];
    ok({ agents });
    const result = await listAgents();
    expect(result).toEqual(agents);
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/v1/agents', expect.objectContaining({ method: 'GET' }));
  });

  it('listAgents throws on error', async () => {
    err(500, 'INTERNAL', 'Server error');
    await expect(listAgents()).rejects.toThrow('Server error');
  });

  // ── getAgent ───────────────────────────────────────────────────────────

  it('getAgent sends GET /v1/agents/:id', async () => {
    const agent = { agentId: 'a1', name: 'Agent 1' };
    ok(agent);
    const result = await getAgent('a1');
    expect(result).toEqual(agent);
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/v1/agents/a1', expect.objectContaining({ method: 'GET' }));
  });

  it('getAgent encodes id', async () => {
    ok({ agentId: 'a/b' });
    await getAgent('a/b');
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/v1/agents/a%2Fb', expect.anything());
  });

  it('getAgent throws on 404', async () => {
    err(404, 'NOT_FOUND', 'Agent not found');
    await expect(getAgent('missing')).rejects.toThrow('Agent not found');
  });

  // ── createAgent ────────────────────────────────────────────────────────

  it('createAgent sends POST /v1/agents with body', async () => {
    const data = { name: 'New Agent', scopes: ['read'] };
    const created = { agentId: 'a2', ...data };
    ok(created);
    const result = await createAgent(data as any);
    expect(result).toEqual(created);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:3000/v1/agents');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual(data);
  });

  it('createAgent throws on 400', async () => {
    err(400, 'VALIDATION', 'Name required');
    await expect(createAgent({} as any)).rejects.toThrow('Name required');
  });

  // ── updateAgent ────────────────────────────────────────────────────────

  it('updateAgent sends PATCH /v1/agents/:id with body', async () => {
    const data = { name: 'Updated' };
    ok({ agentId: 'a1', name: 'Updated' });
    await updateAgent('a1', data);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:3000/v1/agents/a1');
    expect(opts.method).toBe('PATCH');
    expect(JSON.parse(opts.body)).toEqual(data);
  });

  it('updateAgent throws on error', async () => {
    err(404, 'NOT_FOUND', 'Agent not found');
    await expect(updateAgent('missing', { name: 'x' })).rejects.toThrow('Agent not found');
  });

  // ── deleteAgent ────────────────────────────────────────────────────────

  it('deleteAgent sends DELETE /v1/agents/:id', async () => {
    noContent();
    await deleteAgent('a1');
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/v1/agents/a1', expect.objectContaining({ method: 'DELETE' }));
  });

  it('deleteAgent throws on error', async () => {
    err(404, 'NOT_FOUND', 'Agent not found');
    await expect(deleteAgent('missing')).rejects.toThrow('Agent not found');
  });
});
