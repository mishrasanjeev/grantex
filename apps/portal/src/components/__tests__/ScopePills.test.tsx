import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ScopePills } from '../ui/ScopePills';

describe('ScopePills', () => {
  it('renders all scopes as pill elements', () => {
    render(<ScopePills scopes={['read', 'write', 'admin']} />);
    expect(screen.getByText('read')).toBeInTheDocument();
    expect(screen.getByText('write')).toBeInTheDocument();
    expect(screen.getByText('admin')).toBeInTheDocument();
  });

  it('renders an empty container when scopes is empty', () => {
    const { container } = render(<ScopePills scopes={[]} />);
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.children).toHaveLength(0);
  });

  it('renders single scope', () => {
    render(<ScopePills scopes={['read:agents']} />);
    expect(screen.getByText('read:agents')).toBeInTheDocument();
  });

  it('uses monospace font for pills', () => {
    render(<ScopePills scopes={['read']} />);
    expect(screen.getByText('read')).toHaveClass('font-mono');
  });

  it('uses extra-small text size', () => {
    render(<ScopePills scopes={['write']} />);
    expect(screen.getByText('write')).toHaveClass('text-xs');
  });

  it('renders pills as span elements', () => {
    render(<ScopePills scopes={['scope1']} />);
    expect(screen.getByText('scope1').tagName).toBe('SPAN');
  });

  it('applies flex-wrap for wrapping pills', () => {
    const { container } = render(<ScopePills scopes={['a', 'b']} />);
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper).toHaveClass('flex');
    expect(wrapper).toHaveClass('flex-wrap');
  });

  it('forwards className to the wrapper', () => {
    const { container } = render(<ScopePills scopes={['read']} className="mt-2" />);
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper).toHaveClass('mt-2');
  });

  it('renders each scope with accent2 styling', () => {
    render(<ScopePills scopes={['manage']} />);
    expect(screen.getByText('manage')).toHaveClass('bg-gx-accent2/10');
    expect(screen.getByText('manage')).toHaveClass('text-gx-accent2');
  });
});
