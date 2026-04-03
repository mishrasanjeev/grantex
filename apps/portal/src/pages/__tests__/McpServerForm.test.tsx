import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { McpServerForm } from '../mcp/McpServerForm';

const mockCreateMcpServer = vi.fn();
const mockShow = vi.fn();
const mockNavigate = vi.fn();

vi.mock('../../api/mcp', () => ({
  createMcpServer: (...a: unknown[]) => mockCreateMcpServer(...a),
}));
vi.mock('../../store/toast', () => ({ useToast: () => ({ show: mockShow }) }));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

function r() { return render(<MemoryRouter><McpServerForm /></MemoryRouter>); }

describe('McpServerForm', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('renders step 1 heading', () => {
    r();
    expect(screen.getByText('Register MCP Server')).toBeInTheDocument();
    expect(screen.getByText('Server Details')).toBeInTheDocument();
  });

  it('shows Name input', () => {
    r();
    expect(screen.getByPlaceholderText('My MCP Server')).toBeInTheDocument();
  });

  it('disables Next when name is empty', () => {
    r();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('advances through steps', async () => {
    const user = userEvent.setup();
    r();
    // Step 1 - enter name
    await user.type(screen.getByPlaceholderText('My MCP Server'), 'Test Server');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    // Step 2 - Scope Definition
    await waitFor(() => expect(screen.getByText('Scope Definition')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Next' }));
    // Step 3 - Deployment Mode
    await waitFor(() => expect(screen.getByText('Deployment Mode')).toBeInTheDocument());
    expect(screen.getByText('Managed')).toBeInTheDocument();
    expect(screen.getByText('Self-hosted')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    // Step 4 - Review
    await waitFor(() => expect(screen.getByText('Review & Create')).toBeInTheDocument());
    expect(screen.getByText('Test Server')).toBeInTheDocument();
  });

  it('shows Back button on steps > 1', async () => {
    const user = userEvent.setup();
    r();
    // Step 1 has no Back
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
    await user.type(screen.getByPlaceholderText('My MCP Server'), 'Test');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument());
  });

  it('has Cancel button', () => {
    r();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('shows Docker Compose for self-hosted mode', async () => {
    const user = userEvent.setup();
    r();
    await user.type(screen.getByPlaceholderText('My MCP Server'), 'Test');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(screen.getByText('Scope Definition')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(screen.getByText('Deployment Mode')).toBeInTheDocument());
    await user.click(screen.getByText('Self-hosted'));
    await waitFor(() => expect(screen.getByText(/Docker Compose/)).toBeInTheDocument());
  });

  it('submits and navigates on success', async () => {
    mockCreateMcpServer.mockResolvedValueOnce({ id: 'mcp-new' });
    const user = userEvent.setup();
    r();
    await user.type(screen.getByPlaceholderText('My MCP Server'), 'My Server');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(screen.getByText('Scope Definition')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(screen.getByText('Deployment Mode')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(screen.getByText('Review & Create')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Register Server' }));
    await waitFor(() => expect(mockCreateMcpServer).toHaveBeenCalled());
    expect(mockShow).toHaveBeenCalledWith('MCP server registered', 'success');
    expect(mockNavigate).toHaveBeenCalledWith('/dashboard/mcp/mcp-new');
  });

  it('shows error toast on submission failure', async () => {
    mockCreateMcpServer.mockRejectedValueOnce(new Error('fail'));
    const user = userEvent.setup();
    r();
    await user.type(screen.getByPlaceholderText('My MCP Server'), 'My Server');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(screen.getByText('Scope Definition')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(screen.getByText('Deployment Mode')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(screen.getByText('Review & Create')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Register Server' }));
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Failed to register MCP server', 'error'));
  });

  it('shows category dropdown', () => {
    r();
    expect(screen.getByText('Productivity')).toBeInTheDocument();
  });
});
