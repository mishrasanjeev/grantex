import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Grantex } from '@grantex/sdk';
import { z } from 'zod';

export function registerPrincipalSessionTools(server: McpServer, grantex: Grantex): void {
  server.tool(
    'grantex_principal_session_create',
    'Create a principal session for end-user permission management',
    {
      principalId: z.string().describe('Principal (end-user) ID'),
      expiresIn: z.string().optional().describe('Session lifetime (e.g. "1h", "30m")'),
    },
    async ({ principalId, expiresIn }) => {
      const result = await grantex.principalSessions.create({
        principalId,
        ...(expiresIn !== undefined ? { expiresIn } : {}),
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}
