import type { Grantex } from '@grantex/sdk';

/** The decision grants of a request made for an agent, fetched with that agent's grant token. */
export async function grantsForAgent(grantex: Grantex, requestId: string, agentGrantToken: string): Promise<string[]> {
  // With the binding on, the API key alone never receives them: getRequest
  // reports decisionGrantsReady and no decisionGrants.
  const released = await grantex.decisions.getGrants(requestId, agentGrantToken);
  // Present once fully approved, and only while unspent, unrevoked and unexpired.
  const grants = released['decisionGrants'];
  return Array.isArray(grants) ? grants.map(String) : [];
}
