import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ExportPage } from '../dpdp/ExportPage';
import { ApiError } from '../../api/client';
import * as fx from '../../api/__tests__/fixtures/dpdpServer';

const mockCreateExport = vi.fn();
const mockGetExport = vi.fn();
const mockShow = vi.fn();

vi.mock('../../api/dpdp', () => ({
  createExport: (...a: unknown[]) => mockCreateExport(...a),
  getExport: (...a: unknown[]) => mockGetExport(...a),
}));
vi.mock('../../store/toast', () => ({ useToast: () => ({ show: mockShow }) }));

// jsdom 30.1 throws from URL.createObjectURL for a Blob; the download is not under test here.
URL.createObjectURL = vi.fn(() => 'blob:mock');
URL.revokeObjectURL = vi.fn();

function r() { return render(<MemoryRouter><ExportPage /></MemoryRouter>); }

describe('ExportPage', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('renders heading', () => {
    r();
    expect(screen.getByText('Compliance Exports')).toBeInTheDocument();
  });

  it('shows Generate Export form', () => {
    r();
    expect(screen.getByRole('heading', { name: 'Generate Export' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate Export' })).toBeInTheDocument();
  });

  it('shows export type options without compliance claims', () => {
    r();
    expect(screen.getByText('DPDP Audit')).toBeInTheDocument();
    expect(screen.getByText('GDPR Article 15')).toBeInTheDocument();
    expect(screen.getByText('EU AI Act Conformance')).toBeInTheDocument();
    expect(screen.queryByText(/for .*compliance/i)).not.toBeInTheDocument();
    expect(screen.getAllByText(/to help evidence/).length).toBeGreaterThan(0);
  });

  it('shows date range inputs', () => {
    r();
    expect(screen.getByLabelText('Date From')).toBeInTheDocument();
    expect(screen.getByLabelText('Date To')).toBeInTheDocument();
  });

  it('does not offer CSV (the server only produces JSON)', () => {
    r();
    expect(screen.queryByRole('option', { name: 'CSV' })).not.toBeInTheDocument();
    expect(screen.queryByText(/csv/i)).not.toBeInTheDocument();
  });

  it('shows checkboxes for includes', () => {
    r();
    expect(screen.getByLabelText('Include Consent Records')).toBeChecked();
    expect(screen.getByLabelText('Include Action Log')).toBeChecked();
  });

  it('sends start-of-day dateFrom and end-of-day dateTo so the whole last day is included', async () => {
    mockCreateExport.mockResolvedValueOnce(fx.createExport_201);
    const user = userEvent.setup();
    r();
    fireEvent.change(screen.getByLabelText('Date From'), { target: { value: '2026-09-01' } });
    fireEvent.change(screen.getByLabelText('Date To'), { target: { value: '2026-09-30' } });
    await user.click(screen.getByRole('button', { name: 'Generate Export' }));
    await waitFor(() => expect(mockCreateExport).toHaveBeenCalledWith({
      type: 'dpdp-audit',
      dateFrom: '2026-09-01T00:00:00.000Z',
      dateTo: '2026-09-30T23:59:59.999Z',
      includeActionLog: true,
      includeConsentRecords: true,
    }));
  });

  it('default range ends at the end of today (UTC)', async () => {
    mockCreateExport.mockResolvedValueOnce(fx.createExport_201);
    const user = userEvent.setup();
    r();
    await user.click(screen.getByRole('button', { name: 'Generate Export' }));
    await waitFor(() => expect(mockCreateExport).toHaveBeenCalled());
    const req = mockCreateExport.mock.calls[0]![0] as { dateFrom: string; dateTo: string; format?: string };
    const today = new Date().toISOString().slice(0, 10);
    expect(req.dateTo).toBe(`${today}T23:59:59.999Z`);
    expect(req.dateFrom).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
    expect(req.format).toBeUndefined();
  });

  it('sends include flags as chosen and the optional principal filter', async () => {
    mockCreateExport.mockResolvedValueOnce(fx.createExport_201);
    const user = userEvent.setup();
    r();
    await user.click(screen.getByLabelText('Include Action Log'));
    await user.type(screen.getByPlaceholderText('Filter by principal'), 'user_123');
    await user.click(screen.getByRole('button', { name: 'Generate Export' }));
    await waitFor(() => expect(mockCreateExport).toHaveBeenCalledWith(expect.objectContaining({
      includeActionLog: false,
      includeConsentRecords: true,
      dataPrincipalId: 'user_123',
    })));
  });

  it('generates export successfully', async () => {
    mockCreateExport.mockResolvedValueOnce(fx.createExport_201);
    const user = userEvent.setup();
    r();
    await user.click(screen.getByRole('button', { name: 'Generate Export' }));
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Export generated: 3 records', 'success'));
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

  it('lists a new export without a hard-coded complete badge', async () => {
    mockCreateExport.mockResolvedValueOnce(fx.createExport_201);
    const user = userEvent.setup();
    r();
    await user.click(screen.getByRole('button', { name: 'Generate Export' }));
    expect(await screen.findByText('3 records')).toBeInTheDocument();
    expect(screen.queryByText('complete')).not.toBeInTheDocument();
    expect(screen.queryByText('truncated')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument();
  });

  it('flags a truncated export with the audit log limit', async () => {
    mockCreateExport.mockResolvedValueOnce({ ...fx.createExport_201, recordCount: 1001, truncated: true });
    const user = userEvent.setup();
    r();
    await user.click(screen.getByRole('button', { name: 'Generate Export' }));
    expect(await screen.findByText('truncated')).toBeInTheDocument();
    expect(screen.getByText(/audit log capped at 1000 entries/i)).toBeInTheDocument();
  });

  it('fetches an existing export by id', async () => {
    mockGetExport.mockResolvedValueOnce(fx.getExport_200);
    const user = userEvent.setup();
    r();
    await user.type(screen.getByPlaceholderText('e.g. exp_01ABCDEF...'), fx.getExport_200.exportId);
    await user.click(screen.getByRole('button', { name: 'Fetch' }));
    await waitFor(() => expect(mockGetExport).toHaveBeenCalledWith(fx.getExport_200.exportId));
    expect(await screen.findByText('1001 records')).toBeInTheDocument();
    expect(screen.getByText('truncated')).toBeInTheDocument();
  });

  it('explains a 410 GONE export', async () => {
    const e = fx.errors['410_GONE'];
    mockGetExport.mockRejectedValueOnce(new ApiError(410, e.code, e.message, e.requestId));
    const user = userEvent.setup();
    r();
    await user.type(screen.getByPlaceholderText('e.g. exp_01ABCDEF...'), 'exp_old');
    await user.click(screen.getByRole('button', { name: 'Fetch' }));
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith(
      'This export has expired and its data was purged. Generate a new export.', 'error'));
  });

  it('explains a 404 export', async () => {
    mockGetExport.mockRejectedValueOnce(new ApiError(404, 'NOT_FOUND', 'Export not found', 'req-1'));
    const user = userEvent.setup();
    r();
    await user.type(screen.getByPlaceholderText('e.g. exp_01ABCDEF...'), 'exp_nope');
    await user.click(screen.getByRole('button', { name: 'Fetch' }));
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Export not found', 'error'));
  });

  it('has optional Data Principal ID filter', () => {
    r();
    expect(screen.getByPlaceholderText('Filter by principal')).toBeInTheDocument();
  });
});
