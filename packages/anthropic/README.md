# @grantex/anthropic

Anthropic SDK integration for the [Grantex](https://grantex.dev) delegated authorization protocol.

Enforce scopes, log audit trails, and inspect grant tokens when using Claude models with tool use.

## Install

```bash
npm install @grantex/anthropic@0.1.2 @grantex/sdk @anthropic-ai/sdk
```

## Quick Start

```typescript
import Anthropic from '@anthropic-ai/sdk';
import { createGrantexTool } from '@grantex/anthropic';

const client = new Anthropic();

const readFileTool = createGrantexTool({
  name: 'read_file',
  description: 'Read a file from disk',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
  grantToken: process.env.GRANT_TOKEN!,
  jwksUri: 'https://api.grantex.dev/.well-known/jwks.json',
  requiredScope: 'file:read',
  execute: async ({ path }) => fs.readFile(path as string, 'utf-8'),
});

const response = await client.messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: 1024,
  tools: [readFileTool.definition],
  messages: [{ role: 'user', content: 'Read config.json' }],
});

for (const block of response.content) {
  if (block.type === 'tool_use') {
    const result = await readFileTool.execute(block.input as { path: string });
  }
}
```

## Features

- **`createGrantexTool()`** — Wrap any Anthropic tool definition with JWKS token verification and scope enforcement
- **`GrantexToolRegistry`** — Manage multiple tools and dispatch `tool_use` blocks by name
- **`withAuditLogging()`** — Wrap tools to automatically log success/failure to the Grantex audit trail
- **`handleToolCall()`** — Execute a tool from a `tool_use` block with audit logging in one step
- **`getGrantScopes()`** — Decode scopes from a grant token for diagnostics without signature verification

## Documentation

Full docs at [docs.grantex.dev/integrations/anthropic](https://docs.grantex.dev/integrations/anthropic).

## License

PolyForm Noncommercial License 1.0.0, licensor Orchestrum Technologies LLP
([LICENSE](https://github.com/mishrasanjeev/grantex/blob/main/LICENSE)).
Noncommercial self use is free. Commercial use of any sort, including internal
use by a for-profit business, hosting or SaaS, resale, embedding and paid
services, needs a written agreement with Orchestrum Technologies LLP: see
[commercial licensing](https://github.com/mishrasanjeev/grantex/blob/main/COMMERCIAL-LICENSE.md)
or write to [sanjeev@orchestrum.in](mailto:sanjeev@orchestrum.in). Versions
published before 21 October 2026 remain available under the Apache License 2.0
they were released with. "Grantex" is a trademark of Orchestrum Technologies LLP
([trademarks](https://github.com/mishrasanjeev/grantex/blob/main/TRADEMARKS.md)).

## Ownership

Grantex is owned by Orchestrum Technologies LLP. Inventor and owner: Sanjeev Kumar. Ownership contact: [sanjeev@orchestrum.in](mailto:sanjeev@orchestrum.in) or [mishra.sanjeev@gmail.com](mailto:mishra.sanjeev@gmail.com).
> Authority hardening requires TypeScript SDK 0.8.1 (`currentAuthority`),
> not just a valid JWT signature. Bind the audience and trusted human/agent
> identities, and check the issuer before every execution. This does not
> create human consent or automatically consume action decisions/spend caps.
> Existing offline defaults remain offline. Verify registry availability before installation.
> See the [SDK execution authority guide](https://docs.grantex.dev/guides/sdk-execution-authority).
