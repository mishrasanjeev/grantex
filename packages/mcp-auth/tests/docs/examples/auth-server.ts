import type { Grantex } from '@grantex/sdk';
import { createMcpAuthServer } from '@grantex/mcp-auth';
import type { LoadedManifest, McpAuthStorage } from '@grantex/mcp-auth';

export async function startAuthServer(options: {
  grantex: Grantex;
  storage: McpAuthStorage;
  manifest: LoadedManifest;
}) {
  return createMcpAuthServer({
    grantex: options.grantex,
    agentId: 'ag_acme_kyb_tools',
    storage: options.storage,

    // This authorization server, and the MCP server its tokens are for.
    issuer: 'https://auth.acme.example.com',
    resource: 'https://mcp.acme.example.com/mcp',
    resourceName: 'Acme KYB tools',
    grantexIssuer: 'https://grantex.dev',

    // scopes_supported and the consent page's tool list come from the manifest.
    manifests: [options.manifest],

    // What the grant is for, shown on the consent page.
    grant: {
      purpose: 'aml.cdd.onboarding',
      purposeDescription: 'Business onboarding checks for new applicants',
      dataRegion: 'eu',
      duration: '8h',
    },

    consentUi: {
      appName: 'Acme Compliance',
      privacyUrl: 'https://acme.example.com/privacy',
      termsUrl: 'https://acme.example.com/terms',
    },
    consentPage: {
      theme: { accentColor: '#0b6e4f', radiusPx: 6 },
      text: { title: 'Allow case tools?', approve: 'Allow access' },
    },

    // Only accept metadata-document clients served from these hosts.
    clientIdMetadataDocuments: { allowedHosts: ['*.acme.example.com'] },
  });
}
