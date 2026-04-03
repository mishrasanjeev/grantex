import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Select } from '../ui/Select';

const options = [
  { value: 'a', label: 'Option A' },
  { value: 'b', label: 'Option B' },
  { value: 'c', label: 'Option C' },
];

describe('Select', () => {
  it('renders all options', () => {
    render(<Select options={options} />);
    expect(screen.getByText('Option A')).toBeInTheDocument();
    expect(screen.getByText('Option B')).toBeInTheDocument();
    expect(screen.getByText('Option C')).toBeInTheDocument();
  });

  it('renders label when provided', () => {
    render(<Select label="Choose one" options={options} id="sel" />);
    expect(screen.getByText('Choose one')).toBeInTheDocument();
    expect(screen.getByLabelText('Choose one')).toBeInTheDocument();
  });

  it('forwards id to select element', () => {
    render(<Select options={options} id="my-select" />);
    expect(document.getElementById('my-select')).toBeInTheDocument();
  });

  it('renders without label', () => {
    render(<Select options={options} />);
    expect(screen.queryByRole('label')).not.toBeInTheDocument();
  });
});
