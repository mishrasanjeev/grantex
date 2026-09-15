import { fileURLToPath } from 'node:url';

// Documentation examples import the package by name; resolve those imports
// to the sources (tsconfig.json "paths" does the same for type checking).
const src = (file: string) => fileURLToPath(new URL(`./src/${file}`, import.meta.url));

export const packageAliases = [
  { find: /^@grantex\/mcp-auth\/postgres$/, replacement: src('postgres.ts') },
  { find: /^@grantex\/mcp-auth\/redis$/, replacement: src('redis.ts') },
  { find: /^@grantex\/mcp-auth\/testing$/, replacement: src('testing.ts') },
  { find: /^@grantex\/mcp-auth\/express$/, replacement: src('middleware/express.ts') },
  { find: /^@grantex\/mcp-auth\/hono$/, replacement: src('middleware/hono.ts') },
  { find: /^@grantex\/mcp-auth$/, replacement: src('index.ts') },
];
