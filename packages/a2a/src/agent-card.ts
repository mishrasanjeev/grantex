/**
 * Agent Card builder with Grantex authentication extensions.
 *
 * Generates A2A-compliant agent cards with Grantex auth configuration
 * for grant token validation.
 */

import type { A2AAgentCard, GrantexAgentCardOptions } from './types.js';

/**
 * Build an A2A agent card with Grantex authentication configured.
 *
 * @example
 * ```ts
 * const card = buildGrantexAgentCard({
 *   name: 'My Agent',
 *   description: 'An agent that does things',
 *   url: 'https://my-agent.example.com/a2a',
 *   jwksUri: 'https://grantex.dev/.well-known/jwks.json',
 *   issuer: 'https://grantex.dev',
 *   requiredScopes: ['read', 'write'],
 *   delegationAllowed: true,
 * });
 * ```
 */
export function buildGrantexAgentCard(options: GrantexAgentCardOptions): A2AAgentCard {
  return {
    name: options.name,
    description: options.description,
    url: options.url,
    ...(options.version !== undefined ? { version: options.version } : {}),
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    ...(options.capabilities !== undefined ? { capabilities: options.capabilities } : {}),
    authentication: {
      schemes: [
        {
          scheme: 'bearer',
          grantexConfig: {
            jwksUri: options.jwksUri,
            issuer: options.issuer,
            ...(options.requiredScopes !== undefined ? { requiredScopes: options.requiredScopes } : {}),
            ...(options.delegationAllowed !== undefined ? { delegationAllowed: options.delegationAllowed } : {}),
          },
        },
      ],
    },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    ...(options.skills !== undefined ? { skills: options.skills } : {}),
  };
}
