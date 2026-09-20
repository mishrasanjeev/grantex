import type { DecisionVerifier } from '@grantex/mcp-auth';

/**
 * Refuse every tool that declares requires_decision, for example on a
 * server that must never perform decisions. For Grantex decision grants use
 * grantexDecisionVerifier, which verifies and consumes them.
 */
export const decisionVerifier: DecisionVerifier = {
  async verify() {
    return { status: 'absent' };
  },
};
