import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Grantex } from '@grantex/sdk';
import { z } from 'zod';

export function registerAuthorizeTools(server: McpServer, grantex: Grantex): void {
  server.tool(
    'grantex_authorize',
    'Start an authorization flow — returns a consent URL for the user to approve',
    {
      agentId: z.string().describe('Agent ID (ag_...)'),
      userId: z.string().describe('Your application user identifier'),
      scopes: z.array(z.string()).describe('Scopes to request'),
      expiresIn: z.string().optional().describe('Grant lifetime (e.g. "24h", "7d")'),
      redirectUri: z.string().optional().describe('Callback URL after consent'),
    },
    async ({ agentId, userId, scopes, expiresIn, redirectUri }) => {
      const result = await grantex.authorize({
        agentId,
        userId,
        scopes,
        ...(expiresIn !== undefined ? { expiresIn } : {}),
        ...(redirectUri !== undefined ? { redirectUri } : {}),
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}
