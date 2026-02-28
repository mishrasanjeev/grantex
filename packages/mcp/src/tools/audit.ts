import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Grantex } from '@grantex/sdk';
import { z } from 'zod';

export function registerAuditTools(server: McpServer, grantex: Grantex): void {
  server.tool(
    'grantex_audit_log',
    'Log an audit entry for an agent action',
    {
      agentId: z.string().describe('Agent ID that performed the action'),
      grantId: z.string().describe('Grant ID authorizing the action'),
      action: z.string().describe('Action name (e.g. "read_email", "send_message")'),
      metadata: z.record(z.unknown()).optional().describe('Additional context'),
      status: z.enum(['success', 'failure', 'blocked']).optional().describe('Outcome status'),
    },
    async ({ agentId, grantId, action, metadata, status }) => {
      const result = await grantex.audit.log({
        agentId,
        grantId,
        action,
        ...(metadata !== undefined ? { metadata } : {}),
        ...(status !== undefined ? { status } : {}),
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'grantex_audit_list',
    'List audit entries with optional filters',
    {
      agentId: z.string().optional().describe('Filter by agent ID'),
      grantId: z.string().optional().describe('Filter by grant ID'),
      action: z.string().optional().describe('Filter by action name'),
      since: z.string().optional().describe('Start date (ISO 8601)'),
      until: z.string().optional().describe('End date (ISO 8601)'),
    },
    async ({ agentId, grantId, action, since, until }) => {
      const params: Record<string, string> = {};
      if (agentId !== undefined) params['agentId'] = agentId;
      if (grantId !== undefined) params['grantId'] = grantId;
      if (action !== undefined) params['action'] = action;
      if (since !== undefined) params['since'] = since;
      if (until !== undefined) params['until'] = until;
      const result = await grantex.audit.list(params);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}
