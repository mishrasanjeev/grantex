import type { FastifyInstance } from 'fastify';
import { buildJwks, getEdKeyPair } from '../lib/crypto.js';
import { exportJWK } from 'jose';
import { config } from '../config.js';

export async function didRoutes(app: FastifyInstance): Promise<void> {
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
