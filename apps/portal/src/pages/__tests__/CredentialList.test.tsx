import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CredentialList } from '../credentials/CredentialList';

describe('CredentialList', () => {
  it('renders page title', () => {
    render(<CredentialList />);
    expect(screen.getByText('Credentials')).toBeInTheDocument();
  });

  it('shows empty state', () => {
    render(<CredentialList />);
    expect(screen.getByText('No credentials')).toBeInTheDocument();
    expect(screen.getByText(/Create API credentials/)).toBeInTheDocument();
  });
});
