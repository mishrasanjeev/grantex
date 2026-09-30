import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { GrievanceList } from '../dpdp/GrievanceList';
import { ApiError } from '../../api/client';
import * as fx from '../../api/__tests__/fixtures/dpdpServer';

const mockListGrievances = vi.fn();
const mockFileGrievance = vi.fn();
const mockGetGrievance = vi.fn();
const mockUpdateGrievance = vi.fn();
const mockShow = vi.fn();

vi.mock('../../api/dpdp', () => ({
  listGrievances: (...a: unknown[]) => mockListGrievances(...a),
  fileGrievance: (...a: unknown[]) => mockFileGrievance(...a),
  getGrievance: (...a: unknown[]) => mockGetGrievance(...a),
  updateGrievance: (...a: unknown[]) => mockUpdateGrievance(...a),
}));
vi.mock('../../store/toast', () => ({ useToast: () => ({ show: mockShow }) }));

const base = fx.listGrievances_200.grievances[0]!;
const PAST = '2020-01-01T00:00:00.000Z';
const FUTURE = '2999-01-01T00:00:00.000Z';
const submitted = { ...base, grievanceId: 'grv_sub', referenceNumber: 'GRV-2026-SUB', status: 'submitted', expectedResolutionBy: FUTURE };
const inReview = { ...base, grievanceId: 'grv_rev', referenceNumber: 'GRV-2026-REV', status: 'in_review', expectedResolutionBy: FUTURE, responsePeriodDays: 30 };
const overdue = { ...base, grievanceId: 'grv_late', referenceNumber: 'GRV-2026-LATE', status: 'submitted', expectedResolutionBy: PAST };
const resolvedLate = { ...base, grievanceId: 'grv_done', referenceNumber: 'GRV-2026-DONE', status: 'resolved', expectedResolutionBy: PAST, resolvedAt: PAST, resolution: 'Done' };
const rejected = { ...base, grievanceId: 'grv_rej', referenceNumber: 'GRV-2026-REJ', status: 'rejected', expectedResolutionBy: PAST, resolution: 'Out of scope' };

function r() { return render(<MemoryRouter><GrievanceList /></MemoryRouter>); }

function row(ref: string): HTMLElement {
  return screen.getByText(ref).closest('tr') as HTMLElement;
}

describe('GrievanceList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListGrievances.mockResolvedValue(fx.listGrievances_200);
  });

  it('renders heading', async () => {
    r();
    expect(screen.getByRole('heading', { name: 'Grievances' })).toBeInTheDocument();
    await waitFor(() => expect(mockListGrievances).toHaveBeenCalled());
  });

  it('lists grievances from GET /v1/dpdp/grievances on load', async () => {
    r();
    await waitFor(() => expect(mockListGrievances).toHaveBeenCalledWith({ limit: 50 }));
    await screen.findByText(base.referenceNumber);
    const tr = row(base.referenceNumber);
    expect(within(tr).getByText('unauthorized-processing')).toBeInTheDocument();
    expect(within(tr).getByText('submitted')).toBeInTheDocument();
    expect(within(tr).getByText('7 days')).toBeInTheDocument();
    expect(within(tr).getByText('user_123')).toBeInTheDocument();
  });

  it('shows status badges for every server status', async () => {
    mockListGrievances.mockResolvedValue({ grievances: [submitted, inReview, resolvedLate, rejected], nextCursor: null });
    r();
    await screen.findByText('GRV-2026-SUB');
    expect(within(row('GRV-2026-SUB')).getByText('submitted')).toBeInTheDocument();
    expect(within(row('GRV-2026-REV')).getByText('in review')).toBeInTheDocument();
    expect(within(row('GRV-2026-DONE')).getByText('resolved')).toBeInTheDocument();
    expect(within(row('GRV-2026-REJ')).getByText('rejected')).toBeInTheDocument();
  });

  it('highlights overdue grievances only while they are open', async () => {
    mockListGrievances.mockResolvedValue({ grievances: [overdue, submitted, resolvedLate, rejected], nextCursor: null });
    r();
    await screen.findByText('GRV-2026-LATE');
    expect(within(row('GRV-2026-LATE')).getByText('overdue')).toBeInTheDocument();
    expect(within(row('GRV-2026-SUB')).queryByText('overdue')).not.toBeInTheDocument();
    expect(within(row('GRV-2026-DONE')).queryByText('overdue')).not.toBeInTheDocument();
    expect(within(row('GRV-2026-REJ')).queryByText('overdue')).not.toBeInTheDocument();
  });

  it('filters by status', async () => {
    const user = userEvent.setup();
    r();
    await screen.findByText(base.referenceNumber);
    await user.selectOptions(screen.getByLabelText('Status'), 'in_review');
    await waitFor(() => expect(mockListGrievances).toHaveBeenLastCalledWith({ status: 'in_review', limit: 50 }));
  });

  it('loads more with nextCursor', async () => {
    mockListGrievances
      .mockResolvedValueOnce({ grievances: [submitted], nextCursor: 'next-1' })
      .mockResolvedValueOnce({ grievances: [inReview], nextCursor: null });
    const user = userEvent.setup();
    r();
    await user.click(await screen.findByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(mockListGrievances).toHaveBeenLastCalledWith({ limit: 50, cursor: 'next-1' }));
    expect(await screen.findByText('GRV-2026-REV')).toBeInTheDocument();
    expect(screen.getByText('GRV-2026-SUB')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('shows empty state when there are no grievances', async () => {
    mockListGrievances.mockResolvedValue({ grievances: [], nextCursor: null });
    r();
    expect(await screen.findByText('No grievances')).toBeInTheDocument();
  });

  it('shows a load error toast', async () => {
    mockListGrievances.mockRejectedValue(new Error('fail'));
    r();
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Failed to load grievances', 'error'));
  });

  // ── transitions ────────────────────────────────────────────────────────

  it('offers only the valid next transitions per status', async () => {
    mockListGrievances.mockResolvedValue({ grievances: [submitted, inReview, resolvedLate, rejected], nextCursor: null });
    r();
    await screen.findByText('GRV-2026-SUB');
    const sub = within(row('GRV-2026-SUB'));
    expect(sub.getByRole('button', { name: 'Start review' })).toBeInTheDocument();
    expect(sub.queryByRole('button', { name: 'Resolve' })).not.toBeInTheDocument();
    const rev = within(row('GRV-2026-REV'));
    expect(rev.getByRole('button', { name: 'Resolve' })).toBeInTheDocument();
    expect(rev.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
    expect(rev.queryByRole('button', { name: 'Start review' })).not.toBeInTheDocument();
    expect(within(row('GRV-2026-DONE')).queryAllByRole('button')).toHaveLength(0);
    expect(within(row('GRV-2026-REJ')).queryAllByRole('button')).toHaveLength(0);
  });

  it('moves a submitted grievance to in_review', async () => {
    mockListGrievances.mockResolvedValue({ grievances: [submitted], nextCursor: null });
    mockUpdateGrievance.mockResolvedValue({ ...fx.getGrievance_200, grievanceId: 'grv_sub', referenceNumber: 'GRV-2026-SUB', expectedResolutionBy: FUTURE });
    const user = userEvent.setup();
    r();
    await user.click(await screen.findByRole('button', { name: 'Start review' }));
    await waitFor(() => expect(mockUpdateGrievance).toHaveBeenCalledWith('grv_sub', { status: 'in_review' }));
    await waitFor(() => expect(within(row('GRV-2026-SUB')).getByText('in review')).toBeInTheDocument());
  });

  it('resolving requires resolution text and sends it', async () => {
    mockListGrievances.mockResolvedValue({ grievances: [inReview], nextCursor: null });
    mockUpdateGrievance.mockResolvedValue({ ...fx.updateGrievance_200, grievanceId: 'grv_rev', referenceNumber: 'GRV-2026-REV' });
    const user = userEvent.setup();
    r();
    await user.click(await screen.findByRole('button', { name: 'Resolve' }));
    const dialog = screen.getByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Mark resolved' });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/Resolution/), 'Marketing processing stopped');
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    await waitFor(() => expect(mockUpdateGrievance).toHaveBeenCalledWith('grv_rev', { status: 'resolved', resolution: 'Marketing processing stopped' }));
    await waitFor(() => expect(within(row('GRV-2026-REV')).getByText('resolved')).toBeInTheDocument());
  });

  it('rejecting requires resolution text and sends it', async () => {
    mockListGrievances.mockResolvedValue({ grievances: [inReview], nextCursor: null });
    mockUpdateGrievance.mockResolvedValue({ ...fx.updateGrievance_200, grievanceId: 'grv_rev', referenceNumber: 'GRV-2026-REV', status: 'rejected' });
    const user = userEvent.setup();
    r();
    await user.click(await screen.findByRole('button', { name: 'Reject' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Mark rejected' })).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/Resolution/), 'Not a personal data matter');
    await user.click(within(dialog).getByRole('button', { name: 'Mark rejected' }));
    await waitFor(() => expect(mockUpdateGrievance).toHaveBeenCalledWith('grv_rev', { status: 'rejected', resolution: 'Not a personal data matter' }));
  });

  it('removes a row that no longer matches the active status filter after a transition', async () => {
    const other = { ...submitted, grievanceId: 'grv_sub2', referenceNumber: 'GRV-2026-SUB2' };
    mockListGrievances.mockImplementation((p: { status?: string }) => Promise.resolve(
      p.status === 'submitted'
        ? { grievances: [submitted, other], nextCursor: null }
        : { grievances: [submitted, other, inReview], nextCursor: null }));
    mockUpdateGrievance.mockResolvedValue({ ...fx.getGrievance_200, grievanceId: 'grv_sub', referenceNumber: 'GRV-2026-SUB', status: 'in_review', expectedResolutionBy: FUTURE });
    const user = userEvent.setup();
    r();
    await screen.findByText('GRV-2026-REV');
    await user.selectOptions(screen.getByLabelText('Status'), 'submitted');
    await waitFor(() => expect(screen.queryByText('GRV-2026-REV')).not.toBeInTheDocument());
    await user.click(within(row('GRV-2026-SUB')).getByRole('button', { name: 'Start review' }));
    await waitFor(() => expect(mockUpdateGrievance).toHaveBeenCalledWith('grv_sub', { status: 'in_review' }));
    await waitFor(() => expect(screen.queryByText('GRV-2026-SUB')).not.toBeInTheDocument());
    expect(screen.getByText('GRV-2026-SUB2')).toBeInTheDocument();
    expect(mockShow).toHaveBeenCalledWith('Grievance GRV-2026-SUB is now in review', 'success');
  });

  it('keeps an updated row in place when it still matches the active status filter', async () => {
    mockListGrievances.mockResolvedValue({ grievances: [inReview], nextCursor: null });
    // A server that reports the row still in review keeps it under the in_review filter.
    mockUpdateGrievance.mockResolvedValue({ ...fx.getGrievance_200, grievanceId: 'grv_rev', referenceNumber: 'GRV-2026-REV', status: 'in_review', expectedResolutionBy: FUTURE });
    const user = userEvent.setup();
    r();
    await screen.findByText('GRV-2026-REV');
    await user.selectOptions(screen.getByLabelText('Status'), 'in_review');
    await waitFor(() => expect(mockListGrievances).toHaveBeenLastCalledWith({ status: 'in_review', limit: 50 }));
    await user.click(within(row('GRV-2026-REV')).getByRole('button', { name: 'Resolve' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText(/Resolution/), 'Noted');
    await user.click(within(dialog).getByRole('button', { name: 'Mark resolved' }));
    await waitFor(() => expect(mockUpdateGrievance).toHaveBeenCalled());
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Grievance GRV-2026-REV is now in review', 'success'));
    expect(screen.getByText('GRV-2026-REV')).toBeInTheDocument();
  });

  it('keeps the updated row with no status filter', async () => {
    mockListGrievances.mockResolvedValue({ grievances: [submitted], nextCursor: null });
    mockUpdateGrievance.mockResolvedValue({ ...fx.getGrievance_200, grievanceId: 'grv_sub', referenceNumber: 'GRV-2026-SUB', status: 'in_review', expectedResolutionBy: FUTURE });
    const user = userEvent.setup();
    r();
    await user.click(await screen.findByRole('button', { name: 'Start review' }));
    await waitFor(() => expect(within(row('GRV-2026-SUB')).getByText('in review')).toBeInTheDocument());
  });

  it('handles 409 INVALID_TRANSITION by reloading the list', async () => {
    const e = fx.errors['409_INVALID_TRANSITION'];
    mockListGrievances.mockResolvedValue({ grievances: [submitted], nextCursor: null });
    mockUpdateGrievance.mockRejectedValue(new ApiError(409, e.code, e.message, e.requestId));
    const user = userEvent.setup();
    r();
    await user.click(await screen.findByRole('button', { name: 'Start review' }));
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith(
      'This grievance has already moved to another status. The list has been refreshed.', 'error'));
    await waitFor(() => expect(mockListGrievances).toHaveBeenCalledTimes(2));
  });

  // ── filing ─────────────────────────────────────────────────────────────

  async function openForm(user: ReturnType<typeof userEvent.setup>) {
    await screen.findByText(base.referenceNumber);
    await user.click(screen.getAllByRole('button', { name: 'File Grievance' })[0]!);
    await screen.findByText('File New Grievance');
  }
  function submitButton() {
    return screen.getAllByRole('button', { name: 'File Grievance' }).find((b) => (b as HTMLButtonElement).type === 'submit')!;
  }

  it('shows grievance form fields', async () => {
    const user = userEvent.setup();
    r();
    await openForm(user);
    expect(screen.getByLabelText('Data Principal ID *')).toBeInTheDocument();
    expect(screen.getByLabelText('Type *')).toBeInTheDocument();
    expect(screen.getByLabelText('Description *')).toBeInTheDocument();
    expect(screen.getByLabelText(/Response period \(days\)/)).toBeInTheDocument();
  });

  it('files a grievance with a free-text type, optional recordId and response period', async () => {
    mockFileGrievance.mockResolvedValueOnce(fx.fileGrievance_202);
    const user = userEvent.setup();
    r();
    await openForm(user);
    await user.type(screen.getByLabelText('Data Principal ID *'), 'user_123');
    await user.clear(screen.getByLabelText('Type *'));
    await user.type(screen.getByLabelText('Type *'), 'unauthorized-processing');
    await user.type(screen.getByLabelText('Description *'), 'Data used without consent');
    await user.type(screen.getByLabelText(/Response period \(days\)/), '30');
    await user.click(submitButton());
    await waitFor(() => expect(mockFileGrievance).toHaveBeenCalledWith({
      dataPrincipalId: 'user_123',
      type: 'unauthorized-processing',
      description: 'Data used without consent',
      responsePeriodDays: 30,
    }));
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith(`Grievance filed: ${fx.fileGrievance_202.referenceNumber}`, 'success'));
    await waitFor(() => expect(mockListGrievances).toHaveBeenCalledTimes(2));
  });

  it('omits responsePeriodDays when left blank and sends recordId when given', async () => {
    mockFileGrievance.mockResolvedValueOnce(fx.fileGrievance_202);
    const user = userEvent.setup();
    r();
    await openForm(user);
    await user.type(screen.getByLabelText('Data Principal ID *'), 'user_123');
    await user.type(screen.getByLabelText(/Consent Record ID/), 'crec_1');
    await user.type(screen.getByLabelText('Description *'), 'Test');
    await user.click(submitButton());
    await waitFor(() => expect(mockFileGrievance).toHaveBeenCalledWith({
      dataPrincipalId: 'user_123',
      type: 'consent-violation',
      description: 'Test',
      recordId: 'crec_1',
    }));
  });

  it('rejects a response period outside 1..90 days', async () => {
    const user = userEvent.setup();
    r();
    await openForm(user);
    await user.type(screen.getByLabelText('Data Principal ID *'), 'user_123');
    await user.type(screen.getByLabelText('Description *'), 'Test');
    await user.type(screen.getByLabelText(/Response period \(days\)/), '91');
    await user.click(submitButton());
    expect(await screen.findByText('Response period must be a whole number of days from 1 to 90.')).toBeInTheDocument();
    expect(mockFileGrievance).not.toHaveBeenCalled();
  });

  it('shows error toast on file failure', async () => {
    mockFileGrievance.mockRejectedValueOnce(new Error('fail'));
    const user = userEvent.setup();
    r();
    await openForm(user);
    await user.type(screen.getByLabelText('Data Principal ID *'), 'user-1');
    await user.type(screen.getByLabelText('Description *'), 'Test');
    await user.click(submitButton());
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Failed to file grievance', 'error'));
  });

  // ── lookup ─────────────────────────────────────────────────────────────

  it('disables Lookup button when input is empty', async () => {
    r();
    expect(screen.getByRole('button', { name: 'Lookup' })).toBeDisabled();
    await waitFor(() => expect(mockListGrievances).toHaveBeenCalled());
  });

  it('looks up a grievance by ID and shows its description', async () => {
    mockListGrievances.mockResolvedValue({ grievances: [], nextCursor: null });
    mockGetGrievance.mockResolvedValueOnce(fx.getGrievance_200);
    const user = userEvent.setup();
    r();
    await user.type(screen.getByPlaceholderText('e.g. grv_01ABCDEF...'), fx.getGrievance_200.grievanceId);
    await user.click(screen.getByRole('button', { name: 'Lookup' }));
    await waitFor(() => expect(mockGetGrievance).toHaveBeenCalledWith(fx.getGrievance_200.grievanceId));
    expect(await screen.findByText(fx.getGrievance_200.description)).toBeInTheDocument();
    expect(screen.getAllByText(fx.getGrievance_200.referenceNumber).length).toBeGreaterThan(0);
  });

  it('shows error on lookup failure', async () => {
    mockGetGrievance.mockRejectedValueOnce(new ApiError(404, 'NOT_FOUND', 'Grievance not found', 'req-1'));
    const user = userEvent.setup();
    r();
    await user.type(screen.getByPlaceholderText('e.g. grv_01ABCDEF...'), 'grv-999');
    await user.click(screen.getByRole('button', { name: 'Lookup' }));
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Grievance not found', 'error'));
  });
});
