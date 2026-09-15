/**
 * Connection settings for the real-Postgres and real-Redis integration
 * suites. Locally the suites skip when unset; in CI they refuse to skip, so a
 * misconfigured job fails instead of silently passing.
 */
const ci = process.env['CI']?.trim().toLowerCase();
const inCi = ci === 'true' || ci === '1';

function required(name: string): string | undefined {
  const value = process.env[name]?.trim();
  if (inCi && !value) {
    throw new Error(`${name} must be set in CI; refusing to skip the mcp-auth integration tests`);
  }
  return value || undefined;
}

export const databaseUrl = required('MCP_AUTH_INTEGRATION_DATABASE_URL');
export const redisUrl = required('MCP_AUTH_INTEGRATION_REDIS_URL');
