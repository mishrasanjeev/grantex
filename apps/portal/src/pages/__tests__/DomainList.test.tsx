import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { DomainList } from '../domains/DomainList';

const mockApiGet = vi.fn();
const mockShow = vi.fn();

vi.mock('../../api/client', () => ({
  api: { get: (...a: unknown[]) => mockApiGet(...a) },
}));
vi.mock('../../store/toast', () => ({ useToast: () => ({ show: mockShow }) }));

const domains = [
  { id: 'd1', domain: 'example.com', verified: true, verificationToken: 'tok1', createdAt: '2026-01-01T00:00:00Z' },
  { id: 'd2', domain: 'pending.com', verified: false, verificationToken: 'tok2', createdAt: '2026-01-02T00:00:00Z' },
];

function r() { return render(<DomainList />); }

describe('DomainList', () => {
  beforeEach(() => { vi.clearAllMocks(); mockApiGet.mockResolvedValue({ domains }); });

  it('renders domain table', async () => {
    r();
    await waitFor(() => expect(screen.getByText('example.com')).toBeInTheDocument());
    expect(screen.getByText('pending.com')).toBeInTheDocument();
  });

  it('shows Verified badge for verified domains', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Verified')).toBeInTheDocument());
  });

  it('shows Pending badge for unverified domains', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Pending')).toBeInTheDocument());
  });

  it('shows empty state when no domains', async () => {
    mockApiGet.mockResolvedValue({ domains: [] });
    r();
    await waitFor(() => expect(screen.getByText('No custom domains')).toBeInTheDocument());
  });

  it('shows error toast on load failure', async () => {
    mockApiGet.mockRejectedValue(new Error('fail'));
    r();
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Failed to load domains', 'error'));
  });

  it('displays page title', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Custom Domains')).toBeInTheDocument());
  });
});
