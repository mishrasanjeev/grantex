import type { Grantex } from '@grantex/sdk';

/** Calls a tool that needs a decision, with the decision grants a person approved. */
export async function callCaseDecision(
  grantex: Grantex,
  grantToken: string,
  decisionGrants: string[],
  toolCallArguments: Record<string, unknown>,
  currentCaseVersion: string,
): Promise<void> {
  const result = await grantex.enforce({
    grantToken,
    connector: 'acme_kyb',
    tool: 'case_decision',
    decisionGrants, // two for a decision listed in four_eyes_on
    arguments: toolCallArguments, // the approved action is derived from these
    caseVersion: currentCaseVersion, // from your own case state, never from the agent
  });
  if (!result.allowed) {
    // reasonCode is decision_required or decision_invalid; subReason says why
    throw new Error(`${result.reasonCode ?? 'denied'}/${result.subReason ?? ''}: ${result.reason}`);
  }
  // The grants are now spent: result.decision?.jtis
}
