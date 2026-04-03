import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ExportPage } from '../dpdp/ExportPage';

const mockCreateExport = vi.fn();
const mockShow = vi.fn();

vi.mock('../../api/dpdp', () => ({
  createExport: (...a: unknown[]) => mockCreateExport(...a),
}));
vi.mock('../../store/toast', () => ({ useToast: () => ({ show: mockShow }) }));

function r() { return render(<MemoryRouter><ExportPage /></MemoryRouter>); }

describe('ExportPage', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('renders heading', () => {
    r();
    expect(screen.getByText('Compliance Exports')).toBeInTheDocument();
  });

  it('shows Generate Export form', () => {
    r();
    expect(screen.getByText('Generate Export')).toBeInTheDocument();
  });

  it('shows export type options', () => {
    r();
    expect(screen.getByText('DPDP Audit')).toBeInTheDocument();
    expect(screen.getByText('GDPR Article 15')).toBeInTheDocument();
    expect(screen.getByText('EU AI Act Conformance')).toBeInTheDocument();
  });

  it('shows date range inputs', () => {
    r();
    expect(screen.getByText('Date From')).toBeInTheDocument();
    expect(screen.getByText('Date To')).toBeInTheDocument();
  });

  it('shows format selector', () => {
    r();
    expect(screen.getByText('Format')).toBeInTheDocument();
  });

  it('shows checkboxes for includes', () => {
    r();
    expect(screen.getByText('Include Consent Records')).toBeInTheDocument();
    expect(screen.getByText('Include Action Log')).toBeInTheDocument();
  });

  it('has Generate Export button', () => {
    r();
    expect(screen.getByRole('button', { name: 'Generate Export' })).toBeInTheDocument();
  });

  it('generates export successfully', async () => {
    mockCreateExport.mockResolvedValueOnce({
      exportId: 'exp-1', type: 'dpdp-audit', format: 'json',
      recordCount: 42, createdAt: '2026-04-01T00:00:00Z',
      data: { records: [] },
    });
    const user = userEvent.setup();
    r();
    await user.click(screen.getByRole('button', { name: 'Generate Export' }));
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Export generated: 42 records', 'success'));
  });

  it('shows error toast on export failure', async () => {
    mockCreateExport.mockRejectedValueOnce(new Error('fail'));
    const user = userEvent.setup();
    r();
    await user.click(screen.getByRole('button', { name: 'Generate Export' }));
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Export failed', 'error'));
  });

  it('shows recent exports section', () => {
    r();
    expect(screen.getByText('Recent Exports')).toBeInTheDocument();
    expect(screen.getByText('No exports generated yet in this session')).toBeInTheDocument();
  });

  it('adds completed export to recent list', async () => {
    mockCreateExport.mockResolvedValueOnce({
      exportId: 'exp-1', type: 'dpdp-audit', format: 'json',
      recordCount: 10, createdAt: '2026-04-01T00:00:00Z',
      data: { records: [] },
    });
    const user = userEvent.setup();
    r();
    await user.click(screen.getByRole('button', { name: 'Generate Export' }));
    await waitFor(() => expect(screen.getByText('10 records')).toBeInTheDocument());
    expect(screen.getByText('complete')).toBeInTheDocument();
    expect(screen.getByText('Download')).toBeInTheDocument();
  });

  it('has optional Data Principal ID filter', () => {
    r();
    expect(screen.getByPlaceholderText('Filter by principal')).toBeInTheDocument();
  });
});
