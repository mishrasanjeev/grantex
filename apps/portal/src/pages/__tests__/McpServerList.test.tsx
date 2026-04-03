import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { McpServerList } from '../mcp/McpServerList';

const mockListMcpServers = vi.fn();
const mockShow = vi.fn();
const mockNavigate = vi.fn();

vi.mock('../../api/mcp', () => ({
  listMcpServers: (...a: unknown[]) => mockListMcpServers(...a),
}));
vi.mock('../../store/toast', () => ({ useToast: () => ({ show: mockShow }) }));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

const servers = [
  {
    id: 'mcp-1', name: 'Data Server', description: 'Data access', category: 'data',
    status: 'active', certified: true, certificationLevel: 'gold',
    weeklyActiveAgents: 142, stars: 87, scopes: ['read'],
    createdAt: '2026-01-01T00:00:00Z',
  },
  {
    id: 'mcp-2', name: 'Compute Server', description: null, category: 'compute',
    status: 'pending', certified: false, certificationLevel: null,
    weeklyActiveAgents: 5, stars: 2, scopes: [],
    createdAt: '2026-02-01T00:00:00Z',
  },
];

function r() { return render(<MemoryRouter><McpServerList /></MemoryRouter>); }

describe('McpServerList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListMcpServers.mockResolvedValue(servers);
  });

  it('renders heading', async () => {
    r();
    await waitFor(() => expect(screen.getByText('MCP Servers')).toBeInTheDocument());
  });

  it('shows server names', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Data Server')).toBeInTheDocument());
    expect(screen.getByText('Compute Server')).toBeInTheDocument();
  });

  it('shows empty state when no servers', async () => {
    mockListMcpServers.mockResolvedValue([]);
    r();
    await waitFor(() => expect(screen.getByText('No MCP servers found')).toBeInTheDocument());
  });

  it('has Register Server button', async () => {
    r();
    await waitFor(() => expect(screen.getAllByText('+ Register Server').length).toBeGreaterThanOrEqual(1));
  });

  it('shows error toast on load failure', async () => {
    mockListMcpServers.mockRejectedValue(new Error('fail'));
    r();
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Failed to load MCP servers', 'error'));
  });

  it('displays certification badges', async () => {
    r();
    await waitFor(() => expect(screen.getByText('gold')).toBeInTheDocument());
    expect(screen.getByText('none')).toBeInTheDocument();
  });

  it('displays category badges', async () => {
    r();
    await waitFor(() => expect(screen.getByText('data')).toBeInTheDocument());
    expect(screen.getByText('compute')).toBeInTheDocument();
  });

  it('displays status badges', async () => {
    r();
    await waitFor(() => expect(screen.getByText('active')).toBeInTheDocument());
    expect(screen.getByText('pending')).toBeInTheDocument();
  });

  it('displays weekly agents count', async () => {
    r();
    await waitFor(() => expect(screen.getByText('142')).toBeInTheDocument());
  });

  it('has category filter dropdown', async () => {
    r();
    await waitFor(() => expect(screen.getByText('All Categories')).toBeInTheDocument());
  });

  it('has certified only checkbox', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Certified only')).toBeInTheDocument());
  });
});
