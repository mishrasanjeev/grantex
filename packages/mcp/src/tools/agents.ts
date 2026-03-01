import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Grantex } from '@grantex/sdk';
import { z } from 'zod';

export function registerAgentTools(server: McpServer, grantex: Grantex): void {
  server.tool(
    'grantex_agent_register',
    'Register a new AI agent with Grantex',
    {
      name: z.string().describe('Human-readable agent name'),
      description: z.string().describe('What this agent does'),
      scopes: z.array(z.string()).describe('Requested permission scopes'),
    },
    async ({ name, description, scopes }) => {
      const agent = await grantex.agents.register({ name, description, scopes });
      return { content: [{ type: 'text' as const, text: JSON.stringify(agent, null, 2) }] };
    },
  );

  server.tool(
    'grantex_agent_list',
    'List all registered agents',
    {},
    async () => {
      const result = await grantex.agents.list();
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'grantex_agent_get',
    'Get details for a specific agent',
    {
      agentId: z.string().describe('Agent ID (ag_...)'),
    },
    async ({ agentId }) => {
      const agent = await grantex.agents.get(agentId);
      return { content: [{ type: 'text' as const, text: JSON.stringify(agent, null, 2) }] };
    },
  );

  server.tool(
    'grantex_agent_update',
    'Update an existing agent',
    {
      agentId: z.string().describe('Agent ID (ag_...)'),
      name: z.string().optional().describe('New agent name'),
      description: z.string().optional().describe('New agent description'),
      scopes: z.array(z.string()).optional().describe('New requested scopes'),
    },
    async ({ agentId, name, description, scopes }) => {
      const agent = await grantex.agents.update(agentId, {
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(scopes !== undefined ? { scopes } : {}),
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(agent, null, 2) }] };
    },
  );

  server.tool(
    'grantex_agent_delete',
    'Delete an agent',
    {
      agentId: z.string().describe('Agent ID to delete (ag_...)'),
    },
    async ({ agentId }) => {
      await grantex.agents.delete(agentId);
      return { content: [{ type: 'text' as const, text: `Agent ${agentId} deleted successfully.` }] };
    },
  );
}
