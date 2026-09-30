import { useEffect, useId, useState } from 'react';
import { ApiError } from '../../api/client';
import type { WithdrawConsentRequest } from '../../api/dpdp';
import { Modal } from '../../components/ui/Modal';
import { Button } from '../../components/ui/Button';

interface WithdrawConsentDialogProps {
  open: boolean;
  recordId: string;
  grantId: string;
  loading?: boolean;
  onClose: () => void;
  onConfirm: (request: WithdrawConsentRequest) => void;
}

export function WithdrawConsentDialog({ open, recordId, grantId, loading, onClose, onConfirm }: WithdrawConsentDialogProps) {
  const [reason, setReason] = useState('');
  const [revokeGrant, setRevokeGrant] = useState(true);
  const reasonId = useId();
  const revokeId = useId();

  useEffect(() => {
    if (open) {
      setReason('');
      setRevokeGrant(true);
    }
  }, [open, recordId]);

  const trimmed = reason.trim();

  return (
    <Modal open={open} onClose={onClose} title="Withdraw Consent">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!trimmed || loading) return;
          onConfirm({ reason: trimmed, revokeGrant });
        }}
        className="space-y-4"
      >
        <p className="text-sm text-gx-muted">
          Withdrawal of consent record <span className="font-mono text-gx-text">{recordId}</span> is recorded now
          and stops processing under this consent from now on. It does not undo processing that already happened.
        </p>
        <div>
          <label htmlFor={reasonId} className="block text-xs font-medium text-gx-muted mb-1">
            Reason (required)
          </label>
          <input
            id={reasonId}
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Data principal withdrew consent by email"
            className="w-full px-3 py-2 bg-gx-bg border border-gx-border rounded-md text-sm text-gx-text placeholder:text-gx-muted focus:outline-none focus:border-gx-accent"
            required
          />
        </div>
        <div>
          <label htmlFor={revokeId} className="flex items-center gap-2 cursor-pointer">
            <input
              id={revokeId}
              type="checkbox"
              checked={revokeGrant}
              onChange={(e) => setRevokeGrant(e.target.checked)}
              className="rounded border-gx-border text-gx-accent focus:ring-gx-accent"
            />
            <span className="text-sm text-gx-text">
              Also revoke the grant <span className="font-mono text-xs text-gx-muted">{grantId}</span>
            </span>
          </label>
          <p className="text-xs text-gx-muted mt-1 ml-6">
            If unchecked, the grant stays active and must be revoked separately.
          </p>
        </div>
        <div className="flex justify-end gap-3">
          <Button type="button" variant="secondary" size="sm" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" size="sm" disabled={loading || !trimmed}>
            Withdraw
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Message for a failed withdrawal; `conflict` is true for the 409 codes that call for a refresh. */
export function withdrawErrorMessage(err: unknown): { message: string; conflict: boolean } {
  if (err instanceof ApiError && err.status === 409) {
    switch (err.code) {
      case 'ALREADY_WITHDRAWN':
        return { message: 'This consent was already withdrawn. The record has been refreshed.', conflict: true };
      case 'CONSENT_ERASED':
        return { message: 'This consent record was erased and can no longer be withdrawn. The record has been refreshed.', conflict: true };
      case 'CONSENT_EXPIRED':
        return { message: 'This consent has expired, so there is nothing to withdraw. The record has been refreshed.', conflict: true };
    }
  }
  if (err instanceof ApiError && err.status === 404) {
    return { message: 'Consent record not found', conflict: true };
  }
  return { message: 'Failed to withdraw consent', conflict: false };
}

export function withdrawSuccessMessage(grantRevoked: boolean): string {
  return grantRevoked ? 'Consent withdrawn and grant revoked' : 'Consent withdrawn; the grant was not revoked';
}
