import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ConsentRecordDetail } from '../dpdp/ConsentRecordDetail';
import { ApiError } from '../../api/client';
import { formatDateTime } from '../../lib/format';
import * as fx from '../../api/__tests__/fixtures/dpdpServer';

const mockGetConsentRecord = vi.fn();
const mockWithdrawConsent = vi.fn();
const mockShow = vi.fn();

vi.mock('../../api/dpdp', () => ({
  getConsentRecord: (...a: unknown[]) => mockGetConsentRecord(...a),
  withdrawConsent: (...a: unknown[]) => mockWithdrawConsent(...a),
}));
vi.mock('../../store/toast', () => ({ useToast: () => ({ show: mockShow }) }));

const RECORD_ID = fx.consentRecord_200.recordId;

function r(id = RECORD_ID) {
  return render(
    <MemoryRouter initialEntries={[`/dashboard/dpdp/records/${encodeURIComponent(id)}`]}>
      <Routes><Route path="/dashboard/dpdp/records/:recordId" element={<ConsentRecordDetail />} /></Routes>
    </MemoryRouter>,
  );
}

function apiError(status: number, body: { message: string; code: string; requestId: string }) {
  return new ApiError(status, body.code, body.message, body.requestId);
}

async function openWithdraw(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Withdraw Consent' }));
  return screen.getByRole('dialog');
}

describe('ConsentRecordDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetConsentRecord.mockResolvedValue(fx.consentRecord_200);
  });

  it('fetches the record by id from GET /v1/dpdp/consent-records/:id', async () => {
    r();
    await waitFor(() => expect(mockGetConsentRecord).toHaveBeenCalledWith(RECORD_ID));
    expect(await screen.findByText(RECORD_ID)).toBeInTheDocument();
  });

  it('shows notice version, purposes with descriptions and a status badge', async () => {
    r();
    expect(await screen.findByText('privacy-notice')).toBeInTheDocument();
    expect(screen.getByText('2.0')).toBeInTheDocument();
    expect(screen.getByText('analytics')).toBeInTheDocument();
    expect(screen.getByText('Usage analytics for service improvement')).toBeInTheDocument();
    expect(screen.getByText('Personalized recommendations')).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
    expect(screen.getByText('Acme Health')).toBeInTheDocument();
  });

  it('shows erasedAt, the withdrawal reason and an erased badge for an erased record', async () => {
    mockGetConsentRecord.mockResolvedValue(fx.consentRecord_erased_legacy_200);
    r(fx.consentRecord_erased_legacy_200.recordId);
    expect(await screen.findByText('erased')).toBeInTheDocument();
    expect(screen.getByText('Data erased')).toBeInTheDocument();
    expect(screen.getAllByText(formatDateTime(fx.consentRecord_erased_legacy_200.erasedAt)).length).toBeGreaterThan(0);
    expect(screen.getByText(/Data erasure request/)).toBeInTheDocument();
    // Legacy record: no stored notice version.
    expect(screen.getByText('not recorded')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Withdraw Consent' })).not.toBeInTheDocument();
  });

  it('shows a not-found state on 404', async () => {
    mockGetConsentRecord.mockRejectedValue(apiError(404, fx.errors['404_NOT_FOUND']));
    r('crec_missing');
    expect(await screen.findByText('Consent record not found')).toBeInTheDocument();
    expect(document.querySelector('a[href="/dashboard/dpdp/records"]')).toBeTruthy();
  });

  it('shows a load error toast on other failures', async () => {
    mockGetConsentRecord.mockRejectedValue(new ApiError(500, 'INTERNAL', 'boom'));
    r();
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Failed to load consent record', 'error'));
  });

  it('withdraw dialog explains that withdrawal stops processing going forward', async () => {
    const user = userEvent.setup();
    r();
    const dialog = await openWithdraw(user);
    expect(within(dialog).getByText(/stops processing under this consent from now on/)).toBeInTheDocument();
    expect(within(dialog).getByText(/does not undo processing that already happened/)).toBeInTheDocument();
    expect(within(dialog).getByText(/the grant stays active/i)).toBeInTheDocument();
  });

  it('withdraw requires a reason: submit is disabled while it is empty', async () => {
    const user = userEvent.setup();
    r();
    const dialog = await openWithdraw(user);
    const submit = within(dialog).getByRole('button', { name: 'Withdraw' });
    expect(submit).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/Reason/), '   ');
    expect(submit).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/Reason/), 'Principal asked to stop');
    expect(submit).toBeEnabled();
  });

  it('sends the typed reason and revokeGrant=true by default', async () => {
    mockWithdrawConsent.mockResolvedValue(fx.withdrawConsent_200);
    const user = userEvent.setup();
    r();
    const dialog = await openWithdraw(user);
    const revoke = within(dialog).getByRole('checkbox', { name: /Also revoke the grant/ });
    expect(revoke).toBeChecked();
    await user.type(within(dialog).getByLabelText(/Reason/), 'Principal asked to stop');
    await user.click(within(dialog).getByRole('button', { name: 'Withdraw' }));
    await waitFor(() => expect(mockWithdrawConsent).toHaveBeenCalledWith(RECORD_ID, { reason: 'Principal asked to stop', revokeGrant: true }));
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Consent withdrawn and grant revoked', 'success'));
    expect(await screen.findByText('withdrawn')).toBeInTheDocument();
    expect(screen.getByText(/Principal asked to stop/)).toBeInTheDocument();
  });

  it('sends revokeGrant=false when the checkbox is cleared', async () => {
    mockWithdrawConsent.mockResolvedValue({ ...fx.withdrawConsent_200, grantRevoked: false });
    const user = userEvent.setup();
    r();
    const dialog = await openWithdraw(user);
    await user.click(within(dialog).getByRole('checkbox', { name: /Also revoke the grant/ }));
    await user.type(within(dialog).getByLabelText(/Reason/), 'Stop analytics');
    await user.click(within(dialog).getByRole('button', { name: 'Withdraw' }));
    await waitFor(() => expect(mockWithdrawConsent).toHaveBeenCalledWith(RECORD_ID, { reason: 'Stop analytics', revokeGrant: false }));
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Consent withdrawn; the grant was not revoked', 'success'));
  });

  it.each([
    ['409_ALREADY_WITHDRAWN', 'This consent was already withdrawn. The record has been refreshed.'],
    ['409_CONSENT_ERASED', 'This consent record was erased and can no longer be withdrawn. The record has been refreshed.'],
    ['409_CONSENT_EXPIRED', 'This consent has expired, so there is nothing to withdraw. The record has been refreshed.'],
  ] as const)('handles %s with a specific message and refreshes the record', async (key, message) => {
    mockWithdrawConsent.mockRejectedValue(apiError(409, fx.errors[key]));
    const user = userEvent.setup();
    r();
    const dialog = await openWithdraw(user);
    await user.type(within(dialog).getByLabelText(/Reason/), 'x');
    await user.click(within(dialog).getByRole('button', { name: 'Withdraw' }));
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith(message, 'error'));
    await waitFor(() => expect(mockGetConsentRecord).toHaveBeenCalledTimes(2));
  });

  it('shows a generic failure toast for other withdraw errors', async () => {
    mockWithdrawConsent.mockRejectedValue(new Error('network'));
    const user = userEvent.setup();
    r();
    const dialog = await openWithdraw(user);
    await user.type(within(dialog).getByLabelText(/Reason/), 'x');
    await user.click(within(dialog).getByRole('button', { name: 'Withdraw' }));
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Failed to withdraw consent', 'error'));
  });

  it('has back navigation link', async () => {
    r();
    await screen.findByText(RECORD_ID);
    expect(document.querySelector('a[href="/dashboard/dpdp/records"]')).toBeTruthy();
  });
});
