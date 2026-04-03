import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { WebhookList } from '../webhooks/WebhookList';

const mockListWebhooks = vi.fn();
const mockCreateWebhook = vi.fn();
const mockDeleteWebhook = vi.fn();
const mockShow = vi.fn();

vi.mock('../../api/webhooks', () => ({
  listWebhooks: () => mockListWebhooks(),
  createWebhook: (...a: unknown[]) => mockCreateWebhook(...a),
  deleteWebhook: (...a: unknown[]) => mockDeleteWebhook(...a),
}));
vi.mock('../../store/toast', () => ({ useToast: () => ({ show: mockShow }) }));

const webhooks = [
  { id: 'w1', url: 'https://example.com/hook', events: ['grant.created', 'grant.revoked'], createdAt: '2026-01-01T00:00:00Z' },
];

function r() { return render(<MemoryRouter><WebhookList /></MemoryRouter>); }

describe('WebhookList', () => {
  beforeEach(() => { vi.clearAllMocks(); mockListWebhooks.mockResolvedValue(webhooks); });

  it('renders webhook table', async () => {
    r();
    await waitFor(() => expect(screen.getByText('https://example.com/hook')).toBeInTheDocument());
  });

  it('shows empty state when no webhooks', async () => {
    mockListWebhooks.mockResolvedValue([]);
    r();
    await waitFor(() => expect(screen.getByText('No webhooks yet')).toBeInTheDocument());
  });

  it('has Add Endpoint button', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Webhooks')).toBeInTheDocument());
    expect(screen.getAllByText('Add Endpoint').length).toBeGreaterThanOrEqual(1);
  });

  it('opens create modal on Add click', async () => {
    const user = userEvent.setup();
    r();
    await waitFor(() => expect(screen.getByText('Webhooks')).toBeInTheDocument());
    await user.click(screen.getAllByText('Add Endpoint')[0]!);
    await waitFor(() => expect(screen.getByText('Add Webhook Endpoint')).toBeInTheDocument());
    expect(screen.getByText('Endpoint URL')).toBeInTheDocument();
    expect(screen.getByText('grant.created')).toBeInTheDocument();
  });

  it('creates webhook and shows secret', async () => {
    mockCreateWebhook.mockResolvedValueOnce({ id: 'w2', url: 'https://new.com/hook', events: ['grant.created'], secret: 'sec_123', createdAt: '2026-01-01T00:00:00Z' });
    const user = userEvent.setup();
    r();
    await waitFor(() => expect(screen.getByText('Webhooks')).toBeInTheDocument());
    await user.click(screen.getAllByText('Add Endpoint')[0]!);
    await waitFor(() => expect(screen.getByText('Add Webhook Endpoint')).toBeInTheDocument());
    await user.type(screen.getByPlaceholderText('https://example.com/webhook'), 'https://new.com/hook');
    await user.click(screen.getByText('grant.created'));
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(screen.getByText('Webhook Created')).toBeInTheDocument());
    expect(screen.getByText('sec_123')).toBeInTheDocument();
  });

  it('shows error toast on load failure', async () => {
    mockListWebhooks.mockRejectedValue(new Error('fail'));
    r();
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Failed to load webhooks', 'error'));
  });

  it('deletes webhook on confirm', async () => {
    mockDeleteWebhook.mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    r();
    await waitFor(() => expect(screen.getByText('https://example.com/hook')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.getByText('Delete Webhook')).toBeInTheDocument());
    const modal = screen.getByText('Delete Webhook').closest('div[class*="fixed"]')!;
    const btns = within(modal as HTMLElement).getAllByRole('button', { name: 'Delete' });
    await user.click(btns[btns.length - 1]!);
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Webhook deleted', 'success'));
  });

  it('displays events for each webhook', async () => {
    r();
    await waitFor(() => expect(screen.getByText(/grant.created, grant.revoked/)).toBeInTheDocument());
  });
});
