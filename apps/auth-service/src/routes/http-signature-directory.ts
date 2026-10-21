// SPDX-License-Identifier: LicenseRef-Orchestrum-Personal-Use-1.0
/**
 * GET /.well-known/http-message-signatures-directory (G50): the registry's
 * HTTP Message Signatures key directory (lib/registry/signature-directory.ts).
 * Registered only when HTTP_SIGNATURE_DIRECTORY_ENABLED=true; public and
 * unauthenticated, rate limited, CORS-open like the other registry reads.
 * The body is the JWK Set; the response carries Content-Digest and the
 * registry's RFC 9421 signature.
 */
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { getSql } from '../db/client.js';
import {
  SIGNATURE_DIRECTORY_PATH,
  SIGNATURE_DIRECTORY_RATE_LIMIT_PER_MINUTE,
  loadDirectoryDocument,
  signDirectoryResponse,
} from '../lib/registry/signature-directory.js';

export async function httpSignatureDirectoryRoutes(app: FastifyInstance): Promise<void> {
  if (!config.httpSignatureDirectoryEnabled) return;
  app.get(
    SIGNATURE_DIRECTORY_PATH,
    { config: { skipAuth: true, rateLimit: { max: SIGNATURE_DIRECTORY_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' } } },
    async (_request, reply) => {
      const document = await loadDirectoryDocument(getSql());
      const body = JSON.stringify(document);
      const headers = await signDirectoryResponse(body);
      reply.header('access-control-allow-origin', '*');
      reply.removeHeader('access-control-allow-credentials');
      for (const [name, value] of Object.entries(headers)) reply.header(name, value);
      // A Buffer, so the media type is sent exactly as registered (no charset appended).
      return reply.send(Buffer.from(body, 'utf8'));
    },
  );
}
