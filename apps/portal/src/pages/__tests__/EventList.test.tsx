import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EventList } from '../events/EventList';

const mockSubscribeToEvents = vi.fn();
const mockShow = vi.fn();

vi.mock('../../api/events', () => ({
  subscribeToEvents: (options: unknown) => mockSubscribeToEvents(options),
}));
vi.mock('../../store/toast', () => ({ useToast: () => ({ show: mockShow }) }));

const events = [
  { id: 'ev1', type: 'grant.created', developerId: 'd1', payload: { grantId: 'g1' }, createdAt: new Date().toISOString() },
  { id: 'ev2', type: 'token.issued', developerId: 'd1', payload: { tokenId: 't1' }, createdAt: new Date().toISOString() },
  { id: 'ev3', type: 'grant.revoked', developerId: 'd1', payload: { grantId: 'g2' }, createdAt: new Date().toISOString() },
];

function r() { return render(<EventList />); }

describe('EventList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockSubscribeToEvents.mockImplementation(({ onOpen, onEvent }) => {
      onOpen();
      events.forEach(onEvent);
      return Promise.resolve();
    });
  });

  afterEach(() => { vi.useRealTimers(); });

  it('renders events table', async () => {
    r();
    await waitFor(() => expect(screen.getByText('grant.created')).toBeInTheDocument());
    expect(screen.getByText('token.issued')).toBeInTheDocument();
    expect(screen.getByText('grant.revoked')).toBeInTheDocument();
  });

  it('shows Live indicator when not paused', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Live')).toBeInTheDocument());
  });

  it('toggles pause/resume', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    r();
    await waitFor(() => expect(screen.getByText('Pause')).toBeInTheDocument());
    await user.click(screen.getByText('Pause'));
    expect(screen.getByText('Resume')).toBeInTheDocument();
    expect(screen.queryByText('Live')).not.toBeInTheDocument();
  });

  it('shows empty state when no events', async () => {
    mockSubscribeToEvents.mockImplementation(({ onOpen }) => {
      onOpen();
      return Promise.resolve();
    });
    r();
    await waitFor(() => expect(screen.getByText('No events yet')).toBeInTheDocument());
  });

  it('shows error toast on load failure', async () => {
    mockSubscribeToEvents.mockRejectedValue(new Error('fail'));
    r();
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Failed to connect to event stream', 'error'));
  });

  it('displays event payload', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Events')).toBeInTheDocument());
    // Payload is JSON-stringified and truncated
    expect(screen.getAllByText(/grantId/).length).toBeGreaterThanOrEqual(1);
  });
});
