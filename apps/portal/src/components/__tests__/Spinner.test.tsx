import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Spinner } from '../ui/Spinner';

describe('Spinner', () => {
  it('renders an SVG element', () => {
    const { container } = render(<Spinner />);
    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();
  });

  it('has animate-spin class for animation', () => {
    const { container } = render(<Spinner />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveClass('animate-spin');
  });

  it('applies default size classes', () => {
    const { container } = render(<Spinner />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveClass('h-5');
    expect(svg).toHaveClass('w-5');
  });

  it('applies default color class', () => {
    const { container } = render(<Spinner />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveClass('text-gx-accent');
  });

  it('accepts additional className', () => {
    const { container } = render(<Spinner className="h-8 w-8" />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveClass('animate-spin');
    // custom classes should be applied
    expect(svg).toHaveClass('h-8');
    expect(svg).toHaveClass('w-8');
  });

  it('contains a circle and a path element', () => {
    const { container } = render(<Spinner />);
    expect(container.querySelector('circle')).toBeInTheDocument();
    expect(container.querySelector('path')).toBeInTheDocument();
  });
});
