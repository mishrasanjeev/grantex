import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ConsentRecordList } from '../dpdp/ConsentRecordList';
import { ApiError } from '../../api/client';
import * as fx from '../../api/__tests__/fixtures/dpdpServer';

const mockListConsentRecords = vi.fn();
const mockGetDataPrincipalRecords = vi.fn();
const mockWithdrawConsent = vi.fn();
const mockRequestErasure = vi.fn();
const mockShow = vi.fn();
const mockNavigate = vi.fn();

vi.mock('../../api/dpdp', () => ({
  listConsentRecords: (...a: unknown[]) => mockListConsentRecords(...a),
  getDataPrincipalRecords: (...a: unknown[]) => mockGetDataPrincipalRecords(...a),
  withdrawConsent: (...a: unknown[]) => mockWithdrawConsent(...a),
  requestErasure: (...a: unknown[]) => mockRequestErasure(...a),
}));
vi.mock('../../store/toast', () => ({ useToast: () => ({ show: mockShow }) }));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

const page1 = fx.listConsentRecords_200;
const [activeRecord, erasedRecord] = page1.records;
const expiredRecord = {
  ...fx.consentRecord_200,
  recordId: 'crec_01J9ZEXPIREDEXPIREDEXPIRED0',
  purposes: [{ code: 'marketing', description: 'Offers by email' }],
  status: 'expired',
};

function r() { return render(<MemoryRouter><ConsentRecordList /></MemoryRouter>); }

async function search(user: ReturnType<typeof userEvent.setup>, id = 'user_123') {
  await user.type(screen.getByPlaceholderText('e.g. user_123'), id);
  await user.click(screen.getByRole('button', { name: 'Search' }));
}

describe('ConsentRecordList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListConsentRecords.mockResolvedValue(page1);
  });

  it('renders heading', () => {
    r();
    expect(screen.getByRole('heading', { name: 'Consent Records' })).toBeInTheDocument();
  });

  it('shows search prompt before search', () => {
    r();
    expect(screen.getByText('Search for consent records')).toBeInTheDocument();
  });

  it('disables Search button when input is empty', () => {
    r();
    expect(screen.getByRole('button', { name: 'Search' })).toBeDisabled();
  });

  it('searches with GET /v1/dpdp/consent-records?dataPrincipalId= (not principal records)', async () => {
    const user = userEvent.setup();
    r();
    await search(user);
    await waitFor(() => expect(mockListConsentRecords).toHaveBeenCalledWith({ dataPrincipalId: 'user_123', limit: 50 }));
    expect(mockGetDataPrincipalRecords).not.toHaveBeenCalled();
  });

  it('shows status badges including erased and expired', async () => {
    mockListConsentRecords.mockResolvedValue({ ...page1, records: [activeRecord, erasedRecord, expiredRecord], nextCursor: null, totalRecords: 3 });
    const user = userEvent.setup();
    r();
    await search(user);
    expect(await screen.findByText('active')).toBeInTheDocument();
    expect(screen.getByText('erased')).toBeInTheDocument();
    expect(screen.getByText('expired')).toBeInTheDocument();
  });

  it('shows the loaded count against totalRecords', async () => {
    const user = userEvent.setup();
    r();
    await search(user);
    expect(await screen.findByText(/Showing 2 of 7 records/)).toBeInTheDocument();
  });

  it('shows the principal from each record, falling back to the searched id', async () => {
    const { dataPrincipalId: _omit, ...noPrincipal } = { ...fx.consentRecord_200, recordId: 'crec_legacy_no_principal' };
    void _omit;
    mockListConsentRecords.mockResolvedValue({
      records: [{ ...activeRecord, dataPrincipalId: 'user_other' }, noPrincipal],
      totalRecords: 2,
      nextCursor: null,
    });
    const user = userEvent.setup();
    r();
    await search(user);
    const table = await screen.findByRole('table');
    expect(within(table).getByText('user_other')).toBeInTheDocument();
    expect(within(table).getByText('user_123')).toBeInTheDocument();
  });

  it('shows purpose codes in the table', async () => {
    const user = userEvent.setup();
    r();
    await search(user);
    expect(await screen.findByText('analytics, personalization')).toBeInTheDocument();
  });

  it('loads more with nextCursor and appends', async () => {
    mockListConsentRecords
      .mockResolvedValueOnce({ records: [activeRecord], totalRecords: 2, nextCursor: 'cursor-2' })
      .mockResolvedValueOnce({ records: [erasedRecord], totalRecords: 2, nextCursor: null });
    const user = userEvent.setup();
    r();
    await search(user);
    await user.click(await screen.findByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(mockListConsentRecords).toHaveBeenLastCalledWith({ dataPrincipalId: 'user_123', limit: 50, cursor: 'cursor-2' }));
    expect(await screen.findByText('erased')).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    expect(screen.getByText(/Showing 2 of 2 records/)).toBeInTheDocument();
  });

  it('shows Withdraw only for active records', async () => {
    const user = userEvent.setup();
    r();
    await search(user);
    await screen.findByText('active');
    expect(screen.getAllByRole('button', { name: 'Withdraw' })).toHaveLength(1);
  });

  it('shows empty state when no records found', async () => {
    mockListConsentRecords.mockResolvedValue({ records: [], totalRecords: 0, nextCursor: null });
    const user = userEvent.setup();
    r();
    await search(user);
    expect(await screen.findByText('No consent records')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Erase data principal' })).not.toBeInTheDocument();
  });

  it('shows error toast on search failure', async () => {
    mockListConsentRecords.mockRejectedValue(new Error('fail'));
    const user = userEvent.setup();
    r();
    await search(user);
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Failed to load consent records', 'error'));
  });

  it('withdraws from the list with a required reason and revokeGrant', async () => {
    mockWithdrawConsent.mockResolvedValue(fx.withdrawConsent_200);
    const user = userEvent.setup();
    r();
    await search(user);
    await user.click(await screen.findByRole('button', { name: 'Withdraw' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Withdraw Consent')).toBeInTheDocument();
    const submit = within(dialog).getByRole('button', { name: 'Withdraw' });
    expect(submit).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/Reason/), 'Asked by principal');
    await user.click(submit);
    await waitFor(() => expect(mockWithdrawConsent).toHaveBeenCalledWith(activeRecord!.recordId, { reason: 'Asked by principal', revokeGrant: true }));
  });

  it('handles 409 ALREADY_WITHDRAWN from the list and reloads', async () => {
    const e = fx.errors['409_ALREADY_WITHDRAWN'];
    mockWithdrawConsent.mockRejectedValue(new ApiError(409, e.code, e.message, e.requestId));
    const user = userEvent.setup();
    r();
    await search(user);
    await user.click(await screen.findByRole('button', { name: 'Withdraw' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText(/Reason/), 'x');
    await user.click(within(dialog).getByRole('button', { name: 'Withdraw' }));
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('This consent was already withdrawn. The record has been refreshed.', 'error'));
    await waitFor(() => expect(mockListConsentRecords).toHaveBeenCalledTimes(2));
  });

  // ── erasure ────────────────────────────────────────────────────────────

  it('erasure dialog states what is erased and what is retained', async () => {
    const user = userEvent.setup();
    r();
    await search(user);
    await user.click(await screen.findByRole('button', { name: 'Erase data principal' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/active grants of this data principal.s consent records are revoked/)).toBeInTheDocument();
    // Cascade and expanded erasure are server flags (off by default): the copy must not promise them.
    expect(within(dialog).getByText(/where this deployment enables the revocation cascade/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Consent records are marked erased/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Where this deployment enables expanded erasure, grievance descriptions and evidence are redacted/)).toBeInTheDocument();
    expect(within(dialog).getByText(/stored exports are kept until they expire/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/^Stored exports are deleted\.$/)).not.toBeInTheDocument();
    expect(within(dialog).getByText(/audit log is retained/)).toBeInTheDocument();
    expect(mockRequestErasure).not.toHaveBeenCalled();
  });

  it('erases the principal and shows counts and the retained list from the response', async () => {
    mockRequestErasure.mockResolvedValue(fx.erasure_201);
    const user = userEvent.setup();
    r();
    await search(user);
    await user.click(await screen.findByRole('button', { name: 'Erase data principal' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Erase' }));
    await waitFor(() => expect(mockRequestErasure).toHaveBeenCalledWith('user_123'));
    const result = await screen.findByRole('region', { name: 'Erasure result' });
    expect(within(result).getByText(fx.erasure_201.requestId)).toBeInTheDocument();
    expect(within(result).getByText('Records erased').nextSibling).toHaveTextContent('2');
    expect(within(result).getByText('Grants revoked').nextSibling).toHaveTextContent('1');
    expect(within(result).getByText('Grievances redacted').nextSibling).toHaveTextContent('0');
    expect(within(result).getByText('Exports deleted').nextSibling).toHaveTextContent('0');
    for (const item of fx.erasure_201.retained) {
      expect(within(result).getByText(item.category)).toBeInTheDocument();
      expect(within(result).getByText(item.reason)).toBeInTheDocument();
    }
    expect(within(result).getByText('consent_records').parentElement).toHaveTextContent('2');
    expect(within(result).getByText('stored_exports').parentElement).toHaveTextContent('1');
    // The list is reloaded to show the erased status.
    await waitFor(() => expect(mockListConsentRecords).toHaveBeenCalledTimes(2));
  });

  it('shows a clear message when erasure returns 404', async () => {
    mockRequestErasure.mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'No consent records for this data principal', 'req-1'));
    const user = userEvent.setup();
    r();
    await search(user);
    await user.click(await screen.findByRole('button', { name: 'Erase data principal' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Erase' }));
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('No consent records found for user_123; nothing was erased.', 'error'));
  });
});
