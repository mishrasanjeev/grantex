import type { Grantex } from '@grantex/sdk';

export async function getOrCreateDemoAgent(grantex: Grantex, redirectUri: string) {
  const { agents } = await grantex.agents.list();
  const existing = agents.find((agent) => agent.name === 'nextjs-demo-agent');
  if (existing) {
    if (existing.redirectUris?.includes(redirectUri)) return existing;
    return grantex.agents.update(existing.id, {
      redirectUris: [...(existing.redirectUris ?? []), redirectUri],
    });
  }
  return grantex.agents.register({
    name: 'nextjs-demo-agent',
    description: 'Temporary agent created by the Next.js starter demo',
    scopes: ['calendar:read', 'email:send'],
    redirectUris: [redirectUri],
  });
}
