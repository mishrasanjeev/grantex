import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Grantex } from '@grantex/sdk';
import { z } from 'zod';

export function registerGrantTools(server: McpServer, grantex: Grantex): void {
  server.tool(
    'grantex_grant_list',
    'List grants with optional filters',
    {
      agentId: z.string().optional().describe('Filter by agent ID'),
      principalId: z.string().optional().describe('Filter by principal (user) ID'),
      status: z.enum(['active', 'revoked', 'expired']).optional().describe('Filter by status'),
    },
    async ({ agentId, principalId, status }) => {
      const params: Record<string, string> = {};
      if (agentId !== undefined) params['agentId'] = agentId;
      if (principalId !== undefined) params['principalId'] = principalId;
      if (status !== undefined) params['status'] = status;
      const result = await grantex.grants.list(params);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'grantex_grant_get',
    'Get details for a specific grant',
    {
      grantId: z.string().describe('Grant ID (grnt_...)'),
    },
    async ({ grantId }) => {
      const grant = await grantex.grants.get(grantId);
      return { content: [{ type: 'text' as const, text: JSON.stringify(grant, null, 2) }] };
    },
  );

  server.tool(
    'grantex_grant_revoke',
    'Revoke an active grant',
    {
      grantId: z.string().describe('Grant ID to revoke'),
    },
    async ({ grantId }) => {
      await grantex.grants.revoke(grantId);
      return { content: [{ type: 'text' as const, text: `Grant ${grantId} revoked successfully.` }] };
    },
  );

  server.tool(
    'grantex_grant_delegate',
    'Delegate a grant to a sub-agent with narrowed scopes',
    {
      parentGrantToken: z.string().describe('JWT grant token of the parent agent'),
      subAgentId: z.string().describe('Sub-agent ID to delegate to (ag_...)'),
      scopes: z.array(z.string()).describe('Scopes for the delegated grant (must be subset of parent)'),
      expiresIn: z.string().optional().describe('Delegation lifetime (e.g. "1h")'),
    },
    async ({ parentGrantToken, subAgentId, scopes, expiresIn }) => {
      const result = await grantex.grants.delegate({
        parentGrantToken,
        subAgentId,
        scopes,
        ...(expiresIn !== undefined ? { expiresIn } : {}),
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}
