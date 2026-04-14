import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { WebhookDeliveries } from '../webhooks/WebhookDeliveries';

const mockListDeliveries = vi.fn();
const mockShow = vi.fn();

vi.mock('../../api/webhooks', () => ({
  listDeliveries: (...a: unknown[]) => mockListDeliveries(...a),
}));
vi.mock('../../store/toast', () => ({ useToast: () => ({ show: mockShow }) }));

const deliveries = [
  { id: 'del1', eventType: 'grant.created', status: 'delivered', attempts: 1, maxAttempts: 3, lastError: null, createdAt: '2026-01-01T00:00:00Z' },
  { id: 'del2', eventType: 'grant.revoked', status: 'failed', attempts: 3, maxAttempts: 3, lastError: 'Connection refused', createdAt: '2026-01-02T00:00:00Z' },
  { id: 'del3', eventType: 'token.issued', status: 'pending', attempts: 1, maxAttempts: 3, lastError: null, createdAt: '2026-01-03T00:00:00Z' },
];

function r() {
  return render(
    <MemoryRouter initialEntries={['/dashboard/webhooks/wh1/deliveries']}>
      <Routes><Route path="/dashboard/webhooks/:id/deliveries" element={<WebhookDeliveries />} /></Routes>
    </MemoryRouter>,
  );
}

describe('WebhookDeliveries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListDeliveries.mockResolvedValue({ deliveries, total: 3 });
  });

  it('renders deliveries table', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Deliveries')).toBeInTheDocument());
  });

  it('shows delivery status badges', async () => {
    r();
    // 'delivered' appears as both a filter button and row badge — both are expected.
    await waitFor(() => expect(screen.getAllByText('delivered').length).toBeGreaterThan(0));
    expect(screen.getAllByText('failed').length).toBeGreaterThan(0);
    expect(screen.getAllByText('pending').length).toBeGreaterThan(0);
  });

  it('shows event types', async () => {
    r();
    await waitFor(() => expect(screen.getByText('grant.created')).toBeInTheDocument());
    expect(screen.getByText('grant.revoked')).toBeInTheDocument();
    expect(screen.getByText('token.issued')).toBeInTheDocument();
  });

  it('shows error messages for failed deliveries', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Connection refused')).toBeInTheDocument());
  });

  it('shows attempt counts', async () => {
    r();
    // Two deliveries both show "1/3" so the row renders duplicates by design.
    await waitFor(() => expect(screen.getAllByText('1/3').length).toBeGreaterThanOrEqual(1));
    expect(screen.getByText('3/3')).toBeInTheDocument();
  });

  it('shows empty state when no deliveries', async () => {
    mockListDeliveries.mockResolvedValue({ deliveries: [], total: 0 });
    r();
    await waitFor(() => expect(screen.getByText('No deliveries')).toBeInTheDocument());
  });

  it('shows error toast on load failure', async () => {
    mockListDeliveries.mockRejectedValue(new Error('fail'));
    r();
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Failed to load deliveries', 'error'));
  });

  it('has status filter buttons', async () => {
    r();
    await waitFor(() => expect(screen.getByRole('button', { name: 'All' })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'delivered' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'pending' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'failed' })).toBeInTheDocument();
  });

  it('has back link to webhooks', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Webhooks')).toBeInTheDocument());
  });
});
