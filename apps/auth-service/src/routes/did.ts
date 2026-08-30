import type { FastifyInstance } from 'fastify';
import { buildJwks, getEdKeyPair } from '../lib/crypto.js';
import { exportJWK } from 'jose';
import { config } from '../config.js';
import { getSql } from '../db/client.js';

export async function didRoutes(app: FastifyInstance): Promise<void> {
  // did:web:<domain>:agents:<id> resolves at /agents/<id>/did.json.
  app.get<{ Params: { id: string } }>(
    '/agents/:id/did.json',
    { config: { skipAuth: true } },
    async (request, reply) => {
      const sql = getSql();
      const rows = await sql<{
        id: string;
        did: string;
        public_jwk: Record<string, unknown> | null;
        key_thumbprint: string | null;
        status: string;
      }[]>`
        SELECT id, did, public_jwk, key_thumbprint, status
        FROM agents
        WHERE id = ${request.params.id}
      `;
      const agent = rows[0];
      if (!agent || agent.status !== 'active' || !agent.public_jwk || !agent.key_thumbprint) {
        return reply.status(404).send({
          message: 'Agent DID document not found',
          code: 'NOT_FOUND',
          requestId: request.id,
        });
      }

      const verificationMethodId = `${agent.did}#${agent.key_thumbprint}`;
      return reply.send({
        '@context': ['https://www.w3.org/ns/did/v1'],
        id: agent.did,
        verificationMethod: [{
          id: verificationMethodId,
          type: 'JsonWebKey2020',
          controller: agent.did,
          publicKeyJwk: agent.public_jwk,
        }],
        authentication: [verificationMethodId],
        assertionMethod: [verificationMethodId],
      });
    },
  );

  // GET /.well-known/did.json — serve DID document (public)
  app.get('/.well-known/did.json', { config: { skipAuth: true } }, async (_request, reply) => {
    const domain = config.didWebDomain;
    const didId = `did:web:${domain}`;
    const jwks = await buildJwks();

    const verificationMethods: Record<string, unknown>[] = [];

    // RS256 key (always present)
    const rsaKey = jwks.keys.find((k) => k['alg'] === 'RS256');
    if (rsaKey) {
      verificationMethods.push({
        id: `${didId}#${rsaKey['kid'] as string}`,
        type: 'JsonWebKey2020',
        controller: didId,
        publicKeyJwk: rsaKey,
      });
    }

    // Ed25519 key (optional)
    const edKeyPair = getEdKeyPair();
    if (edKeyPair) {
      const edJwk = await exportJWK(edKeyPair.publicKey);
      verificationMethods.push({
        id: `${didId}#${edKeyPair.kid}`,
        type: 'JsonWebKey2020',
        controller: didId,
        publicKeyJwk: { ...edJwk, alg: 'EdDSA', use: 'sig', kid: edKeyPair.kid },
      });
    }

    const doc = {
      '@context': [
        'https://www.w3.org/ns/did/v1',
        'https://w3id.org/security/suites/jws-2020/v1',
      ],
      id: didId,
      verificationMethod: verificationMethods,
      authentication: verificationMethods.map((m) => m['id']),
      assertionMethod: verificationMethods.map((m) => m['id']),
      service: [
        {
          id: `${didId}#jwks`,
          type: 'JsonWebKeySet',
          serviceEndpoint: `https://${domain}/.well-known/jwks.json`,
        },
        {
          id: `${didId}#grant-protocol`,
          type: 'GrantexProtocol',
          serviceEndpoint: `https://api.${domain}/v1`,
        },
      ],
    };

    return reply.send(doc);
  });
}
