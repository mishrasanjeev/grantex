import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Grantex } from '@grantex/sdk';
import { z } from 'zod';

export function registerTokenTools(server: McpServer, grantex: Grantex): void {
  server.tool(
    'grantex_token_exchange',
    'Exchange authorization code for grant token',
    {
      code: z.string().describe('Authorization code from consent callback'),
      agentId: z.string().describe('Agent ID (ag_...)'),
    },
    async ({ code, agentId }) => {
      const result = await grantex.tokens.exchange({ code, agentId });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'grantex_token_verify',
    'Verify a grant token and inspect its claims',
    {
      token: z.string().describe('JWT grant token to verify'),
    },
    async ({ token }) => {
      const result = await grantex.tokens.verify(token);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'grantex_token_revoke',
    'Revoke a grant token by its JTI',
    {
      tokenId: z.string().describe('Token JTI to revoke'),
    },
    async ({ tokenId }) => {
      await grantex.tokens.revoke(tokenId);
      return { content: [{ type: 'text' as const, text: 'Token revoked successfully.' }] };
    },
  );
}
