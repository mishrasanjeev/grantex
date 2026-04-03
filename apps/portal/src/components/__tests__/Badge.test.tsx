import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Badge } from '../ui/Badge';

describe('Badge', () => {
  it('renders text content', () => {
    render(<Badge>active</Badge>);
    expect(screen.getByText('active')).toBeInTheDocument();
  });

  it('applies default variant styles', () => {
    render(<Badge>default</Badge>);
    expect(screen.getByText('default')).toHaveClass('bg-gx-border/50');
    expect(screen.getByText('default')).toHaveClass('text-gx-muted');
  });

  it('applies success variant styles', () => {
    render(<Badge variant="success">live</Badge>);
    const el = screen.getByText('live');
    expect(el).toHaveClass('bg-gx-accent/15');
    expect(el).toHaveClass('text-gx-accent');
  });

  it('applies warning variant styles', () => {
    render(<Badge variant="warning">sandbox</Badge>);
    const el = screen.getByText('sandbox');
    expect(el).toHaveClass('bg-gx-warning/15');
    expect(el).toHaveClass('text-gx-warning');
  });

  it('applies danger variant styles', () => {
    render(<Badge variant="danger">revoked</Badge>);
    const el = screen.getByText('revoked');
    expect(el).toHaveClass('bg-gx-danger/15');
    expect(el).toHaveClass('text-gx-danger');
  });

  it('renders as an inline-flex span', () => {
    render(<Badge>tag</Badge>);
    const el = screen.getByText('tag');
    expect(el.tagName).toBe('SPAN');
    expect(el).toHaveClass('inline-flex');
  });

  it('uses monospace font', () => {
    render(<Badge>mono</Badge>);
    expect(screen.getByText('mono')).toHaveClass('font-mono');
  });

  it('uses extra-small text size', () => {
    render(<Badge>small</Badge>);
    expect(screen.getByText('small')).toHaveClass('text-xs');
  });
});
