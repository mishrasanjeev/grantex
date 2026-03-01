import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Grantex } from '@grantex/sdk';
import { registerAgentTools } from './tools/agents.js';
import { registerAuthorizeTools } from './tools/authorize.js';
import { registerTokenTools } from './tools/tokens.js';
import { registerGrantTools } from './tools/grants.js';
import { registerAuditTools } from './tools/audit.js';
import { registerPrincipalSessionTools } from './tools/principal-sessions.js';

export function buildServer(grantex: Grantex): McpServer {
  const server = new McpServer({
    name: 'grantex',
    version: '0.1.0',
  });

  registerAgentTools(server, grantex);
  registerAuthorizeTools(server, grantex);
  registerTokenTools(server, grantex);
  registerGrantTools(server, grantex);
  registerAuditTools(server, grantex);
  registerPrincipalSessionTools(server, grantex);

  return server;
}
