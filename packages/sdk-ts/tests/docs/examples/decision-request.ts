import type { Grantex } from '@grantex/sdk';

/** Asks for a four-eyes decline for one agent and returns the page to send approvers to. */
export async function requestDecline(
  grantex: Grantex,
  caseId: string,
  caseVersion: string,
  memo: string,
  policyScore: Record<string, unknown>,
  agent: { id: string; grantId: string },
): Promise<string> {
  const request = await grantex.decisions.createRequest({
    action: { case_id: caseId, action: 'case_decision', decision: 'decline', subject: 'gb:00000001' },
    connector: 'acme_kyb',
    caseVersion,
    fourEyesOn: ['decline'], // the manifest's four_eyes_on for this tool
    memo: { content: memo }, // shown to the approver and bound into the grant by hash
    policyScore: { content: policyScore },
    agentId: agent.id, // the Grantex agent id: only its grant token fetches the grants,
    grantId: agent.grantId, // and they are consumed only for this agent and grant
  });
  // Approvers sign in on this page and approve there; the platform cannot approve.
  return String(request['approvalPage']);
}
