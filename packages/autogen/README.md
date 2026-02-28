# @grantex/autogen

AutoGen / OpenAI function-calling integration for the [Grantex](https://grantex.dev) delegated authorization protocol.

Adds scope-enforced functions, a function registry, and audit logging for any agent using OpenAI-style function calling.

> **[Homepage](https://grantex.dev)** | **[Docs](https://grantex.dev/docs)** | **[Sign Up Free](https://grantex.dev/dashboard/signup)** | **[GitHub](https://github.com/mishrasanjeev/grantex)**

## Install

```bash
npm install @grantex/autogen @grantex/sdk
```

## Quick Start

### Scope-Enforced Functions

Create OpenAI function-calling tool definitions with built-in Grantex scope checks:

```typescript
import { createGrantexFunction } from '@grantex/autogen';

const readCalendar = createGrantexFunction({
  name: 'read_calendar',
  description: 'Read upcoming calendar events',
  parameters: {
    type: 'object',
    properties: {
      date: { type: 'string', description: 'Date in YYYY-MM-DD format' },
    },
    required: ['date'],
  },
  grantToken,                     // JWT from Grantex token exchange
  requiredScope: 'calendar:read', // must be in token's scp claim
  func: async (args) => {
    return await getCalendarEvents(args.date);
  },
});

// Pass definition to the LLM
const response = await openai.chat.completions.create({
  model: 'gpt-4',
  tools: [readCalendar.definition],
  messages,
});

// Execute when the LLM selects the tool
const result = await readCalendar.execute({ date: '2026-03-01' });
```

### Function Registry

Use `GrantexFunctionRegistry` to manage multiple functions and dispatch tool calls by name:

```typescript
import { createGrantexFunction, GrantexFunctionRegistry } from '@grantex/autogen';

const registry = new GrantexFunctionRegistry();
registry.register(readCalendar);
registry.register(sendEmail);

// Pass all definitions to the LLM
const response = await openai.chat.completions.create({
  tools: registry.definitions,
  messages,
});

// Dispatch the tool call
const toolCall = response.choices[0].message.tool_calls[0];
const result = await registry.execute(toolCall.function.name, JSON.parse(toolCall.function.arguments));
```

### Audit Logging

Wrap any function with `withAuditLogging` to log every invocation to the Grantex audit trail:

```typescript
import { Grantex } from '@grantex/sdk';
import { withAuditLogging } from '@grantex/autogen';

const client = new Grantex({ apiKey: process.env.GRANTEX_API_KEY });

const audited = withAuditLogging(readCalendar, client, {
  agentId: 'ag_01ABC...',
  grantId: 'grnt_01XYZ...',
});

// Use audited.execute() — logs success/failure automatically
```

## API Reference

### `createGrantexFunction(options)`

Creates a Grantex-authorized function with an OpenAI tool definition and scope-enforced executor.

| Option | Type | Description |
|--------|------|-------------|
| `name` | `string` | Function name (matches `^[a-zA-Z0-9_-]+$`) |
| `description` | `string` | Description shown to the LLM |
| `parameters` | `JsonSchema` | JSON Schema for function arguments |
| `grantToken` | `string` | Grantex JWT from token exchange |
| `requiredScope` | `string` | Scope required to invoke this function |
| `func` | `(args: T) => Promise<unknown>` | Function implementation |

Returns `{ definition, execute }`.

### `GrantexFunctionRegistry`

| Method | Description |
|--------|-------------|
| `register(fn)` | Register a function (chainable) |
| `definitions` | All registered OpenAI tool definitions |
| `execute(name, args)` | Execute a function by name |

### `withAuditLogging(fn, client, options)`

Wraps a `GrantexFunction` with audit logging.

| Option | Type | Description |
|--------|------|-------------|
| `agentId` | `string` | Agent ID for audit attribution |
| `grantId` | `string` | Grant ID for the session |

## Requirements

- Node.js 18+
- `@grantex/sdk` >= 0.1.0

## Links

- [Grantex Protocol](https://github.com/mishrasanjeev/grantex)
- [TypeScript SDK](https://www.npmjs.com/package/@grantex/sdk)
- [Spec](https://github.com/mishrasanjeev/grantex/blob/main/SPEC.md)

## Grantex Ecosystem

This package is part of the [Grantex](https://grantex.dev) ecosystem. See also:

- [`@grantex/sdk`](https://www.npmjs.com/package/@grantex/sdk) — Core TypeScript SDK
- [`grantex`](https://pypi.org/project/grantex/) — Python SDK
- [`@grantex/langchain`](https://www.npmjs.com/package/@grantex/langchain) — LangChain integration
- [`@grantex/vercel-ai`](https://www.npmjs.com/package/@grantex/vercel-ai) — Vercel AI SDK integration
- [`@grantex/mcp`](https://www.npmjs.com/package/@grantex/mcp) — MCP server for Claude Desktop / Cursor / Windsurf

## License

Apache 2.0
