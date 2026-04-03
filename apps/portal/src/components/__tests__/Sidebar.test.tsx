import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Sidebar } from '../layout/Sidebar';

function renderSidebar(open = true) {
  const onClose = vi.fn();
  const result = render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <Sidebar open={open} onClose={onClose} />
    </MemoryRouter>,
  );
  return { ...result, onClose };
}

describe('Sidebar', () => {
  it('renders the grantex logo', () => {
    renderSidebar();
    expect(screen.getByText('grant')).toBeInTheDocument();
  });

  it('renders all navigation links', () => {
    renderSidebar();
    const expectedLinks = [
      'Overview', 'Agents', 'Grants', 'Bundles', 'Audit Log', 'Webhooks',
      'Policies', 'Anomalies', 'Compliance', 'Consent Records', 'Grievances',
      'Exports', 'Budgets', 'Usage', 'Domains', 'WebAuthn', 'Credentials',
      'Events', 'MCP Servers', 'Trust Registry', 'Billing', 'Settings',
      'SSO', 'SCIM', 'Admin',
    ];
    for (const label of expectedLinks) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('renders at least 25 nav links', () => {
    renderSidebar();
    const links = screen.getAllByRole('link');
    // At least 25 NavLinks + the logo link
    expect(links.length).toBeGreaterThanOrEqual(25);
  });

  it('applies translate-x-0 class when open', () => {
    const { container } = renderSidebar(true);
    const aside = container.querySelector('aside');
    expect(aside).toHaveClass('translate-x-0');
  });

  it('applies -translate-x-full class when closed', () => {
    const { container } = renderSidebar(false);
    const aside = container.querySelector('aside');
    expect(aside).toHaveClass('-translate-x-full');
  });

  it('renders overlay div when open', () => {
    const { container } = renderSidebar(true);
    // The overlay is the first child div with fixed+inset-0 classes (not inside the aside)
    const divs = container.querySelectorAll('div');
    const overlay = Array.from(divs).find(
      (d) => d.classList.contains('fixed') && d.classList.contains('inset-0') && d.classList.contains('lg:hidden'),
    );
    expect(overlay).toBeTruthy();
  });

  it('does not render overlay when closed', () => {
    const { container } = renderSidebar(false);
    const divs = container.querySelectorAll('div');
    const overlay = Array.from(divs).find(
      (d) => d.classList.contains('fixed') && d.classList.contains('inset-0') && d.classList.contains('lg:hidden'),
    );
    expect(overlay).toBeUndefined();
  });

  it('calls onClose when overlay is clicked', async () => {
    const { container, onClose } = renderSidebar(true);
    const user = userEvent.setup();
    const divs = container.querySelectorAll('div');
    const overlay = Array.from(divs).find(
      (d) => d.classList.contains('fixed') && d.classList.contains('inset-0') && d.classList.contains('lg:hidden'),
    );
    if (overlay) {
      await user.click(overlay);
      expect(onClose).toHaveBeenCalled();
    }
  });

  it('calls onClose when close button is clicked', async () => {
    const { container, onClose } = renderSidebar(true);
    const user = userEvent.setup();
    // The close button is inside the aside header
    const aside = container.querySelector('aside');
    const closeBtn = aside?.querySelector('button');
    if (closeBtn) {
      await user.click(closeBtn);
      expect(onClose).toHaveBeenCalled();
    }
  });

  it('highlights active Overview link when at /dashboard', () => {
    renderSidebar();
    const overviewLink = screen.getByText('Overview').closest('a');
    expect(overviewLink).toHaveClass('bg-gx-accent/10');
    expect(overviewLink).toHaveClass('text-gx-accent');
  });

  it('links point to correct paths', () => {
    renderSidebar();
    const agentsLink = screen.getByText('Agents').closest('a');
    expect(agentsLink).toHaveAttribute('href', '/dashboard/agents');
    const grantsLink = screen.getByText('Grants').closest('a');
    expect(grantsLink).toHaveAttribute('href', '/dashboard/grants');
    const settingsLink = screen.getByText('Settings').closest('a');
    expect(settingsLink).toHaveAttribute('href', '/dashboard/settings');
  });
});
