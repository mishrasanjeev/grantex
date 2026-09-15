import express from 'express';
import { toolPolicyFromManifests } from '@grantex/mcp-auth';
import type { DecisionVerifier, LoadedManifest, RevocationChecker } from '@grantex/mcp-auth';
import { protectedResourceMetadataHandler, requireMcpAuth } from '@grantex/mcp-auth/express';
import type { McpAuthRequest } from '@grantex/mcp-auth/express';

export function createMcpApp(options: {
  manifest: LoadedManifest;
  /** The authorization server's storage: tokens revoked there are refused here. */
  revocations: RevocationChecker;
  decisions: DecisionVerifier;
  grantexIssuer: string;
}) {
  const resource = 'https://mcp.acme.example.com/mcp';
  const app = express();

  // RFC 9728: tells MCP clients which authorization server to use.
  app.get('/.well-known/oauth-protected-resource/mcp', protectedResourceMetadataHandler({
    resource,
    authorizationServers: ['https://auth.acme.example.com'],
    resourceName: 'Acme KYB tools',
  }));

  app.post(
    '/mcp',
    express.json(),
    requireMcpAuth({
      issuer: options.grantexIssuer,
      audience: resource,
      revocations: options.revocations,
      // A tools/call outside the grant is refused here with 403.
      tools: toolPolicyFromManifests([options.manifest]),
      // Tools marked requires_decision also need a person's decision grant.
      decisions: options.decisions,
    }),
    (req: McpAuthRequest, res) => {
      const message = req.body as { id?: unknown };
      // Only requests the grant covers reach your MCP handler.
      res.json({ jsonrpc: '2.0', id: message.id ?? null, result: { grantee: req.mcpGrant?.sub } });
    },
  );

  return app;
}
