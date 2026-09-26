import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WebAuthnList } from '../webauthn/WebAuthnList';

const mockCreateEnrollmentSession = vi.fn();
const mockListWebAuthnCredentials = vi.fn();
const mockDeleteWebAuthnCredential = vi.fn();
const mockShow = vi.fn();

vi.mock('../../api/webauthn', () => ({
  createEnrollmentSession: (...args: unknown[]) => mockCreateEnrollmentSession(...args),
  listWebAuthnCredentials: (...args: unknown[]) => mockListWebAuthnCredentials(...args),
  deleteWebAuthnCredential: (...args: unknown[]) => mockDeleteWebAuthnCredential(...args),
}));
vi.mock('../../store/toast', () => ({ useToast: () => ({ show: mockShow }) }));

describe('WebAuthnList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateEnrollmentSession.mockResolvedValue({
      enrollmentUrl: 'https://grantex.dev/passkey-enroll#ticket=test',
      expiresAt: '2026-12-01T00:00:00Z',
    });
    mockListWebAuthnCredentials.mockResolvedValue([]);
  });

  it('issues a one-use enrollment link for a selected principal and request', async () => {
    const user = userEvent.setup();
    render(<WebAuthnList />);
    expect(screen.getByRole('heading', { name: 'Passkeys' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Principal ID'), 'person_1');
    await user.type(screen.getByLabelText('Authorization request ID (optional)'), 'areq_123');
    await user.click(screen.getByRole('button', { name: 'Create enrollment link' }));
    await waitFor(() => expect(mockCreateEnrollmentSession).toHaveBeenCalledWith('person_1', 'areq_123'));
    expect(await screen.findByDisplayValue('https://grantex.dev/passkey-enroll#ticket=test')).toBeInTheDocument();
    expect(screen.getByText(/Treat this link as a secret/)).toBeInTheDocument();
  });

  it('loads registered credentials for the principal', async () => {
    mockListWebAuthnCredentials.mockResolvedValue([{ id: 'cred_1', principalId: 'person_1',
      deviceName: 'Laptop', backedUp: false, transports: [], createdAt: '2026-09-01T00:00:00Z', lastUsedAt: null }]);
    const user = userEvent.setup();
    render(<WebAuthnList />);
    await user.type(screen.getByLabelText('Principal ID'), 'person_1');
    await user.click(screen.getByRole('button', { name: 'View passkeys' }));
    expect(await screen.findByText('Laptop')).toBeInTheDocument();
    expect(mockListWebAuthnCredentials).toHaveBeenCalledWith('person_1');
  });
});
