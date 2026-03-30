# @grantex/anthropic

Anthropic SDK integration for the [Grantex](https://grantex.dev) delegated authorization protocol.

Enforce scopes, audit tool invocations, and inspect grant tokens when using `@anthropic-ai/sdk` with tool use.

## Installation

```bash
npm install @grantex/anthropic @grantex/sdk @anthropic-ai/sdk
```

## Quick Start

### 1. Create a scope-enforced tool

```typescript
import Anthropic from '@anthropic-ai/sdk';
import { createGrantexTool } from '@grantex/anthropic';

const client = new Anthropic();

const readFileTool = createGrantexTool({
  name: 'read_file',
  description: 'Read a file from disk',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Absolute file path' } },
    required: ['path'],
  },
  grantToken: process.env.GRANT_TOKEN!,
  requiredScope: 'file:read',
  execute: async ({ path }) => {
    const fs = await import('node:fs/promises');
    return fs.readFile(path as string, 'utf-8');
  },
});
```

### 2. Use with the Anthropic SDK

```typescript
const response = await client.messages.create({
  model: 'claude-sonnet-4-20250514',
  max_tokens: 1024,
  tools: [readFileTool.definition],
  messages: [{ role: 'user', content: 'Read /tmp/hello.txt' }],
});

for (const block of response.content) {
  if (block.type === 'tool_use') {
    const result = await readFileTool.execute(block.input as { path: string });
    console.log(result);
  }
}
```

### 3. Add audit logging

```typescript
import { Grantex } from '@grantex/sdk';
import { withAuditLogging } from '@grantex/anthropic';

const grantex = new Grantex({ apiKey: process.env.GRANTEX_API_KEY });

const auditedTool = withAuditLogging(readFileTool, grantex, {
  agentId: 'ag_01HXYZ...',
  agentDid: 'did:grantex:ag_01HXYZ...',
  grantId: 'grnt_01HXYZ...',
  principalId: 'user_abc123',
});

// Every call to auditedTool.execute() now logs to the Grantex audit trail.
```

### 4. Inspect scopes offline

```typescript
import { getGrantScopes } from '@grantex/anthropic';

const scopes = getGrantScopes(process.env.GRANT_TOKEN!);
// ['file:read', 'file:write', 'calendar:read']
```

## API Reference

### `createGrantexTool(options)`

Creates a Grantex-authorized tool in Anthropic SDK format.

| Option | Type | Description |
|--------|------|-------------|
| `name` | `string` | Tool name shown to the LLM |
| `description` | `string` | Human-readable description |
| `inputSchema` | `JsonSchema` | JSON Schema for the tool input |
| `grantToken` | `string` | Grantex grant token (JWT) |
| `requiredScope` | `string` | Scope required to invoke the tool |
| `execute` | `(args: T) => Promise<unknown>` | Tool implementation |

Returns a `GrantexTool<T>` with:
- `definition` — Anthropic tool definition to pass to `tools[]`
- `execute(args)` — scope-checked execution

### `withAuditLogging(tool, client, options)`

Wraps a tool with automatic audit logging.

| Option | Type | Description |
|--------|------|-------------|
| `agentId` | `string` | Agent identifier |
| `agentDid` | `string` | Agent DID (decentralized identifier) |
| `grantId` | `string` | Grant ID for the session |
| `principalId` | `string` | Principal (end-user) identifier |

### `getGrantScopes(grantToken)`

Decodes the JWT offline and returns the list of scopes as `string[]`.

### `GrantexScopeError`

Thrown when `execute()` is called without the required scope. Properties:
- `requiredScope: string`
- `grantedScopes: string[]`

## License

Apache-2.0
