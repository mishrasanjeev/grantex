# @grantex/langchain

LangChain integration for the [Grantex](https://github.com/mishrasanjeev/grantex) delegated authorization protocol.

Adds scope-enforced tools and automatic audit logging to any LangChain agent.

## Install

```bash
npm install @grantex/langchain @grantex/sdk @langchain/core
```

## Quick Start

### Scope-Enforced Tools

Wrap any tool function with `createGrantexTool` to enforce Grantex scope authorization before execution:

```typescript
import { createGrantexTool } from '@grantex/langchain';

const tool = createGrantexTool({
  name: 'read_calendar',
  description: 'Read upcoming calendar events',
  grantToken,                     // JWT from Grantex token exchange
  requiredScope: 'calendar:read', // must be in token's scp claim
  func: async (input) => {
    // your tool logic — only runs if scope check passes
    return JSON.stringify(await getCalendarEvents(input));
  },
});

// Use with any LangChain agent
const agent = createToolCallingAgent({ llm, tools: [tool], prompt });
```

The scope check is **offline** — it reads the `scp` claim from the JWT directly, no network call needed. If the token doesn't include the required scope, the tool throws before your function runs.

### Audit Logging

Attach `GrantexAuditHandler` as a LangChain callback to automatically log every tool invocation to the Grantex audit trail:

```typescript
import { Grantex } from '@grantex/sdk';
import { GrantexAuditHandler } from '@grantex/langchain';

const client = new Grantex({ apiKey: process.env.GRANTEX_API_KEY });

const auditHandler = new GrantexAuditHandler({
  client,
  agentId: 'ag_01ABC...',
  grantToken,
});

// Attach to any chain or agent executor
const result = await agentExecutor.invoke(
  { input: 'What meetings do I have today?' },
  { callbacks: [auditHandler] },
);
```

Each tool call logs:
- `tool:<toolName>` with `status: 'success'` on success
- `tool:error` with `status: 'failure'` on error

## API Reference

### `createGrantexTool(options)`

Creates a LangChain `DynamicTool` with Grantex scope enforcement.

| Option | Type | Description |
|--------|------|-------------|
| `name` | `string` | Tool name shown to the LLM |
| `description` | `string` | Tool description shown to the LLM |
| `grantToken` | `string` | Grantex JWT from token exchange |
| `requiredScope` | `string` | Scope required to invoke this tool |
| `func` | `(input: string) => Promise<string>` | Tool implementation |

### `GrantexAuditHandler`

LangChain callback handler that writes tool invocations to the Grantex audit trail.

| Option | Type | Description |
|--------|------|-------------|
| `client` | `Grantex` | Authenticated SDK client |
| `agentId` | `string` | Agent ID for audit attribution |
| `grantToken` | `string` | JWT (grant ID extracted from `grnt` or `jti` claim) |

## Requirements

- Node.js 18+
- `@grantex/sdk` >= 0.1.0
- `@langchain/core` >= 0.3.0

## Links

- [Grantex Protocol](https://github.com/mishrasanjeev/grantex)
- [TypeScript SDK](https://www.npmjs.com/package/@grantex/sdk)
- [Python SDK](https://pypi.org/project/grantex/)
- [Spec](https://github.com/mishrasanjeev/grantex/blob/main/SPEC.md)

## License

Apache 2.0
