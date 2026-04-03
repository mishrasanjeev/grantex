import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ComplianceDashboard } from '../compliance/ComplianceDashboard';

const mockGetSummary = vi.fn();
const mockExportGrants = vi.fn();
const mockExportAudit = vi.fn();
const mockExportEvidence = vi.fn();
const mockShow = vi.fn();

vi.mock('../../api/compliance', () => ({
  getComplianceSummary: () => mockGetSummary(),
  exportGrants: () => mockExportGrants(),
  exportAudit: () => mockExportAudit(),
  exportEvidencePack: (...a: unknown[]) => mockExportEvidence(...a),
}));
vi.mock('../../store/toast', () => ({ useToast: () => ({ show: mockShow }) }));

// Mock URL.createObjectURL
globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock');
globalThis.URL.revokeObjectURL = vi.fn();

const summary = {
  generatedAt: '2026-01-01T00:00:00Z', plan: 'pro',
  agents: { total: 5, active: 4, suspended: 1, revoked: 0 },
  grants: { total: 10, active: 7, revoked: 2, expired: 1 },
  auditEntries: { total: 100, success: 90, failure: 5, blocked: 5 },
  policies: { total: 3 },
};

function r() { return render(<MemoryRouter><ComplianceDashboard /></MemoryRouter>); }

describe('ComplianceDashboard', () => {
  beforeEach(() => { vi.clearAllMocks(); mockGetSummary.mockResolvedValue(summary); });

  it('renders compliance scores', async () => {
    r();
    await waitFor(() => expect(screen.getByText('DPDP 2023')).toBeInTheDocument());
    expect(screen.getByText('EU AI Act')).toBeInTheDocument();
    expect(screen.getByText('OWASP Agentic Top 10')).toBeInTheDocument();
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

  it('shows no action items when compliant', async () => {
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
    expect(screen.getByText('Grievances')).toBeInTheDocument();
  });
});
