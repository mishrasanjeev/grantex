import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Card } from '../ui/Card';

describe('Card', () => {
  it('renders children', () => {
    render(<Card>Hello World</Card>);
    expect(screen.getByText('Hello World')).toBeInTheDocument();
  });

  it('renders complex children', () => {
    render(
      <Card>
        <h2>Title</h2>
        <p>Description</p>
      </Card>,
    );
    expect(screen.getByText('Title')).toBeInTheDocument();
    expect(screen.getByText('Description')).toBeInTheDocument();
  });

  it('applies default styling classes', () => {
    const { container } = render(<Card>Styled</Card>);
    const card = container.firstChild as HTMLElement;
    expect(card).toHaveClass('bg-gx-surface');
    expect(card).toHaveClass('border');
    expect(card).toHaveClass('rounded-lg');
    expect(card).toHaveClass('p-6');
  });

  it('forwards additional className', () => {
    const { container } = render(<Card className="extra-class">Custom</Card>);
    const card = container.firstChild as HTMLElement;
    expect(card).toHaveClass('extra-class');
  });

  it('merges className with default classes', () => {
    const { container } = render(<Card className="mt-4">Merged</Card>);
    const card = container.firstChild as HTMLElement;
    expect(card).toHaveClass('bg-gx-surface');
    expect(card).toHaveClass('mt-4');
  });
});
