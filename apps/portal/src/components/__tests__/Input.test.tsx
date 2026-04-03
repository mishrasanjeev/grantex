import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Input } from '../ui/Input';

describe('Input', () => {
  it('renders an input element', () => {
    render(<Input placeholder="Enter text" />);
    expect(screen.getByPlaceholderText('Enter text')).toBeInTheDocument();
  });

  it('renders a label when label prop is provided', () => {
    render(<Input label="Username" id="username" />);
    expect(screen.getByLabelText('Username')).toBeInTheDocument();
  });

  it('renders hint text alongside the label', () => {
    render(<Input label="API Key" hint="starts with gx_" id="apikey" />);
    expect(screen.getByText('(starts with gx_)')).toBeInTheDocument();
  });

  it('forwards id to the input element', () => {
    render(<Input label="Email" id="email-input" />);
    const input = screen.getByLabelText('Email');
    expect(input).toHaveAttribute('id', 'email-input');
  });

  it('forwards placeholder prop', () => {
    render(<Input placeholder="Type here..." />);
    expect(screen.getByPlaceholderText('Type here...')).toBeInTheDocument();
  });

  it('handles value and onChange', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Input value="" onChange={onChange} placeholder="type" />);
    await user.type(screen.getByPlaceholderText('type'), 'a');
    expect(onChange).toHaveBeenCalled();
  });

  it('forwards className prop', () => {
    render(<Input className="extra" placeholder="cls" />);
    expect(screen.getByPlaceholderText('cls')).toHaveClass('extra');
  });

  it('renders error message when error prop is provided', () => {
    render(<Input error="This field is required" placeholder="err" />);
    expect(screen.getByText('This field is required')).toBeInTheDocument();
  });

  it('applies error border style when error prop is set', () => {
    render(<Input error="Bad value" placeholder="err" />);
    expect(screen.getByPlaceholderText('err')).toHaveClass('border-gx-danger');
  });

  it('applies normal border style when no error', () => {
    render(<Input placeholder="normal" />);
    expect(screen.getByPlaceholderText('normal')).toHaveClass('border-gx-border');
  });

  it('does not render label when label prop is omitted', () => {
    const { container } = render(<Input placeholder="no-label" />);
    expect(container.querySelector('label')).toBeNull();
  });

  it('does not render error message when error prop is omitted', () => {
    render(<Input placeholder="no-error" />);
    const errorP = document.querySelector('p.text-gx-danger');
    expect(errorP).toBeNull();
  });

  it('forwards native input attributes like type and disabled', () => {
    render(<Input type="password" disabled placeholder="pwd" />);
    const input = screen.getByPlaceholderText('pwd');
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toBeDisabled();
  });
});
