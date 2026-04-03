import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EmptyState } from '../ui/EmptyState';

describe('EmptyState', () => {
  it('renders title', () => {
    render(<EmptyState title="No agents" />);
    expect(screen.getByText('No agents')).toBeInTheDocument();
  });

  it('renders description when provided', () => {
    render(<EmptyState title="No agents" description="Create your first agent to get started." />);
    expect(screen.getByText('Create your first agent to get started.')).toBeInTheDocument();
  });

  it('does not render description when omitted', () => {
    render(<EmptyState title="No agents" />);
    // Only the title text and the SVG icon should be present
    expect(screen.queryByText('Create your first agent')).not.toBeInTheDocument();
  });

  it('renders action element when provided', () => {
    render(
      <EmptyState
        title="No agents"
        action={<button>Create Agent</button>}
      />,
    );
    expect(screen.getByRole('button', { name: 'Create Agent' })).toBeInTheDocument();
  });

  it('does not render action when omitted', () => {
    render(<EmptyState title="No agents" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('action button is clickable', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(
      <EmptyState
        title="Empty"
        action={<button onClick={onClick}>Add</button>}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('renders an icon SVG', () => {
    const { container } = render(<EmptyState title="Empty" />);
    expect(container.querySelector('svg')).toBeInTheDocument();
  });

  it('centers content', () => {
    const { container } = render(<EmptyState title="Centered" />);
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper).toHaveClass('flex');
    expect(wrapper).toHaveClass('items-center');
    expect(wrapper).toHaveClass('justify-center');
    expect(wrapper).toHaveClass('text-center');
  });
});
