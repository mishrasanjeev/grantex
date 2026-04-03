import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { McpServerDetail } from '../mcp/McpServerDetail';

const mockGetMcpServer = vi.fn();
const mockApplyForCertification = vi.fn();
const mockShow = vi.fn();

vi.mock('../../api/mcp', () => ({
  getMcpServer: (...a: unknown[]) => mockGetMcpServer(...a),
  applyForCertification: (...a: unknown[]) => mockApplyForCertification(...a),
}));
vi.mock('../../store/toast', () => ({ useToast: () => ({ show: mockShow }) }));

const server = {
  id: 'mcp-1', name: 'Data Server', description: 'A data MCP server',
  category: 'data', status: 'active', certified: false, certificationLevel: null,
  certifiedAt: null, authEndpoint: 'https://auth.example.com/mcp',
  serverUrl: 'https://mcp.example.com', scopes: ['read', 'write'],
  weeklyActiveAgents: 142, stars: 87, npmPackage: null,
  createdAt: '2026-01-01T00:00:00Z',
};

function r() {
  return render(
    <MemoryRouter initialEntries={['/dashboard/mcp/mcp-1']}>
      <Routes><Route path="/dashboard/mcp/:serverId" element={<McpServerDetail />} /></Routes>
    </MemoryRouter>,
  );
}

describe('McpServerDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMcpServer.mockResolvedValue(server);
  });

  it('renders server name', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Data Server')).toBeInTheDocument());
  });

  it('displays server details', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Server Details')).toBeInTheDocument());
    expect(screen.getByText('mcp-1')).toBeInTheDocument();
    expect(screen.getByText('data')).toBeInTheDocument();
  });

  it('shows auth endpoint', async () => {
    r();
    await waitFor(() => expect(screen.getByText('https://auth.example.com/mcp')).toBeInTheDocument());
  });

  it('shows server URL', async () => {
    r();
    await waitFor(() => expect(screen.getByText('https://mcp.example.com')).toBeInTheDocument());
  });

  it('displays scopes', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Scopes')).toBeInTheDocument());
  });

  it('shows description', async () => {
    r();
    await waitFor(() => expect(screen.getByText('A data MCP server')).toBeInTheDocument());
  });

  it('shows stats row', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Weekly Agents')).toBeInTheDocument());
    expect(screen.getByText('Stars')).toBeInTheDocument();
    expect(screen.getByText('142')).toBeInTheDocument();
    expect(screen.getByText('87')).toBeInTheDocument();
  });

  it('shows certification section', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Certification')).toBeInTheDocument());
    expect(screen.getByText('Current Level')).toBeInTheDocument();
    expect(screen.getByText('none')).toBeInTheDocument();
  });

  it('shows Apply buttons for uncertified server', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Apply for Bronze')).toBeInTheDocument());
    expect(screen.getByText('Apply for Silver')).toBeInTheDocument();
    expect(screen.getByText('Apply for Gold')).toBeInTheDocument();
  });

  it('applies for certification on click', async () => {
    mockApplyForCertification.mockResolvedValueOnce(undefined);
    mockGetMcpServer.mockResolvedValueOnce(server).mockResolvedValueOnce({ ...server, certificationLevel: 'bronze' });
    const user = userEvent.setup();
    r();
    await waitFor(() => expect(screen.getByText('Apply for Bronze')).toBeInTheDocument());
    await user.click(screen.getByText('Apply for Bronze'));
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Applied for bronze certification', 'success'));
  });

  it('shows error toast on certification failure', async () => {
    mockApplyForCertification.mockRejectedValueOnce(new Error('fail'));
    const user = userEvent.setup();
    r();
    await waitFor(() => expect(screen.getByText('Apply for Bronze')).toBeInTheDocument());
    await user.click(screen.getByText('Apply for Bronze'));
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Failed to apply for certification', 'error'));
  });

  it('shows error toast on load failure', async () => {
    mockGetMcpServer.mockRejectedValue(new Error('fail'));
    r();
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Failed to load MCP server', 'error'));
  });

  it('shows Active Clients table', async () => {
    r();
    await waitFor(() => expect(screen.getByText('Active Clients')).toBeInTheDocument());
    expect(screen.getByText('data-pipeline-agent')).toBeInTheDocument();
  });
});
