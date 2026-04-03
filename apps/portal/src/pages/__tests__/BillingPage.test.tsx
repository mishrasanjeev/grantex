import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { BillingPage } from '../billing/BillingPage';

const mockGetSubscription = vi.fn();
const mockCreateCheckout = vi.fn();
const mockGetPortalUrl = vi.fn();
const mockShow = vi.fn();

vi.mock('../../api/billing', () => ({
  getSubscription: () => mockGetSubscription(),
  createCheckout: (...a: unknown[]) => mockCreateCheckout(...a),
  getPortalUrl: () => mockGetPortalUrl(),
}));
vi.mock('../../store/toast', () => ({ useToast: () => ({ show: mockShow }) }));

const subscription = {
  plan: 'pro',
  status: 'active',
  currentPeriodEnd: '2026-05-01T00:00:00Z',
};

function r(entries = ['/billing']) {
  return render(
    <MemoryRouter initialEntries={entries}>
      <BillingPage />
    </MemoryRouter>,
  );
}

describe('BillingPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSubscription.mockResolvedValue(subscription);
  });

  it('renders billing page with current plan', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Billing')).toBeInTheDocument());
    expect(screen.getByText('pro')).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
  });

  it('displays plan cards', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Free')).toBeInTheDocument());
    expect(screen.getByText('Pro')).toBeInTheDocument();
    expect(screen.getByText('Enterprise')).toBeInTheDocument();
  });

  it('shows plan prices', async () => {
    r();
    await waitFor(() => expect(screen.getByText('$0')).toBeInTheDocument());
    expect(screen.getByText('$49/mo')).toBeInTheDocument();
    expect(screen.getByText('$249/mo')).toBeInTheDocument();
  });

  it('shows Current badge on active plan', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Current')).toBeInTheDocument());
  });

  it('shows Manage Subscription button for paid plans', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Manage Subscription')).toBeInTheDocument());
  });

  it('hides Manage Subscription for free plan', async () => {
    mockGetSubscription.mockResolvedValue({ plan: 'free', status: 'active', currentPeriodEnd: null });
    r();
    await waitFor(() => expect(screen.getByText('Billing')).toBeInTheDocument());
    expect(screen.queryByText('Manage Subscription')).not.toBeInTheDocument();
  });

  it('shows Upgrade button for non-current plans', async () => {
    mockGetSubscription.mockResolvedValue({ plan: 'free', status: 'active', currentPeriodEnd: null });
    r();
    await waitFor(() => expect(screen.getAllByText('Upgrade').length).toBeGreaterThanOrEqual(1));
  });

  it('calls createCheckout on Upgrade click', async () => {
    mockGetSubscription.mockResolvedValue({ plan: 'free', status: 'active', currentPeriodEnd: null });
    mockCreateCheckout.mockResolvedValueOnce({ checkoutUrl: 'https://checkout.example.com' });
    const user = userEvent.setup();
    r();
    await waitFor(() => expect(screen.getAllByText('Upgrade').length).toBeGreaterThanOrEqual(1));
    await user.click(screen.getAllByText('Upgrade')[0]!);
    await waitFor(() => expect(mockCreateCheckout).toHaveBeenCalled());
  });

  it('shows error toast on checkout failure', async () => {
    mockGetSubscription.mockResolvedValue({ plan: 'free', status: 'active', currentPeriodEnd: null });
    mockCreateCheckout.mockRejectedValueOnce(new Error('fail'));
    const user = userEvent.setup();
    r();
    await waitFor(() => expect(screen.getAllByText('Upgrade').length).toBeGreaterThanOrEqual(1));
    await user.click(screen.getAllByText('Upgrade')[0]!);
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Failed to start checkout', 'error'));
  });

  it('shows error toast on load failure', async () => {
    mockGetSubscription.mockRejectedValue(new Error('fail'));
    r();
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Failed to load subscription', 'error'));
  });

  it('displays plan features', async () => {
    r();
    await waitFor(() => expect(screen.getByText('500 agents')).toBeInTheDocument());
    expect(screen.getByText('Unlimited agents')).toBeInTheDocument();
  });

  it('shows success toast on checkout return', async () => {
    r(['/billing?success=true']);
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Subscription activated!', 'success'));
  });
});
