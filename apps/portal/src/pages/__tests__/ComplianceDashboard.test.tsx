import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ComplianceDashboard } from '../compliance/ComplianceDashboard';
import { formatDate } from '../../lib/format';
import * as fx from '../../api/__tests__/fixtures/dpdpServer';

const mockGetSummary = vi.fn();
const mockExportGrants = vi.fn();
const mockExportAudit = vi.fn();
const mockExportEvidence = vi.fn();
const mockListConsentRecords = vi.fn();
const mockListGrievances = vi.fn();
const mockListConsentNotices = vi.fn();
const mockShow = vi.fn();

vi.mock('../../api/compliance', () => ({
  getComplianceSummary: () => mockGetSummary(),
  exportGrants: () => mockExportGrants(),
  exportAudit: () => mockExportAudit(),
  exportEvidencePack: (...a: unknown[]) => mockExportEvidence(...a),
}));
vi.mock('../../api/dpdp', () => ({
  listConsentRecords: (...a: unknown[]) => mockListConsentRecords(...a),
  listGrievances: (...a: unknown[]) => mockListGrievances(...a),
  listConsentNotices: (...a: unknown[]) => mockListConsentNotices(...a),
}));
vi.mock('../../store/toast', () => ({ useToast: () => ({ show: mockShow }) }));

globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock');
globalThis.URL.revokeObjectURL = vi.fn();

const summary = {
  generatedAt: '2026-01-01T00:00:00Z', plan: 'pro',
  agents: { total: 5, active: 4, suspended: 1, revoked: 0 },
  grants: { total: 10, active: 7, revoked: 2, expired: 1 },
  auditEntries: { total: 100, success: 90, failure: 5, blocked: 5 },
  policies: { total: 3 },
};

const g = fx.listGrievances_200.grievances[0]!;
const submittedPage = { grievances: [{ ...g, grievanceId: 'grv_a', expectedResolutionBy: '2999-01-05T12:00:00.000Z' }], nextCursor: null };
const inReviewPage = { grievances: [{ ...g, grievanceId: 'grv_b', status: 'in_review', expectedResolutionBy: '2999-01-02T12:00:00.000Z' }], nextCursor: null };

function grievancesByStatus(params: { status?: string }) {
  if (params.status === 'submitted') return Promise.resolve(submittedPage);
  if (params.status === 'in_review') return Promise.resolve(inReviewPage);
  return Promise.reject(new Error(`unexpected status ${params.status}`));
}

function r() { return render(<MemoryRouter><ComplianceDashboard /></MemoryRouter>); }

describe('ComplianceDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSummary.mockResolvedValue(summary);
    mockListConsentRecords.mockResolvedValue(fx.listConsentRecords_200);
    mockListGrievances.mockImplementation(grievancesByStatus);
    mockListConsentNotices.mockResolvedValue(fx.listConsentNotices_200);
  });

  it('shows no fabricated framework scores or compliance percentages', async () => {
    r();
    await screen.findByText('pro plan');
    await screen.findByRole('region', { name: 'Consent records' });
    expect(screen.queryByText('DPDP 2023')).not.toBeInTheDocument();
    expect(screen.queryByText('EU AI Act')).not.toBeInTheDocument();
    expect(screen.queryByText('OWASP Agentic Top 10')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/%/);
  });

  it('displays plan badge', async () => {
    r();
    await waitFor(() => expect(screen.getByText('pro plan')).toBeInTheDocument());
  });

  it('shows summary stats', async () => {
    r();
    await waitFor(() => expect(screen.getByText('5')).toBeInTheDocument()); // agents.total
    expect(screen.getByText('10')).toBeInTheDocument(); // grants.total
    expect(screen.getByText('100')).toBeInTheDocument(); // audit total
    expect(screen.getByText('3')).toBeInTheDocument(); // policies total
  });

  it('shows consent record totals from totalRecords and labels a partial status breakdown honestly', async () => {
    r();
    const region = await screen.findByRole('region', { name: 'Consent records' });
    await waitFor(() => expect(within(region).getByText('7')).toBeInTheDocument());
    expect(mockListConsentRecords).toHaveBeenCalledWith({ limit: 200 });
    expect(within(region).getByText('In the latest 2 records:')).toBeInTheDocument();
    expect(within(region).getByText('1 active')).toBeInTheDocument();
    expect(within(region).getByText('1 erased')).toBeInTheDocument();
  });

  it('labels the breakdown as complete when every record is loaded', async () => {
    mockListConsentRecords.mockResolvedValue({ ...fx.listConsentRecords_200, totalRecords: 2, nextCursor: null });
    r();
    const region = await screen.findByRole('region', { name: 'Consent records' });
    await waitFor(() => expect(within(region).getByText('By status:')).toBeInTheDocument());
  });

  it('shows open grievances (submitted + in review) with the nearest response deadline', async () => {
    r();
    const region = await screen.findByRole('region', { name: 'Open grievances' });
    await waitFor(() => expect(within(region).getByText('2')).toBeInTheDocument());
    expect(mockListGrievances).toHaveBeenCalledWith({ status: 'submitted', limit: 200 });
    expect(mockListGrievances).toHaveBeenCalledWith({ status: 'in_review', limit: 200 });
    expect(within(region).getByText(`Next response due ${formatDate('2999-01-02T12:00:00.000Z')}`)).toBeInTheDocument();
    expect(within(region).getByText('1 submitted, 1 in review')).toBeInTheDocument();
  });

  it('counts overdue open grievances', async () => {
    mockListGrievances.mockImplementation((p: { status?: string }) => p.status === 'submitted'
      ? Promise.resolve({ grievances: [{ ...g, expectedResolutionBy: '2020-01-01T00:00:00.000Z' }], nextCursor: null })
      : Promise.resolve({ grievances: [], nextCursor: null }));
    r();
    const region = await screen.findByRole('region', { name: 'Open grievances' });
    await waitFor(() => expect(within(region).getByText('1 overdue')).toBeInTheDocument());
  });

  it('shows consent notice versions and labels a partial first page', async () => {
    mockListConsentNotices.mockResolvedValue({ ...fx.listConsentNotices_200, nextCursor: 'more' });
    r();
    const region = await screen.findByRole('region', { name: 'Consent notice versions' });
    await waitFor(() => expect(within(region).getByText('1+')).toBeInTheDocument());
    expect(within(region).getByText(/first page/)).toBeInTheDocument();
    expect(mockListConsentNotices).toHaveBeenCalledWith({ limit: 200 });
  });

  it('shows an unavailable indicator when a DPDP endpoint fails, without breaking the page', async () => {
    mockListConsentRecords.mockRejectedValue(new Error('fail'));
    r();
    const region = await screen.findByRole('region', { name: 'Consent records' });
    await waitFor(() => expect(within(region).getByText('Unavailable')).toBeInTheDocument());
    expect(screen.getByText('Grants Export')).toBeInTheDocument();
  });

  it('shows no action items when policies, audit and failure rate are fine', async () => {
    r();
    await waitFor(() => expect(screen.getByText('No open action items')).toBeInTheDocument());
  });

  it('shows action items when policies missing', async () => {
    mockGetSummary.mockResolvedValue({ ...summary, policies: { total: 0 } });
    r();
    await waitFor(() => expect(screen.getByText(/Create authorization policies/)).toBeInTheDocument());
  });

  it('has export buttons', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Grants Export')).toBeInTheDocument());
    expect(screen.getByText('Audit Log Export')).toBeInTheDocument();
    expect(screen.getByText('SOC 2 Evidence Pack')).toBeInTheDocument();
    expect(screen.getByText('GDPR Evidence Pack')).toBeInTheDocument();
  });

  it('uses accurate legal references and no compliance claims in copy', async () => {
    r();
    await screen.findByText('Grants Export');
    expect(screen.getByText(/under DPDP s\.13/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/13\(6\)/);
    expect(document.body.textContent).not.toMatch(/for [^.]*compliance/i);
  });

  it('downloads grants export', async () => {
    mockExportGrants.mockResolvedValueOnce({ generatedAt: '2026-01-01', total: 1, grants: [] });
    const user = userEvent.setup();
    r();
    await waitFor(() => expect(screen.getByText('Grants Export')).toBeInTheDocument());
    const downloadBtns = screen.getAllByRole('button', { name: 'Download' });
    await user.click(downloadBtns[0]!);
    await waitFor(() => expect(mockExportGrants).toHaveBeenCalled());
    expect(mockShow).toHaveBeenCalledWith('Export downloaded', 'success');
  });

  it('shows error toast on export failure', async () => {
    mockExportGrants.mockRejectedValueOnce(new Error('fail'));
    const user = userEvent.setup();
    r();
    await waitFor(() => expect(screen.getByText('Grants Export')).toBeInTheDocument());
    const downloadBtns = screen.getAllByRole('button', { name: 'Download' });
    await user.click(downloadBtns[0]!);
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Export failed', 'error'));
  });

  it('shows error toast on summary load failure', async () => {
    mockGetSummary.mockRejectedValue(new Error('fail'));
    r();
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Failed to load compliance data', 'error'));
  });

  it('has DPDP section links', async () => {
    r();
    await waitFor(() => expect(screen.getByText('DPDP Consent Records')).toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Grievances' })).toBeInTheDocument();
  });
});
