import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AgentDetail } from '../agents/AgentDetail';

const mockGetAgent = vi.fn();
const mockDeleteAgent = vi.fn();
const mockUpdateAgent = vi.fn();
const mockListGrants = vi.fn();
const mockShow = vi.fn();
const mockNavigate = vi.fn();

vi.mock('../../api/agents', () => ({
  getAgent: (...a: unknown[]) => mockGetAgent(...a),
  deleteAgent: (...a: unknown[]) => mockDeleteAgent(...a),
  updateAgent: (...a: unknown[]) => mockUpdateAgent(...a),
}));
vi.mock('../../api/grants', () => ({ listGrants: (...a: unknown[]) => mockListGrants(...a) }));
vi.mock('../../store/toast', () => ({ useToast: () => ({ show: mockShow }) }));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

const agent = {
  agentId: 'a1', did: 'did:web:a1', developerId: 'd1', name: 'Agent One',
  description: 'A test agent', scopes: ['read', 'write'], status: 'active' as const,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z',
};

const agentWithScopes = {
  ...agent,
  scopes: ['grantex:hubspot:read', 'grantex:stripe:write', 'grantex:jira:delete', 'grantex:sap:admin'],
};

const agentNoScopes = {
  ...agent,
  scopes: [],
};

const grants = [
  { grantId: 'g1', agentId: 'a1', principalId: 'user@t.com', developerId: 'd1',
    scopes: ['read'], status: 'active' as const, issuedAt: '2026-01-01T00:00:00Z',
    expiresAt: '2026-12-31T00:00:00Z', delegationDepth: 0 },
];

function renderDetail() {
  return render(
    <MemoryRouter initialEntries={['/dashboard/agents/a1']}>
      <Routes><Route path='/dashboard/agents/:id' element={<AgentDetail />} /></Routes>
    </MemoryRouter>,
  );
}

describe('AgentDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAgent.mockResolvedValue(agent);
    mockListGrants.mockResolvedValue(grants);
  });

  it('displays agent metadata', async () => {
    renderDetail();
    await waitFor(() => expect(screen.getByText('Agent One')).toBeInTheDocument());
    expect(screen.getByText('a1')).toBeInTheDocument();
    expect(screen.getByText('did:web:a1')).toBeInTheDocument();
    expect(screen.getByText('A test agent')).toBeInTheDocument();
  });

  it('displays associated grants', async () => {
    renderDetail();
    await waitFor(() => expect(screen.getByText('Grants (1)')).toBeInTheDocument());
  });

  it('shows no grants message when empty', async () => {
    mockListGrants.mockResolvedValue([]);
    renderDetail();
    await waitFor(() => expect(screen.getByText('No grants for this agent')).toBeInTheDocument());
  });

  it('has Suspend button for active agent', async () => {
    renderDetail();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Suspend' })).toBeInTheDocument());
  });

  it('toggles status to suspended', async () => {
    mockUpdateAgent.mockResolvedValueOnce({ ...agent, status: 'suspended' });
    const user = userEvent.setup();
    renderDetail();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Suspend' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Suspend' }));
    await waitFor(() => expect(mockUpdateAgent).toHaveBeenCalledWith('a1', { status: 'suspended' }));
  });

  it('has Edit and Delete buttons', async () => {
    renderDetail();
    await waitFor(() => expect(screen.getByText('Agent One')).toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });

  it('deletes agent on confirm', async () => {
    mockDeleteAgent.mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    renderDetail();
    await waitFor(() => expect(screen.getByText('Agent One')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.getByText('Delete Agent')).toBeInTheDocument());
    await user.click(screen.getAllByRole('button', { name: 'Delete' }).pop()!);
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Agent deleted', 'success'));
    expect(mockNavigate).toHaveBeenCalledWith('/dashboard/agents');
  });

  it('redirects when agent not found', async () => {
    mockGetAgent.mockRejectedValue(new Error('not found'));
    renderDetail();
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Agent not found', 'error'));
    expect(mockNavigate).toHaveBeenCalledWith('/dashboard/agents');
  });

  it('displays scopes pills', async () => {
    renderDetail();
    await waitFor(() => expect(screen.getByText('Agent One')).toBeInTheDocument());
    expect(screen.getAllByText('read').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('write').length).toBeGreaterThanOrEqual(1);
  });

  it('renders "Scope Enforcement" card when agent has scopes', async () => {
    mockGetAgent.mockResolvedValue(agentWithScopes);
    renderDetail();
    await waitFor(() => expect(screen.getByText('Scope Enforcement')).toBeInTheDocument());
    expect(screen.getByText(/Permission levels derived from this agent's scopes/)).toBeInTheDocument();
  });

  it('shows permission level for each scope (READ/WRITE/DELETE/ADMIN)', async () => {
    mockGetAgent.mockResolvedValue(agentWithScopes);
    renderDetail();
    await waitFor(() => expect(screen.getByText('Scope Enforcement')).toBeInTheDocument());
    // Each scope appears in both ScopePills and enforcement table, so use getAllByText
    expect(screen.getAllByText('grantex:hubspot:read').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('grantex:stripe:write').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('grantex:jira:delete').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('grantex:sap:admin').length).toBeGreaterThanOrEqual(1);
  });

  it('shows "Allows" column with correct levels', async () => {
    mockGetAgent.mockResolvedValue(agentWithScopes);
    renderDetail();
    await waitFor(() => expect(screen.getByText('Scope Enforcement')).toBeInTheDocument());
    // Check column header exists
    expect(screen.getByText('Allows')).toBeInTheDocument();
    // read scope -> "READ only"
    expect(screen.getByText('READ only')).toBeInTheDocument();
    // write scope -> "READ, WRITE"
    expect(screen.getByText('READ, WRITE')).toBeInTheDocument();
    // delete scope -> "READ, WRITE, DELETE"
    expect(screen.getByText('READ, WRITE, DELETE')).toBeInTheDocument();
    // admin scope -> "READ, WRITE, DELETE, ADMIN"
    expect(screen.getByText('READ, WRITE, DELETE, ADMIN')).toBeInTheDocument();
  });

  it('does not render scope enforcement card when no scopes', async () => {
    mockGetAgent.mockResolvedValue(agentNoScopes);
    renderDetail();
    await waitFor(() => expect(screen.getByText('Agent One')).toBeInTheDocument());
    expect(screen.queryByText('Scope Enforcement')).not.toBeInTheDocument();
  });
});
