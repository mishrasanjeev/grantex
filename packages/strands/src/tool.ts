import { tool, type InvokableTool, type JSONValue } from '@strands-agents/sdk';
import { verifyGrantToken, type VerifyGrantTokenOptions } from '@grantex/sdk';
import type { z } from 'zod';
import { decodeJwtPayload } from './_jwt.js';
import { GrantexScopeError, type CreateGrantexToolOptions } from './types.js';

const DEFAULT_JWKS_URI = 'https://api.grantex.dev/.well-known/jwks.json';

/**
 * Create a Strands Agents SDK tool with Grantex scope enforcement.
 *
 * By default, the grant token is verified against JWKS before each invocation
 * and the verified `scp` claim is checked for `requiredScope`.
 *
 * Set `online: true` with a Grantex client and connector to delegate the check
 * to `client.enforce()` instead.
 */
export function createGrantexTool<
  INPUT extends z.ZodType,
  RESULT extends JSONValue = JSONValue,
>(
  options: CreateGrantexToolOptions<INPUT, RESULT>,
): InvokableTool<z.infer<INPUT>, RESULT> {
  const { name, description, inputSchema, callback } = options;

  return tool<INPUT, RESULT>({
    name,
    description,
    inputSchema,
    callback: async (input, context): Promise<RESULT> => {
      await assertAuthorized(options);
      return callback(input, context);
    },
  });
}

/**
 * Return the scopes embedded in a Grantex grant token.
 *
 * This helper only decodes the JWT payload. It does not verify the signature.
 */
export function getGrantScopes(grantToken: string): string[] {
  try {
    const payload = decodeJwtPayload(grantToken);
    const scopes = payload['scp'];
    return Array.isArray(scopes) ? scopes.filter((scope): scope is string => typeof scope === 'string') : [];
  } catch {
    return [];
  }
}

async function assertAuthorized<
  INPUT extends z.ZodType,
  RESULT extends JSONValue,
>(options: CreateGrantexToolOptions<INPUT, RESULT>): Promise<void> {
  const { grantToken, requiredScope } = options;

  if (options.online === true) {
    if (options.client === undefined) {
      throw new Error("Grantex: online enforcement requires a 'client'");
    }
    if (options.connector === undefined) {
      throw new Error("Grantex: online enforcement requires a 'connector'");
    }

    const result = await options.client.enforce({
      grantToken,
      connector: options.connector,
      tool: options.name,
      ...(options.amount !== undefined ? { amount: options.amount } : {}),
    });
    if (!result.allowed) {
      throw new GrantexScopeError(requiredScope, result.scopes, result.reason);
    }
    return;
  }

  const grant = await verifyGrantToken(grantToken, buildVerifyOptions(options));
  const scopes = grant.scopes;
  if (!scopes.includes(requiredScope)) {
    throw new GrantexScopeError(requiredScope, scopes);
  }
}

function buildVerifyOptions<
  INPUT extends z.ZodType,
  RESULT extends JSONValue,
>(options: CreateGrantexToolOptions<INPUT, RESULT>): VerifyGrantTokenOptions {
  return {
    jwksUri: options.jwksUri ?? DEFAULT_JWKS_URI,
    ...(options.issuer !== undefined ? { issuer: options.issuer } : {}),
    ...(options.issuerDid !== undefined ? { issuerDid: options.issuerDid } : {}),
    ...(options.audience !== undefined ? { audience: options.audience } : {}),
    ...(options.clockTolerance !== undefined ? { clockTolerance: options.clockTolerance } : {}),
  };
}
