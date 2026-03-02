import { describe, it, expect } from 'vitest';
import { buildGrantexAgentCard } from '../src/agent-card.js';

describe('buildGrantexAgentCard', () => {
  it('builds a minimal agent card', () => {
    const card = buildGrantexAgentCard({
      name: 'Test Agent',
      description: 'A test agent',
      url: 'https://agent.example.com/a2a',
      jwksUri: 'https://grantex.dev/.well-known/jwks.json',
      issuer: 'https://grantex.dev',
    });

    expect(card.name).toBe('Test Agent');
    expect(card.description).toBe('A test agent');
    expect(card.url).toBe('https://agent.example.com/a2a');
    expect(card.authentication?.schemes).toHaveLength(1);
    expect(card.authentication?.schemes[0]?.scheme).toBe('bearer');
    expect(card.authentication?.schemes[0]?.grantexConfig?.jwksUri).toBe('https://grantex.dev/.well-known/jwks.json');
    expect(card.authentication?.schemes[0]?.grantexConfig?.issuer).toBe('https://grantex.dev');
  });

  it('includes optional fields', () => {
    const card = buildGrantexAgentCard({
      name: 'Full Agent',
      description: 'A fully configured agent',
      url: 'https://agent.example.com/a2a',
      jwksUri: 'https://grantex.dev/.well-known/jwks.json',
      issuer: 'https://grantex.dev',
      requiredScopes: ['read', 'write'],
      delegationAllowed: true,
      version: '1.0.0',
      provider: { organization: 'Acme Corp', url: 'https://acme.example.com' },
      capabilities: { streaming: true, pushNotifications: false },
      skills: [{ id: 'search', name: 'Search', description: 'Search the web' }],
    });

    expect(card.version).toBe('1.0.0');
    expect(card.provider?.organization).toBe('Acme Corp');
    expect(card.capabilities?.streaming).toBe(true);
    expect(card.skills).toHaveLength(1);
    expect(card.authentication?.schemes[0]?.grantexConfig?.requiredScopes).toEqual(['read', 'write']);
    expect(card.authentication?.schemes[0]?.grantexConfig?.delegationAllowed).toBe(true);
  });

  it('sets default input/output modes', () => {
    const card = buildGrantexAgentCard({
      name: 'Test',
      description: 'Test',
      url: 'https://agent.example.com/a2a',
      jwksUri: 'https://grantex.dev/.well-known/jwks.json',
      issuer: 'https://grantex.dev',
    });

    expect(card.defaultInputModes).toEqual(['text/plain']);
    expect(card.defaultOutputModes).toEqual(['text/plain']);
  });

  it('omits undefined optional fields', () => {
    const card = buildGrantexAgentCard({
      name: 'Minimal',
      description: 'Minimal agent',
      url: 'https://agent.example.com/a2a',
      jwksUri: 'https://grantex.dev/.well-known/jwks.json',
      issuer: 'https://grantex.dev',
    });

    expect(card.version).toBeUndefined();
    expect(card.provider).toBeUndefined();
    expect(card.capabilities).toBeUndefined();
    expect(card.skills).toBeUndefined();
  });
});
