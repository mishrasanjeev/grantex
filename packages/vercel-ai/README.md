# @grantex/vercel-ai

[Vercel AI SDK](https://sdk.vercel.ai/) integration for the [Grantex](https://github.com/mishrasanjeev/grantex) delegated authorization protocol.

Adds scope-enforced tools and audit logging to any Vercel AI SDK agent.

## Install

```bash
npm install @grantex/vercel-ai @grantex/sdk ai zod
```

## Quick Start

### Scope-Enforced Tools

Create Vercel AI SDK tools with Grantex authorization. Scope is checked **at construction time** — if the token is missing the required scope, `createGrantexTool` throws immediately, before the LLM can invoke the tool:

```typescript
import { createGrantexTool } from '@grantex/vercel-ai';
import { z } from 'zod';

const readCalendar = createGrantexTool({
  name: 'read_calendar',
  description: 'Read upcoming calendar events',
  parameters: z.object({
    date: z.string().describe('Date in YYYY-MM-DD format'),
  }),
  grantToken,                     // JWT from Grantex token exchange
  requiredScope: 'calendar:read', // checked at construction time
  execute: async (args) => {
    return await getCalendarEvents(args.date);
  },
});

// Use with generateText, streamText, etc.
import { generateText } from 'ai';

const { text } = await generateText({
  model: openai('gpt-4'),
  tools: { read_calendar: readCalendar },
  prompt: 'What meetings do I have today?',
});
```

### Inspect Grant Scopes

Use `getGrantScopes` to check what scopes a token has before creating tools:

```typescript
import { getGrantScopes } from '@grantex/vercel-ai';

const scopes = getGrantScopes(grantToken);
// → ['calendar:read', 'email:send']
```

### Audit Logging

Wrap tools with `withAuditLogging` to log every invocation to the Grantex audit trail:

```typescript
import { Grantex } from '@grantex/sdk';
import { createGrantexTool, withAuditLogging } from '@grantex/vercel-ai';

const client = new Grantex({ apiKey: process.env.GRANTEX_API_KEY });

const audited = withAuditLogging(readCalendar, client, {
  agentId: 'ag_01ABC...',
  grantId: 'grnt_01XYZ...',
});

// Use audited in place of readCalendar — logs success/failure automatically
```

## API Reference

### `createGrantexTool(options)`

Creates a Vercel AI SDK tool with Grantex scope enforcement.

| Option | Type | Description |
|--------|------|-------------|
| `name` | `string` | Tool name |
| `description` | `string` | Tool description |
| `parameters` | `z.ZodTypeAny` | Zod schema for tool arguments |
| `grantToken` | `string` | Grantex JWT from token exchange |
| `requiredScope` | `string` | Scope required — checked at construction time |
| `execute` | `(args, options) => Promise<Result>` | Tool implementation |

Throws `GrantexScopeError` if scope is missing.

### `getGrantScopes(grantToken)`

Returns the `string[]` of scopes from the token's `scp` claim (offline, no network call).

### `withAuditLogging(tool, client, options)`

Wraps a Grantex tool with audit logging.

| Option | Type | Description |
|--------|------|-------------|
| `agentId` | `string` | Agent ID for audit attribution |
| `grantId` | `string` | Grant ID for the session |
| `toolName` | `string?` | Override tool name in audit entries |

### `GrantexScopeError`

Error thrown when a grant token is missing the required scope.

| Property | Type | Description |
|----------|------|-------------|
| `requiredScope` | `string` | The scope that was required |
| `grantedScopes` | `string[]` | The scopes the token actually has |

## Requirements

- Node.js 18+
- `@grantex/sdk` >= 0.1.0
- `ai` >= 4.0.0 (Vercel AI SDK)
- `zod` >= 3.0.0

## Links

- [Grantex Protocol](https://github.com/mishrasanjeev/grantex)
- [Vercel AI SDK Docs](https://sdk.vercel.ai/)
- [TypeScript SDK](https://www.npmjs.com/package/@grantex/sdk)
- [Spec](https://github.com/mishrasanjeev/grantex/blob/main/SPEC.md)

## License

Apache 2.0
