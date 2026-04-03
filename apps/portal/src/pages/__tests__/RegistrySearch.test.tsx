import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RegistrySearch } from '../registry/RegistrySearch';

const mockSearchRegistryOrgs = vi.fn();
const mockShow = vi.fn();

vi.mock('../../api/registry', () => ({
  searchRegistryOrgs: (...a: unknown[]) => mockSearchRegistryOrgs(...a),
}));
vi.mock('../../store/toast', () => ({ useToast: () => ({ show: mockShow }) }));

const orgs = [
  {
    did: 'did:web:acme.com', name: 'Acme Corp', description: 'Acme description',
    verificationLevel: 'verified', badges: ['soc2', 'gdpr'], logoUrl: null,
    website: 'https://acme.com',
    stats: { totalAgents: 10, weeklyActiveGrants: 500, averageRating: 4.5 },
  },
  {
    did: 'did:web:beta.io', name: 'Beta Inc', description: null,
    verificationLevel: 'unverified', badges: [], logoUrl: 'https://example.com/logo.png',
    website: null,
    stats: { totalAgents: 3, weeklyActiveGrants: 50, averageRating: 3.8 },
  },
];

function r() { return render(<MemoryRouter><RegistrySearch /></MemoryRouter>); }

describe('RegistrySearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchRegistryOrgs.mockResolvedValue({ data: orgs, meta: { total: 2 } });
  });

  it('renders heading', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Trust Registry')).toBeInTheDocument());
  });

  it('shows organization cards', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Acme Corp')).toBeInTheDocument());
    expect(screen.getByText('Beta Inc')).toBeInTheDocument();
  });

  it('shows verified badge for verified orgs', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Verified')).toBeInTheDocument());
  });

  it('shows compliance badges', async () => {
    r();
    await waitFor(() => expect(screen.getByText('soc2')).toBeInTheDocument());
    expect(screen.getByText('gdpr')).toBeInTheDocument();
  });

  it('shows org stats', async () => {
    r();
    await waitFor(() => expect(screen.getByText('10 agents')).toBeInTheDocument());
    expect(screen.getByText('500/wk')).toBeInTheDocument();
    expect(screen.getByText('4.5')).toBeInTheDocument();
  });

  it('shows empty state when no orgs', async () => {
    mockSearchRegistryOrgs.mockResolvedValue({ data: [], meta: { total: 0 } });
    r();
    await waitFor(() => expect(screen.getByText('No organizations found')).toBeInTheDocument());
  });

  it('shows error toast on load failure', async () => {
    mockSearchRegistryOrgs.mockRejectedValue(new Error('fail'));
    r();
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Failed to load registry', 'error'));
  });

  it('has Register Your Organization button', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Register Your Organization')).toBeInTheDocument());
  });

  it('has search input', async () => {
    r();
    await waitFor(() => expect(screen.getByPlaceholderText('Search organizations by name or DID...')).toBeInTheDocument());
  });

  it('has Verified only checkbox', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Verified only')).toBeInTheDocument());
  });

  it('has badge filter dropdown', async () => {
    r();
    await waitFor(() => expect(screen.getByText('All Badges')).toBeInTheDocument());
  });

  it('shows total stats bar', async () => {
    r();
    await waitFor(() => expect(screen.getByText(/2 orgs/)).toBeInTheDocument());
  });
});
