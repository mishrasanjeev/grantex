import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { RegistryOrgDetail } from '../registry/RegistryOrgDetail';

const mockGetRegistryOrg = vi.fn();
const mockVerifyOrgDns = vi.fn();
const mockShow = vi.fn();

vi.mock('../../api/registry', () => ({
  getRegistryOrg: (...a: unknown[]) => mockGetRegistryOrg(...a),
  verifyOrgDns: (...a: unknown[]) => mockVerifyOrgDns(...a),
}));
vi.mock('../../store/toast', () => ({ useToast: () => ({ show: mockShow }) }));

const org = {
  did: 'did:web:acme.com', name: 'Acme Corp', description: 'An org description',
  verificationLevel: 'unverified', badges: ['soc2'], logoUrl: null,
  website: 'https://acme.com', verifiedAt: null, verificationMethod: null,
  compliance: { soc2: true, dpdp: false, gdpr: true },
  contact: { security: 'sec@acme.com', dpo: 'dpo@acme.com' },
  agents: [
    {
      agentDid: 'did:web:acme.com:agent-1', name: 'Agent One',
      category: 'data', scopes: ['read', 'write'], weeklyActiveGrants: 50, rating: 4.2,
    },
  ],
  publicKeys: [{ id: 'key-1', type: 'Ed25519', publicKeyMultibase: 'z...' }],
  stats: { totalAgents: 1, weeklyActiveGrants: 50, averageRating: 4.2 },
};

function r() {
  return render(
    <MemoryRouter initialEntries={['/dashboard/registry/did%3Aweb%3Aacme.com']}>
      <Routes><Route path="/dashboard/registry/:did" element={<RegistryOrgDetail />} /></Routes>
    </MemoryRouter>,
  );
}

describe('RegistryOrgDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRegistryOrg.mockResolvedValue(org);
  });

  it('renders org name', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Acme Corp')).toBeInTheDocument());
  });

  it('displays DID', async () => {
    r();
    await waitFor(() => expect(screen.getByText('did:web:acme.com')).toBeInTheDocument());
  });

  it('shows description', async () => {
    r();
    await waitFor(() => expect(screen.getByText('An org description')).toBeInTheDocument());
  });

  it('shows compliance section', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Compliance')).toBeInTheDocument());
    expect(screen.getByText('SOC 2 Type II')).toBeInTheDocument();
    expect(screen.getByText('DPDP Compliant')).toBeInTheDocument();
    expect(screen.getByText('GDPR Compliant')).toBeInTheDocument();
  });

  it('shows contact info', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Contact')).toBeInTheDocument());
    expect(screen.getByText('sec@acme.com')).toBeInTheDocument();
    expect(screen.getByText('dpo@acme.com')).toBeInTheDocument();
  });

  it('shows agents table', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Agents (1)')).toBeInTheDocument());
    expect(screen.getByText('Agent One')).toBeInTheDocument();
  });

  it('shows public keys', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Public Keys')).toBeInTheDocument());
  });

  it('shows Verify DID button for unverified orgs', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Verify DID')).toBeInTheDocument());
  });

  it('hides Verify button for verified orgs', async () => {
    mockGetRegistryOrg.mockResolvedValue({ ...org, verificationLevel: 'verified' });
    r();
    await waitFor(() => expect(screen.getByText('Acme Corp')).toBeInTheDocument());
    expect(screen.queryByText('Verify DID')).not.toBeInTheDocument();
  });

  it('verifies DID on click', async () => {
    mockVerifyOrgDns.mockResolvedValueOnce({ verified: true });
    const user = userEvent.setup();
    r();
    await waitFor(() => expect(screen.getByText('Verify DID')).toBeInTheDocument());
    await user.click(screen.getByText('Verify DID'));
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('DID verified successfully', 'success'));
  });

  it('shows error on DNS verification failure', async () => {
    mockVerifyOrgDns.mockResolvedValueOnce({ verified: false });
    const user = userEvent.setup();
    r();
    await waitFor(() => expect(screen.getByText('Verify DID')).toBeInTheDocument());
    await user.click(screen.getByText('Verify DID'));
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('DNS verification failed. Check your TXT record.', 'error'));
  });

  it('shows error toast on load failure', async () => {
    mockGetRegistryOrg.mockRejectedValue(new Error('fail'));
    r();
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Failed to load organization', 'error'));
  });

  it('shows not found message when org is null', async () => {
    mockGetRegistryOrg.mockRejectedValue(new Error('not found'));
    r();
    await waitFor(() => expect(screen.getByText('Organization not found.')).toBeInTheDocument());
  });

  it('shows badges', async () => {
    r();
    await waitFor(() => expect(screen.getByText('soc2')).toBeInTheDocument());
  });

  it('shows website link', async () => {
    r();
    await waitFor(() => expect(screen.getByText('acme.com')).toBeInTheDocument());
  });

  it('has Back to Registry link', async () => {
    r();
    await waitFor(() => expect(screen.getAllByText('Back to Registry').length).toBeGreaterThanOrEqual(1));
  });
});
