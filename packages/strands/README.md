# @grantex/strands

[Strands Agents SDK](https://strandsagents.com/) integration for the [Grantex](https://grantex.dev) delegated authorization protocol.

Create Strands tools that verify Grantex grant tokens and enforce scopes before tool execution.

> **[Homepage](https://grantex.dev)** | **[Docs](https://docs.grantex.dev)** | **[GitHub](https://github.com/mishrasanjeev/grantex)**

## Install

```bash
npm install @grantex/strands @grantex/sdk @strands-agents/sdk zod
```

## Quick Start

```typescript
import { Agent } from '@strands-agents/sdk';
import { createGrantexTool } from '@grantex/strands';
import { z } from 'zod';

const readCalendar = createGrantexTool({
  name: 'read_calendar',
  description: 'Read upcoming calendar events',
  inputSchema: z.object({
    date: z.string().describe('Date in YYYY-MM-DD format'),
  }),
  grantToken,
  requiredScope: 'calendar:read',
  callback: async ({ date }) => {
    return `events for ${date}`;
  },
});

const agent = new Agent({
  tools: [readCalendar],
});
```

If the verified grant token does not include the required scope, the tool throws `GrantexScopeError` before invoking your callback.

## Enforcement Modes

Verified mode is the default. It verifies the grant token against JWKS and checks the verified `scp` claim:

```typescript
const tool = createGrantexTool({
  name: 'read_calendar',
  description: 'Read upcoming calendar events',
  inputSchema: z.object({ date: z.string() }),
  grantToken,
  requiredScope: 'calendar:read',
  callback: async ({ date }) => getCalendarEvents(date),
});
```

Online mode delegates enforcement to a Grantex client:

```typescript
const tool = createGrantexTool({
  name: 'read_calendar',
  description: 'Read upcoming calendar events',
  inputSchema: z.object({ date: z.string() }),
  grantToken,
  requiredScope: 'calendar:read',
  client: grantexClient,
  connector: 'calendar',
  online: true,
  callback: async ({ date }) => getCalendarEvents(date),
});
```

## API Reference

### `createGrantexTool(options)`

Creates a Strands-compatible tool with Grantex scope enforcement.

| Option | Type | Description |
|---|---|---|
| `name` | `string` | Tool name |
| `description` | `string` | Tool description |
| `inputSchema` | `z.ZodType` | Zod schema for tool input |
| `grantToken` | `string` | JWT grant token from Grantex |
| `requiredScope` | `string` | Scope that must be present in the token |
| `callback` | `(input, context?) => Promise<Result> \| Result` | Tool implementation |
| `jwksUri` | `string` | JWKS URL used to verify the grant token |
| `issuer`, `issuerDid`, `audience` | `string` | Optional JWT claim validation settings |
| `clockTolerance` | `number` | Clock tolerance in seconds for token verification |
| `client` | `GrantexEnforcer` | Grantex client instance for online mode |
| `connector` | `string` | Connector name for online mode |
| `online` | `boolean` | Use `client.enforce()` instead of JWKS-backed local verification |
| `amount` | `number` | Optional capped-amount value for online enforcement |

### `getGrantScopes(grantToken)`

Returns the scopes embedded in a grant token. Invalid tokens return an empty array. This helper decodes the token payload only; it does not verify the signature.

### `GrantexScopeError`

Error thrown when the verified grant token is missing the required scope.

## Requirements

- Node.js 18+
- `@grantex/sdk >= 0.3.11`
- `@strands-agents/sdk >= 1.6.0`
- `zod >= 4.1.12`

## Grantex Ecosystem

This package is part of the [Grantex](https://grantex.dev) ecosystem. See also:

- [`@grantex/sdk`](https://www.npmjs.com/package/@grantex/sdk) - Core TypeScript SDK
- [`@grantex/langchain`](https://www.npmjs.com/package/@grantex/langchain) - LangChain integration
- [`@grantex/vercel-ai`](https://www.npmjs.com/package/@grantex/vercel-ai) - Vercel AI SDK integration
- [`@grantex/autogen`](https://www.npmjs.com/package/@grantex/autogen) - AutoGen integration

## License

Apache 2.0
