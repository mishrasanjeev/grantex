import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WebAuthnList } from '../webauthn/WebAuthnList';

describe('WebAuthnList', () => {
  it('renders page title', () => {
    render(<WebAuthnList />);
    expect(screen.getByText('WebAuthn')).toBeInTheDocument();
  });

  it('shows empty state', () => {
    render(<WebAuthnList />);
    expect(screen.getByText('No WebAuthn credentials')).toBeInTheDocument();
    expect(screen.getByText(/Register a passkey or security key/)).toBeInTheDocument();
  });
});
