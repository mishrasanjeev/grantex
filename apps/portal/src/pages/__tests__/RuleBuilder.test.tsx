import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { RuleBuilder } from '../anomalies/RuleBuilder';

const mockListRules = vi.fn();
const mockCreateRule = vi.fn();
const mockToggleRule = vi.fn();
const mockDeleteRule = vi.fn();
const mockListChannels = vi.fn();
const mockShow = vi.fn();

vi.mock('../../api/anomalies', () => ({
  listRules: () => mockListRules(),
  createRule: (...a: unknown[]) => mockCreateRule(...a),
  toggleRule: (...a: unknown[]) => mockToggleRule(...a),
  deleteRule: (...a: unknown[]) => mockDeleteRule(...a),
  listChannels: () => mockListChannels(),
}));
vi.mock('../../store/toast', () => ({ useToast: () => ({ show: mockShow }) }));

const rules = [
  { ruleId: 'builtin-1', name: 'Built-in Rule', description: 'Default', severity: 'high', enabled: true, builtin: true, condition: {} },
  { ruleId: 'custom-1', name: 'Custom Rule', description: 'User-defined', severity: 'medium', enabled: true, builtin: false, condition: {} },
];

function r() { return render(<MemoryRouter><RuleBuilder /></MemoryRouter>); }

describe('RuleBuilder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListRules.mockResolvedValue(rules);
    mockListChannels.mockResolvedValue([]);
  });

  it('renders rules list', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Built-in Rule')).toBeInTheDocument());
    expect(screen.getByText('Custom Rule')).toBeInTheDocument();
  });

  it('shows empty state when no rules', async () => {
    mockListRules.mockResolvedValue([]);
    r();
    await waitFor(() => expect(screen.getByText('No rules configured')).toBeInTheDocument());
  });

  it('shows error toast on load failure', async () => {
    mockListRules.mockRejectedValue(new Error('fail'));
    mockListChannels.mockRejectedValue(new Error('fail'));
    r();
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Failed to load rules', 'error'));
  });

  it('has Create Rule button', async () => {
    r();
    await waitFor(() => expect(screen.getByText('+ Create Rule')).toBeInTheDocument());
  });

  it('separates built-in and custom rules', async () => {
    r();
    await waitFor(() => expect(screen.getByText(/Built-in Rules/)).toBeInTheDocument());
    expect(screen.getByText(/Custom Rules/)).toBeInTheDocument();
  });

  it('shows delete button only for custom rules', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Custom Rule')).toBeInTheDocument());
    const deleteButtons = screen.getAllByRole('button', { name: 'Delete' });
    expect(deleteButtons.length).toBe(1);
  });

  it('toggles rule enabled state', async () => {
    mockToggleRule.mockResolvedValueOnce({ ...rules[1], enabled: false });
    const user = userEvent.setup();
    r();
    await waitFor(() => expect(screen.getByText('Custom Rule')).toBeInTheDocument());
    const toggleButtons = screen.getAllByTitle(/rule/);
    await user.click(toggleButtons[0]!);
    await waitFor(() => expect(mockToggleRule).toHaveBeenCalled());
  });

  it('displays severity badges', async () => {
    r();
    await waitFor(() => expect(screen.getByText('high')).toBeInTheDocument());
    expect(screen.getByText('medium')).toBeInTheDocument();
  });

  it('has header with Anomaly Rules title', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Anomaly Rules')).toBeInTheDocument());
  });
});
