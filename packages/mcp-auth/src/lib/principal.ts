import type { FastifyRequest } from 'fastify';
import type { ServerContext } from '../context.js';

export async function resolvePrincipal(
  ctx: ServerContext,
  request: FastifyRequest,
  clientId: string,
): Promise<string | undefined> {
  if (!ctx.config.resolvePrincipal) {
    return ctx.config.allowLegacyClientPrincipal === true ? clientId : undefined;
  }
  const principal = await ctx.config.resolvePrincipal(request);
  const id = principal?.principalId;
  if (typeof id !== 'string' || id.length === 0 || id.length > 256 || id.trim() !== id || /[\u0000-\u001f\u007f]/.test(id)) {
    return undefined;
  }
  return id;
}
