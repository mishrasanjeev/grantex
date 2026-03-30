# @grantex/anthropic

Anthropic SDK integration for the [Grantex](https://grantex.dev) delegated authorization protocol.

Enforce scopes, log audit trails, and inspect grant tokens when using Claude models with tool use.

## Install

```bash
npm install @grantex/anthropic @grantex/sdk @anthropic-ai/sdk
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

- **`createGrantexTool()`** — Wrap any Anthropic tool definition with offline scope enforcement
- **`GrantexToolRegistry`** — Manage multiple tools and dispatch `tool_use` blocks by name
- **`withAuditLogging()`** — Wrap tools to automatically log success/failure to the Grantex audit trail
- **`handleToolCall()`** — Execute a tool from a `tool_use` block with audit logging in one step
- **`getGrantScopes()`** — Decode scopes from a grant token offline

## Documentation

Full docs at [grantex.dev/integrations/anthropic](https://grantex.dev/integrations/anthropic).

## License

Apache-2.0
