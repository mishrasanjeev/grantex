import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ManifestViewer } from '../manifests/ManifestViewer';
import { BUNDLED_MANIFESTS } from '../../api/manifests';

function r() {
  return render(<ManifestViewer />);
}

describe('ManifestViewer', () => {
  it('renders heading "Tool Manifests"', () => {
    r();
    expect(screen.getByText('Tool Manifests')).toBeInTheDocument();
  });

  it('renders all connector rows', () => {
    r();
    for (const m of BUNDLED_MANIFESTS) {
      expect(screen.getByText(m.connector)).toBeInTheDocument();
    }
  });

  it('search filters by connector name', async () => {
    const user = userEvent.setup();
    r();
    const input = screen.getByPlaceholderText('Search connectors or tools...');
    await user.type(input, 'salesforce');
    expect(screen.getByText('salesforce')).toBeInTheDocument();
    // Other connectors should be filtered out
    expect(screen.queryByText('hubspot')).not.toBeInTheDocument();
    expect(screen.queryByText('jira')).not.toBeInTheDocument();
  });

  it('category pills filter correctly', async () => {
    const user = userEvent.setup();
    r();
    // Click "Finance" category pill
    await user.click(screen.getByRole('button', { name: 'Finance' }));
    // Finance connectors should be visible
    expect(screen.getByText('stripe')).toBeInTheDocument();
    expect(screen.getByText('quickbooks')).toBeInTheDocument();
    // Non-finance connectors should be gone
    expect(screen.queryByText('jira')).not.toBeInTheDocument();
    expect(screen.queryByText('slack')).not.toBeInTheDocument();
    expect(screen.queryByText('hubspot')).not.toBeInTheDocument();
  });

  it('clicking a row expands to show tools with permission badges', async () => {
    const user = userEvent.setup();
    r();
    // Click on the salesforce row
    await user.click(screen.getByText('salesforce'));
    // Should show sample tools
    expect(screen.getByText('get_account')).toBeInTheDocument();
    expect(screen.getByText('create_opportunity')).toBeInTheDocument();
    expect(screen.getByText('delete_record')).toBeInTheDocument();
    // Should show permission badges
    expect(screen.getAllByText('READ').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('WRITE').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('DELETE').length).toBeGreaterThanOrEqual(1);
  });

  it('permission badges show correct colors (READ=green, WRITE=yellow, DELETE=red, ADMIN=purple)', async () => {
    const user = userEvent.setup();
    r();
    // Expand Stripe which has all four permission types including admin
    await user.click(screen.getByText('stripe'));

    // READ badges use success variant -> text-gx-accent (green)
    const readBadges = screen.getAllByText('READ');
    expect(readBadges.length).toBeGreaterThanOrEqual(1);
    expect(readBadges[0]!.className).toContain('text-gx-accent');

    // WRITE badges use warning variant -> text-gx-warning (yellow)
    const writeBadges = screen.getAllByText('WRITE');
    expect(writeBadges.length).toBeGreaterThanOrEqual(1);
    expect(writeBadges[0]!.className).toContain('text-gx-warning');

    // DELETE badges use danger variant -> text-gx-danger (red)
    const deleteBadges = screen.getAllByText('DELETE');
    expect(deleteBadges.length).toBeGreaterThanOrEqual(1);
    expect(deleteBadges[0]!.className).toContain('text-gx-danger');

    // ADMIN badge uses custom purple styling
    const adminBadge = screen.getByText('ADMIN');
    expect(adminBadge.className).toContain('text-purple-400');
    expect(adminBadge.className).toContain('bg-purple-500/15');
  });

  it('search for non-existent connector shows empty state', async () => {
    const user = userEvent.setup();
    r();
    const input = screen.getByPlaceholderText('Search connectors or tools...');
    await user.type(input, 'zzz_nonexistent_connector');
    expect(screen.getByText('No manifests found')).toBeInTheDocument();
    expect(screen.getByText('Try adjusting your search or category filter.')).toBeInTheDocument();
  });
});
