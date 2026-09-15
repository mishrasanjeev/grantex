import type { DecisionVerifier } from '@grantex/mcp-auth';

/**
 * Until decision grants are available, refuse every tool that declares
 * requires_decision. Replace the body with real verification (signature,
 * semantic action hash, single-use jti, case-bound expiry) when they are.
 */
export const decisionVerifier: DecisionVerifier = {
  async verify() {
    return { status: 'absent' };
  },
};
