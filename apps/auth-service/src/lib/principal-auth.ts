import type { FastifyReply, FastifyRequest } from 'fastify';
import { verifyPrincipalSessionToken } from './crypto.js';

export interface AuthenticatedPrincipal {
  principalId: string;
  developerId: string;
}

export async function requirePrincipalSession(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<AuthenticatedPrincipal | null> {
  const authorization = request.headers.authorization;
  const match = typeof authorization === 'string'
    ? /^Bearer[ \t]+([^\s]+)$/i.exec(authorization)
    : null;
  if (!match) {
    await reply.status(401).send({
      message: 'Missing or invalid principal session token',
      code: 'UNAUTHORIZED',
      requestId: request.id,
    });
    return null;
  }

  try {
    return await verifyPrincipalSessionToken(match[1]!);
  } catch {
    await reply.status(401).send({
      message: 'Invalid or expired principal session token',
      code: 'UNAUTHORIZED',
      requestId: request.id,
    });
    return null;
  }
}
