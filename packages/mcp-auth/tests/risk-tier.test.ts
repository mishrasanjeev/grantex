// SPDX-License-Identifier: Apache-2.0
/** `risk_tier: high` makes a tool require a decision grant in the MCP tool policy. */
import { describe, expect, it } from 'vitest';
import { toolPolicyFromManifests } from '../src/resource/tool-policy.js';

describe('risk_tier in toolPolicyFromManifests', () => {
  it('a high-risk tool requires a decision; lower tiers are reported', () => {
    const policy = toolPolicyFromManifests([{
      connector: 'acme_kyb',
      tools: {
        get_case: { permission: 'read', risk_tier: 'low' },
        close_case: { permission: 'write', risk_tier: 'high' },
      },
    }]);
    const byName = Object.fromEntries(policy.tools.map((t) => [t.name, t]));
    expect(byName['close_case']?.requiresDecision).toBe(true);
    expect(byName['close_case']?.riskTier).toBe('high');
    expect(byName['get_case']?.requiresDecision).toBe(false);
    expect(byName['get_case']?.riskTier).toBe('low');
  });

  it('rejects high on a read tool and unknown tiers', () => {
    expect(() => toolPolicyFromManifests([{ connector: 'acme_kyb', tools: { get_case: { permission: 'read', risk_tier: 'high' } } }]))
      .toThrow('declares risk_tier high on a read tool');
    expect(() => toolPolicyFromManifests([{ connector: 'acme_kyb', tools: { close_case: { permission: 'write', risk_tier: 'critical' as 'high' } } }]))
      .toThrow('risk_tier must be one of low, medium, high');
  });
});
