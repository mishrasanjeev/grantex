/**
 * Consent withdrawal flow.
 *
 * DPDP Act 2023, Section 6(4) — a data principal may withdraw consent
 * at any time with the same ease as it was given.
 */

import type { WithdrawConsentOptions, WithdrawalConfirmation } from '../types.js';
import { WithdrawalError } from '../errors.js';

/**
 * Withdraw consent for a specific consent record.
 *
 * `POST /v1/dpdp/consent-records/:id/withdraw`
 *
 * Options:
 *  - `revokeGrant` — also revoke the linked Grantex grant token
 *  - `deleteProcessedData` — request deletion of all data processed under this consent
 */
export async function withdrawConsent(
  recordId: string,
  reason: string,
  options: WithdrawConsentOptions,
): Promise<WithdrawalConfirmation> {
  if (!recordId) {
    throw new WithdrawalError('recordId is required');
  }
  if (!reason) {
    throw new WithdrawalError('Withdrawal reason is required');
  }

  const body = {
    reason,
    revokeGrant: options.revokeGrant ?? false,
    deleteProcessedData: options.deleteProcessedData ?? false,
  };

  const res = await fetch(
    `${options.baseUrl}/v1/dpdp/consent-records/${encodeURIComponent(recordId)}/withdraw`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify(body),
    },
  );

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({})) as Record<string, unknown>;
    throw new WithdrawalError(
      (errBody.message as string) ?? `Withdrawal failed (${res.status})`,
    );
  }

  const data = (await res.json()) as Record<string, unknown>;

  return {
    recordId: data.recordId as string,
    status: 'withdrawn',
    withdrawnAt: new Date(data.withdrawnAt as string),
    grantRevoked: (data.grantRevoked as boolean) ?? false,
    dataDeleted: (data.dataDeleted as boolean) ?? false,
  };
}
