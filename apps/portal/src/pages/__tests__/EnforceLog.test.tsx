import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EnforceLog } from '../enforce/EnforceLog';

function r() {
  return render(<EnforceLog />);
}

describe('EnforceLog', () => {
  it('renders heading "Enforce Audit Log"', () => {
    r();
    expect(screen.getByText('Enforce Audit Log')).toBeInTheDocument();
  });

  it('renders stats bar (total, allowed, denied, rate)', () => {
    r();
    expect(screen.getByText('Total Calls')).toBeInTheDocument();
    // "Allowed" and "Denied" appear in both filter buttons and stats cards
    expect(screen.getAllByText('Allowed').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('Denied').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Denial Rate')).toBeInTheDocument();
    // 25 demo entries total: 16 allowed, 9 denied, 36.0% denial rate
    expect(screen.getByText('25')).toBeInTheDocument();
    expect(screen.getByText('16')).toBeInTheDocument();
    expect(screen.getByText('9')).toBeInTheDocument();
    expect(screen.getByText('36.0%')).toBeInTheDocument();
  });

  it('renders table with mock data', () => {
    r();
    // Table headers
    expect(screen.getByText('Timestamp')).toBeInTheDocument();
    expect(screen.getByText('Agent')).toBeInTheDocument();
    expect(screen.getByText('Connector')).toBeInTheDocument();
    expect(screen.getByText('Tool')).toBeInTheDocument();
    expect(screen.getByText('Permission')).toBeInTheDocument();
    expect(screen.getByText('Result')).toBeInTheDocument();
    expect(screen.getByText('Reason')).toBeInTheDocument();
    // Check some specific demo data entries are rendered (some agents appear multiple times)
    expect(screen.getAllByText('agent:finance-bot').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('get_invoice')).toBeInTheDocument();
    expect(screen.getAllByText('ALLOWED').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('DENIED').length).toBeGreaterThanOrEqual(1);
  });

  it('"Denied Only" filter shows only denied rows', async () => {
    const user = userEvent.setup();
    r();
    // Click the "Denied" filter button
    await user.click(screen.getByRole('button', { name: 'Denied' }));
    // All visible result badges should be DENIED (9 denied entries)
    expect(screen.getAllByText('DENIED').length).toBe(9);
    expect(screen.queryByText('ALLOWED')).not.toBeInTheDocument();
    // Stats should update to show only denied entries
    expect(screen.getByText('Denial Rate')).toBeInTheDocument();
    expect(screen.getByText('100.0%')).toBeInTheDocument();
  });

  it('empty state when no data matches filter', async () => {
    const user = userEvent.setup();
    r();
    // Search for a non-existent agent
    const input = screen.getByPlaceholderText('Search agent...');
    await user.type(input, 'zzz_nonexistent_agent');
    expect(screen.getByText('No enforce events')).toBeInTheDocument();
    expect(screen.getByText(/No enforcement events match the current filters/)).toBeInTheDocument();
  });

  it('note about client-side enforcement is visible', () => {
    r();
    expect(
      screen.getByText(/Scope enforcement runs client-side in the SDK/),
    ).toBeInTheDocument();
  });
});
