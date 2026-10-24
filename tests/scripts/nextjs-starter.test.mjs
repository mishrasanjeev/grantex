import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { getOrCreateDemoAgent } from '../../examples/nextjs-starter/lib/demo-agent.ts';

const redirectUri = 'https://app.example/callback';

test('starter locks React and its renderer to the same version', () => {
  const lock = JSON.parse(readFileSync(new URL('../../examples/nextjs-starter/package-lock.json', import.meta.url), 'utf8'));
  assert.equal(lock.packages['node_modules/react'].version, lock.packages['node_modules/react-dom'].version);
});

test('starter registers its exact callback with a new demo agent', async () => {
  const client = { agents: {
    list: async () => ({ agents: [] }),
    register: async (params) => { assert.deepEqual(params.redirectUris, [redirectUri]); return { ...params, id: 'synthetic-agent' }; },
  } };
  assert.equal((await getOrCreateDemoAgent(client, redirectUri)).id, 'synthetic-agent');
});

test('starter repairs a reused demo agent without removing registered callbacks', async () => {
  const previous = 'https://previous.example/callback';
  const existing = { id: 'synthetic-agent', name: 'nextjs-demo-agent', redirectUris: [previous] };
  const client = { agents: {
    list: async () => ({ agents: [existing] }),
    update: async (id, params) => {
      assert.equal(id, existing.id);
      assert.deepEqual(params, { redirectUris: [previous, redirectUri] });
      return { ...existing, ...params };
    },
  } };
  await getOrCreateDemoAgent(client, redirectUri);
});

test('starter reuses an already registered callback without changing the agent', async () => {
  const existing = { id: 'synthetic-agent', name: 'nextjs-demo-agent', redirectUris: [redirectUri] };
  const client = { agents: { list: async () => ({ agents: [existing] }) } };
  assert.equal(await getOrCreateDemoAgent(client, redirectUri), existing);
});

test('starter registers a callback on a legacy demo agent with no redirect metadata', async () => {
  const existing = { id: 'synthetic-agent', name: 'nextjs-demo-agent' };
  const client = { agents: {
    list: async () => ({ agents: [existing] }),
    update: async (id, params) => {
      assert.equal(id, existing.id);
      assert.deepEqual(params.redirectUris, [redirectUri]);
      return { ...existing, ...params };
    },
  } };
  await getOrCreateDemoAgent(client, redirectUri);
});
