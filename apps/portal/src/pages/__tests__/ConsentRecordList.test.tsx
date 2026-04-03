import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ConsentRecordList } from '../dpdp/ConsentRecordList';

const mockGetDataPrincipalRecords = vi.fn();
const mockWithdrawConsent = vi.fn();
const mockShow = vi.fn();
const mockNavigate = vi.fn();

vi.mock('../../api/dpdp', () => ({
  getDataPrincipalRecords: (...a: unknown[]) => mockGetDataPrincipalRecords(...a),
  withdrawConsent: (...a: unknown[]) => mockWithdrawConsent(...a),
}));
vi.mock('../../store/toast', () => ({ useToast: () => ({ show: mockShow }) }));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

const records = [
  {
    recordId: 'crec-1', dataPrincipalId: 'user-1', grantId: 'g-1',
    dataFiduciaryName: 'Acme', status: 'active',
    purposes: [{ code: 'analytics' }], scopes: ['read'],
    consentGivenAt: '2026-01-01T00:00:00Z', processingExpiresAt: '2027-01-01T00:00:00Z',
    retentionUntil: '2028-01-01T00:00:00Z', accessCount: 15,
    lastAccessedAt: null, withdrawnAt: null, withdrawnReason: null,
    consentProof: {},
  },
  {
    recordId: 'crec-2', dataPrincipalId: 'user-1', grantId: 'g-2',
    dataFiduciaryName: 'Beta', status: 'withdrawn',
    purposes: [{ code: 'marketing' }], scopes: ['write'],
    consentGivenAt: '2026-02-01T00:00:00Z', processingExpiresAt: '2027-02-01T00:00:00Z',
    retentionUntil: '2028-02-01T00:00:00Z', accessCount: 3,
    lastAccessedAt: null, withdrawnAt: '2026-03-01T00:00:00Z', withdrawnReason: 'User request',
    consentProof: {},
  },
];

function r() { return render(<MemoryRouter><ConsentRecordList /></MemoryRouter>); }

describe('ConsentRecordList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDataPrincipalRecords.mockResolvedValue({ records });
  });

  it('renders heading', () => {
    r();
    expect(screen.getByText('Consent Records')).toBeInTheDocument();
  });

  it('shows search prompt before search', () => {
    r();
    expect(screen.getByText('Search for consent records')).toBeInTheDocument();
  });

  it('shows results after search', async () => {
    const user = userEvent.setup();
    r();
    await user.type(screen.getByPlaceholderText('e.g. user_123'), 'user-1');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(screen.getByText('active')).toBeInTheDocument());
    expect(screen.getByText('withdrawn')).toBeInTheDocument();
  });

  it('shows record count after search', async () => {
    const user = userEvent.setup();
    r();
    await user.type(screen.getByPlaceholderText('e.g. user_123'), 'user-1');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(screen.getByText(/2 records/)).toBeInTheDocument());
  });

  it('shows purposes in table', async () => {
    const user = userEvent.setup();
    r();
    await user.type(screen.getByPlaceholderText('e.g. user_123'), 'user-1');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(screen.getByText('analytics')).toBeInTheDocument());
    expect(screen.getByText('marketing')).toBeInTheDocument();
  });

  it('shows Withdraw button only for active records', async () => {
    const user = userEvent.setup();
    r();
    await user.type(screen.getByPlaceholderText('e.g. user_123'), 'user-1');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(screen.getByText('active')).toBeInTheDocument());
    const withdrawButtons = screen.getAllByText('Withdraw');
    expect(withdrawButtons.length).toBe(1);
  });

  it('shows empty state when no records found', async () => {
    mockGetDataPrincipalRecords.mockResolvedValue({ records: [] });
    const user = userEvent.setup();
    r();
    await user.type(screen.getByPlaceholderText('e.g. user_123'), 'user-1');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(screen.getByText('No consent records')).toBeInTheDocument());
  });

  it('shows error toast on search failure', async () => {
    mockGetDataPrincipalRecords.mockRejectedValue(new Error('fail'));
    const user = userEvent.setup();
    r();
    await user.type(screen.getByPlaceholderText('e.g. user_123'), 'user-1');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Failed to load consent records', 'error'));
  });

  it('opens withdraw confirmation dialog', async () => {
    const user = userEvent.setup();
    r();
    await user.type(screen.getByPlaceholderText('e.g. user_123'), 'user-1');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(screen.getByText('Withdraw')).toBeInTheDocument());
    await user.click(screen.getByText('Withdraw'));
    await waitFor(() => expect(screen.getByText('Withdraw Consent')).toBeInTheDocument());
  });

  it('disables Search button when input is empty', () => {
    r();
    expect(screen.getByRole('button', { name: 'Search' })).toBeDisabled();
  });
});
