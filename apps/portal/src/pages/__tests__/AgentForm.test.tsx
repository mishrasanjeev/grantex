import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AgentForm } from '../agents/AgentForm';

const mockCreateAgent = vi.fn();
const mockGetAgent = vi.fn();
const mockUpdateAgent = vi.fn();
const mockShow = vi.fn();
const mockNavigate = vi.fn();

vi.mock('../../api/agents', () => ({
  createAgent: (...a: unknown[]) => mockCreateAgent(...a),
  getAgent: (...a: unknown[]) => mockGetAgent(...a),
  updateAgent: (...a: unknown[]) => mockUpdateAgent(...a),
}));
vi.mock('../../store/toast', () => ({ useToast: () => ({ show: mockShow }) }));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

function renderCreate() {
  return render(
    <MemoryRouter initialEntries={['/dashboard/agents/new']}>
      <Routes>
        <Route path='/dashboard/agents/new' element={<AgentForm />} />
      </Routes>
    </MemoryRouter>,
  );
}

function renderEdit() {
  return render(
    <MemoryRouter initialEntries={['/dashboard/agents/a1/edit']}>
      <Routes>
        <Route path='/dashboard/agents/:id/edit' element={<AgentForm />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('AgentForm', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('renders Create Agent mode', () => {
    renderCreate();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Create Agent');
    expect(screen.getByRole('button', { name: 'Create Agent' })).toBeInTheDocument();
  });

  it('disables submit when name is empty', () => {
    renderCreate();
    expect(screen.getByRole('button', { name: 'Create Agent' })).toBeDisabled();
  });

  it('creates agent on submit', async () => {
    mockCreateAgent.mockResolvedValueOnce({ agentId: 'new-id', name: 'Test' });
    const user = userEvent.setup();
    renderCreate();
    await user.type(screen.getByLabelText('Name'), 'Test Agent');
    await user.click(screen.getByRole('button', { name: 'Create Agent' }));
    await waitFor(() => expect(mockCreateAgent).toHaveBeenCalledWith({
      name: 'Test Agent', description: undefined, scopes: [],
    }));
    expect(mockShow).toHaveBeenCalledWith('Agent created', 'success');
  });

  it('creates an agent with multiple callback URIs', async () => {
    mockCreateAgent.mockResolvedValueOnce({ agentId: 'new-id', name: 'Test' });
    const user = userEvent.setup();
    renderCreate();
    await user.type(screen.getByLabelText('Name'), 'Test Agent');
    await user.click(screen.getByRole('button', { name: 'Add callback URI' }));
    await user.type(screen.getByLabelText('Callback 1'), 'https://client.example/first');
    await user.click(screen.getByRole('button', { name: 'Add callback URI' }));
    await user.type(screen.getByLabelText('Callback 2'), 'https://client.example/second');
    await user.click(screen.getByRole('button', { name: 'Create Agent' }));
    await waitFor(() => expect(mockCreateAgent).toHaveBeenCalledWith(expect.objectContaining({
      redirectUris: ['https://client.example/first', 'https://client.example/second'],
    })));
  });

  it('shows error toast on create failure', async () => {
    mockCreateAgent.mockRejectedValueOnce(new Error('fail'));
    const user = userEvent.setup();
    renderCreate();
    await user.type(screen.getByLabelText('Name'), 'Test');
    await user.click(screen.getByRole('button', { name: 'Create Agent' }));
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Failed to create agent', 'error'));
  });

  it('loads agent data in edit mode', async () => {
    mockGetAgent.mockResolvedValueOnce({
      agentId: 'a1', name: 'Existing', description: 'Desc', scopes: ['read'],
      redirectUris: ['https://client.example/callback'],
    });
    renderEdit();
    await waitFor(() => expect(screen.getByDisplayValue('Existing')).toBeInTheDocument());
    expect(screen.getByDisplayValue('Desc')).toBeInTheDocument();
    expect(screen.getByText('read')).toBeInTheDocument();
    expect(screen.getByText('Edit Agent')).toBeInTheDocument();
    expect(screen.getByLabelText('Callback 1')).toHaveValue('https://client.example/callback');
  });

  it('updates agent in edit mode', async () => {
    mockGetAgent.mockResolvedValueOnce({
      agentId: 'a1', name: 'Old', description: '', scopes: [],
      redirectUris: ['https://client.example/unchanged'],
    });
    mockUpdateAgent.mockResolvedValueOnce({ agentId: 'a1', name: 'New' });
    const user = userEvent.setup();
    renderEdit();
    await waitFor(() => expect(screen.getByDisplayValue('Old')).toBeInTheDocument());
    await user.clear(screen.getByLabelText('Name'));
    await user.type(screen.getByLabelText('Name'), 'New');
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(mockUpdateAgent).toHaveBeenCalled());
    expect(mockUpdateAgent).toHaveBeenCalledWith('a1', expect.not.objectContaining({ redirectUris: expect.anything() }));
    expect(mockShow).toHaveBeenCalledWith('Agent updated', 'success');
  });

  it('replaces a callback URI on edit', async () => {
    mockGetAgent.mockResolvedValueOnce({
      agentId: 'a1', name: 'Existing', description: '', scopes: [],
      redirectUris: ['https://client.example/old'],
    });
    mockUpdateAgent.mockResolvedValueOnce({ agentId: 'a1', name: 'Existing' });
    const user = userEvent.setup();
    renderEdit();
    await waitFor(() => expect(screen.getByLabelText('Callback 1')).toHaveValue('https://client.example/old'));
    await user.clear(screen.getByLabelText('Callback 1'));
    await user.type(screen.getByLabelText('Callback 1'), 'https://client.example/new');
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(mockUpdateAgent).toHaveBeenCalledWith('a1', expect.objectContaining({
      redirectUris: ['https://client.example/new'],
    })));

  });

  it('clears callback URIs on edit', async () => {
    mockGetAgent.mockResolvedValueOnce({
      agentId: 'a1', name: 'Existing', description: '', scopes: [],
      redirectUris: ['https://client.example/old'],
    });
    mockUpdateAgent.mockResolvedValueOnce({ agentId: 'a1', name: 'Existing' });
    const user = userEvent.setup();
    renderEdit();
    await waitFor(() => expect(screen.getByLabelText('Callback 1')).toHaveValue('https://client.example/old'));
    await user.click(screen.getByRole('button', { name: 'Remove callback 1' }));
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(mockUpdateAgent).toHaveBeenLastCalledWith('a1', expect.objectContaining({ redirectUris: [] })));
  });

  it('rejects duplicate callback URIs before submission', async () => {
    const user = userEvent.setup();
    renderCreate();
    await user.type(screen.getByLabelText('Name'), 'Test Agent');
    await user.click(screen.getByRole('button', { name: 'Add callback URI' }));
    await user.type(screen.getByLabelText('Callback 1'), 'https://client.example/callback');
    await user.click(screen.getByRole('button', { name: 'Add callback URI' }));
    await user.type(screen.getByLabelText('Callback 2'), 'https://client.example/callback');
    await user.click(screen.getByRole('button', { name: 'Create Agent' }));
    expect(mockShow).toHaveBeenCalledWith('Redirect URIs must be unique', 'error');
    expect(mockCreateAgent).not.toHaveBeenCalled();
  });

  it('navigates back on agent not found in edit', async () => {
    mockGetAgent.mockRejectedValueOnce(new Error('not found'));
    renderEdit();
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Agent not found', 'error'));
    expect(mockNavigate).toHaveBeenCalledWith('/dashboard/agents');
  });

  it('adds scopes via Enter key', async () => {
    const user = userEvent.setup();
    renderCreate();
    const scopeInput = screen.getByPlaceholderText('Type a scope and press Enter');
    await user.type(scopeInput, 'read{Enter}');
    expect(screen.getByText('read')).toBeInTheDocument();
  });

  it('has Cancel button', () => {
    renderCreate();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });
});
