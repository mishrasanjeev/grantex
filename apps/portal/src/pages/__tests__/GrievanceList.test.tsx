import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { GrievanceList } from '../dpdp/GrievanceList';

const mockFileGrievance = vi.fn();
const mockGetGrievance = vi.fn();
const mockShow = vi.fn();

vi.mock('../../api/dpdp', () => ({
  fileGrievance: (...a: unknown[]) => mockFileGrievance(...a),
  getGrievance: (...a: unknown[]) => mockGetGrievance(...a),
}));
vi.mock('../../store/toast', () => ({ useToast: () => ({ show: mockShow }) }));

function r() { return render(<MemoryRouter><GrievanceList /></MemoryRouter>); }

describe('GrievanceList', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('renders heading', () => {
    r();
    expect(screen.getByText('Grievances')).toBeInTheDocument();
  });

  it('shows empty state initially', () => {
    r();
    expect(screen.getByText('No grievances')).toBeInTheDocument();
  });

  it('has File Grievance button', () => {
    r();
    // Header toggle + empty-state CTA both render "File Grievance" — both expected.
    expect(screen.getAllByRole('button', { name: 'File Grievance' }).length).toBeGreaterThan(0);
  });

  it('opens file form on button click', async () => {
    const user = userEvent.setup();
    r();
    await user.click(screen.getAllByRole('button', { name: 'File Grievance' })[0]!);
    await waitFor(() => expect(screen.getByText('File New Grievance')).toBeInTheDocument());
  });

  it('shows grievance form fields', async () => {
    const user = userEvent.setup();
    r();
    await user.click(screen.getAllByRole('button', { name: 'File Grievance' })[0]!);
    await waitFor(() => expect(screen.getByText('Data Principal ID *')).toBeInTheDocument());
    expect(screen.getByText('Type *')).toBeInTheDocument();
    expect(screen.getByText('Description *')).toBeInTheDocument();
  });

  it('files grievance successfully', async () => {
    mockFileGrievance.mockResolvedValueOnce({
      grievanceId: 'grv-1', type: 'data-erasure',
      referenceNumber: 'REF-001', expectedResolutionBy: '2026-05-01T00:00:00Z',
      createdAt: '2026-04-01T00:00:00Z',
    });
    const user = userEvent.setup();
    r();
    await user.click(screen.getAllByRole('button', { name: 'File Grievance' })[0]!);
    await waitFor(() => expect(screen.getByText('File New Grievance')).toBeInTheDocument());
    await user.type(screen.getByPlaceholderText('e.g. user_123'), 'user-1');
    await user.type(screen.getByPlaceholderText('Describe the grievance...'), 'Request data erasure');
    const submit = screen.getAllByRole('button', { name: 'File Grievance' }).find((b) => (b as HTMLButtonElement).type === 'submit')!;
    await user.click(submit);
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Grievance filed: REF-001', 'success'));
  });

  it('shows error toast on file failure', async () => {
    mockFileGrievance.mockRejectedValueOnce(new Error('fail'));
    const user = userEvent.setup();
    r();
    await user.click(screen.getAllByRole('button', { name: 'File Grievance' })[0]!);
    await waitFor(() => expect(screen.getByText('File New Grievance')).toBeInTheDocument());
    await user.type(screen.getByPlaceholderText('e.g. user_123'), 'user-1');
    await user.type(screen.getByPlaceholderText('Describe the grievance...'), 'Test');
    const submit = screen.getAllByRole('button', { name: 'File Grievance' }).find((b) => (b as HTMLButtonElement).type === 'submit')!;
    await user.click(submit);
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Failed to file grievance', 'error'));
  });

  it('has lookup field', () => {
    r();
    expect(screen.getByPlaceholderText('e.g. grv_01ABCDEF...')).toBeInTheDocument();
  });

  it('looks up grievance by ID', async () => {
    mockGetGrievance.mockResolvedValueOnce({
      grievanceId: 'grv-1', dataPrincipalId: 'user-1', recordId: null,
      type: 'data-erasure', description: 'Test', evidence: {},
      status: 'submitted', referenceNumber: 'REF-001',
      expectedResolutionBy: '2026-05-01T00:00:00Z',
      resolvedAt: null, resolution: null, createdAt: '2026-04-01T00:00:00Z',
    });
    const user = userEvent.setup();
    r();
    await user.type(screen.getByPlaceholderText('e.g. grv_01ABCDEF...'), 'grv-1');
    await user.click(screen.getByRole('button', { name: 'Lookup' }));
    await waitFor(() => expect(screen.getByText('REF-001')).toBeInTheDocument());
  });

  it('shows error on lookup failure', async () => {
    mockGetGrievance.mockRejectedValueOnce(new Error('not found'));
    const user = userEvent.setup();
    r();
    await user.type(screen.getByPlaceholderText('e.g. grv_01ABCDEF...'), 'grv-999');
    await user.click(screen.getByRole('button', { name: 'Lookup' }));
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Grievance not found', 'error'));
  });

  it('disables Lookup button when input is empty', () => {
    r();
    expect(screen.getByRole('button', { name: 'Lookup' })).toBeDisabled();
  });

  it('shows grievance type dropdown', async () => {
    const user = userEvent.setup();
    r();
    await user.click(screen.getAllByRole('button', { name: 'File Grievance' })[0]!);
    await waitFor(() => expect(screen.getByText('Type *')).toBeInTheDocument());
  });
});
