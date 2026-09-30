/**
 * Consent withdrawal flow.
 *
 * DPDP Act 2023, s.6(4) — a data principal may withdraw consent at any time,
 * with the same ease as it was given; s.6(6) — the data fiduciary must then
 * cease processing within a reasonable time.
 */

import type { WithdrawConsentOptions, WithdrawalConfirmation } from '../types.js';
import { WithdrawalError } from '../errors.js';
import { asObject, dpdpRequest, dpdpUrl, opt, seg, toDate } from '../http.js';

/**
 * Withdraw consent for a specific consent record.
 *
 * `POST /v1/dpdp/consent-records/:id/withdraw`
 *
 * Options:
 *  - `revokeGrant` — also revoke the linked Grantex grant
 *  - `deleteProcessedData` — record a request to delete data processed under
 *    this consent (the data fiduciary carries it out; `dataDeleted` is always false)
 *
 * Fails with a `WithdrawalError` whose `code` is the server's: `NOT_FOUND` (404),
 * `ALREADY_WITHDRAWN`, `CONSENT_ERASED` or `CONSENT_EXPIRED` (409).
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

  const { data } = await dpdpRequest(
    {
      method: 'POST',
      url: dpdpUrl(options.baseUrl, [seg('consent-records'), recordId, seg('withdraw')]),
      apiKey: options.apiKey,
      body,
    },
    (f) => new WithdrawalError(f.message ?? `Withdrawal failed (${f.statusCode})`, f),
  );

  const raw = asObject(data);
  return {
    recordId: raw.recordId as string,
    status: 'withdrawn',
    withdrawnAt: toDate(raw.withdrawnAt) as Date,
    grantRevoked: raw.grantRevoked === true,
    dataDeleted: raw.dataDeleted === true,
    ...opt('dataDeletionRequested', typeof raw.dataDeletionRequested === 'boolean' ? raw.dataDeletionRequested : undefined),
  };
}
