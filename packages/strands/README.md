# @grantex/strands

[Strands Agents SDK](https://strandsagents.com/) integration for the [Grantex](https://grantex.dev) delegated authorization protocol.

Create Strands tools that verify Grantex grant tokens and enforce scopes before tool execution.

> **[Homepage](https://grantex.dev)** | **[Docs](https://docs.grantex.dev)** | **[GitHub](https://github.com/mishrasanjeev/grantex)**

## Install

Version 0.2.0 is a breaking release requiring Node.js 22.12+ and
`@grantex/sdk` 0.8+. Online tools forward `audience` to `client.enforce()`;
pass `amount` for capped calls. The default verified mode checks signatures
and scopes, not current revocation. Use `online: true` with a configured
Grantex client for current-state enforcement. See the
[migration guide](https://docs.grantex.dev/migration-enforcement).

```bash
npm install @grantex/strands@0.2.0 @grantex/sdk@0.8.0 @strands-agents/sdk zod
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

## Ownership

Grantex is owned by Orchestrum Technologies LLP. Inventor and owner: Sanjeev Kumar. Ownership contact: [sanjeev@orchestrum.in](mailto:sanjeev@orchestrum.in) or [mishra.sanjeev@gmail.com](mailto:mishra.sanjeev@gmail.com).
> Unreleased authority hardening requires TypeScript SDK 0.8.1 (`currentAuthority`),
> not just a valid JWT signature. Bind the audience and trusted human/agent
> identities, and check the issuer before every execution. This does not
> create human consent or automatically consume action decisions/spend caps.
> Existing offline defaults remain offline. The candidate is not yet published.
> See the [SDK execution authority guide](../../docs/guides/sdk-execution-authority.mdx).
