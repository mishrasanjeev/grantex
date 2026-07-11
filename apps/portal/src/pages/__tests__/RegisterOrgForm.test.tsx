import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { RegisterOrgForm } from '../registry/RegisterOrgForm';

const mockRegisterOrg = vi.fn();
const mockShow = vi.fn();
const mockNavigate = vi.fn();

vi.mock('../../api/registry', () => ({
  registerOrg: (...a: unknown[]) => mockRegisterOrg(...a),
}));
vi.mock('../../store/toast', () => ({ useToast: () => ({ show: mockShow }) }));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

function r() { return render(<MemoryRouter><RegisterOrgForm /></MemoryRouter>); }

async function submitRegistration(did: string) {
  const user = userEvent.setup();
  r();
  await user.type(screen.getByPlaceholderText('did:web:your-domain.com'), did);
  await user.type(screen.getByPlaceholderText('Acme Corp'), 'Test Org');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await waitFor(() => expect(screen.getByText('Contact Information')).toBeInTheDocument());
  await user.type(screen.getByPlaceholderText('security@your-domain.com'), 'sec@test.com');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await waitFor(() => expect(screen.getByText('Verification Method')).toBeInTheDocument());
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await waitFor(() => expect(screen.getByText('Review & Submit')).toBeInTheDocument());
  await user.click(screen.getByRole('button', { name: 'Register Organization' }));
  await waitFor(() => expect(mockRegisterOrg).toHaveBeenCalled());
}

describe('RegisterOrgForm', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('renders heading', () => {
    r();
    expect(screen.getByText('Register Your Organization')).toBeInTheDocument();
  });

  it('shows step 1 form fields', () => {
    r();
    expect(screen.getByText('Organization Details')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('did:web:your-domain.com')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Acme Corp')).toBeInTheDocument();
  });

  it('disables Next when DID and name are empty', () => {
    r();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('advances to step 2', async () => {
    const user = userEvent.setup();
    r();
    await user.type(screen.getByPlaceholderText('did:web:your-domain.com'), 'did:web:test.com');
    await user.type(screen.getByPlaceholderText('Acme Corp'), 'Test Org');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(screen.getByText('Contact Information')).toBeInTheDocument());
  });

  it('advances to step 3', async () => {
    const user = userEvent.setup();
    r();
    await user.type(screen.getByPlaceholderText('did:web:your-domain.com'), 'did:web:test.com');
    await user.type(screen.getByPlaceholderText('Acme Corp'), 'Test Org');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(screen.getByText('Contact Information')).toBeInTheDocument());
    await user.type(screen.getByPlaceholderText('security@your-domain.com'), 'sec@test.com');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(screen.getByText('Verification Method')).toBeInTheDocument());
  });

  it('shows verification methods in step 3', async () => {
    const user = userEvent.setup();
    r();
    await user.type(screen.getByPlaceholderText('did:web:your-domain.com'), 'did:web:test.com');
    await user.type(screen.getByPlaceholderText('Acme Corp'), 'Test Org');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(screen.getByText('Contact Information')).toBeInTheDocument());
    await user.type(screen.getByPlaceholderText('security@your-domain.com'), 'sec@test.com');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(screen.getByText('DNS TXT Record')).toBeInTheDocument());
    expect(screen.getByText('Recommended')).toBeInTheDocument();
    expect(screen.queryByText('.well-known Endpoint')).not.toBeInTheDocument();
    expect(screen.queryByText('SOC 2 Attestation')).not.toBeInTheDocument();
    expect(screen.queryByText('Manual Review')).not.toBeInTheDocument();
  });

  it('submits and displays one-time DNS verification details on success', async () => {
    mockRegisterOrg.mockResolvedValueOnce({
      orgId: 'treg_123',
      did: 'did:web:test.com',
      name: 'Test Org',
      trustLevel: 'basic',
      domain: 'test.com',
      dnsRecordName: '_grantex-verify.test.com',
      verificationToken: 'grantex-verify=token-123',
      instructions: 'Add the TXT record',
    });
    const user = userEvent.setup();
    r();
    // Step 1
    await user.type(screen.getByPlaceholderText('did:web:your-domain.com'), 'did:web:test.com');
    await user.type(screen.getByPlaceholderText('Acme Corp'), 'Test Org');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    // Step 2
    await waitFor(() => expect(screen.getByText('Contact Information')).toBeInTheDocument());
    await user.type(screen.getByPlaceholderText('security@your-domain.com'), 'sec@test.com');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    // Step 3
    await waitFor(() => expect(screen.getByText('Verification Method')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Next' }));
    // Step 4 - Review
    await waitFor(() => expect(screen.getByText('Review & Submit')).toBeInTheDocument());
    expect(screen.getByText('did:web:test.com')).toBeInTheDocument();
    expect(screen.getByText('Test Org')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Register Organization' }));
    await waitFor(() => expect(mockRegisterOrg).toHaveBeenCalled());
    expect(mockShow).toHaveBeenCalledWith('Organization registered. Add the DNS record to verify it.', 'success');
    expect(await screen.findByText('Organization Registered')).toBeInTheDocument();
    expect(screen.getByText('_grantex-verify.test.com')).toBeInTheDocument();
    expect(screen.getByText('grantex-verify=token-123')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Continue to verification' })).toHaveAttribute(
      'href',
      '/dashboard/registry/did%3Aweb%3Atest.com',
    );
  });

  it('shows error toast on submission failure', async () => {
    mockRegisterOrg.mockRejectedValueOnce(new Error('fail'));
    const user = userEvent.setup();
    r();
    // Step 1
    await user.type(screen.getByPlaceholderText('did:web:your-domain.com'), 'did:web:test.com');
    await user.type(screen.getByPlaceholderText('Acme Corp'), 'Test Org');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    // Step 2
    await waitFor(() => expect(screen.getByText('Contact Information')).toBeInTheDocument());
    await user.type(screen.getByPlaceholderText('security@your-domain.com'), 'sec@test.com');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    // Step 3
    await waitFor(() => expect(screen.getByText('Verification Method')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Next' }));
    // Step 4
    await waitFor(() => expect(screen.getByText('Review & Submit')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Register Organization' }));
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Failed to register organization', 'error'));
  });

  it('uses the server-derived DNS name for a path-based did:web identifier', async () => {
    mockRegisterOrg.mockResolvedValueOnce({
      orgId: 'treg_path',
      did: 'did:web:example.com:teams:registry',
      name: 'Test Org',
      trustLevel: 'basic',
      domain: 'example.com',
      dnsRecordName: '_grantex-verify.example.com',
      verificationToken: 'grantex-verify=path-token',
    });

    await submitRegistration('did:web:example.com:teams:registry');

    expect(await screen.findByText('_grantex-verify.example.com')).toBeInTheDocument();
    expect(screen.queryByText('_grantex-verify.example.com:teams:registry')).not.toBeInTheDocument();
  });

  it('has Back to Registry link', () => {
    r();
    expect(screen.getByText('Back to Registry')).toBeInTheDocument();
  });

  it('shows Back button on step 2+', async () => {
    const user = userEvent.setup();
    r();
    await user.type(screen.getByPlaceholderText('did:web:your-domain.com'), 'did:web:test.com');
    await user.type(screen.getByPlaceholderText('Acme Corp'), 'Test Org');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument());
  });
});
