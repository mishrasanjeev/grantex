import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PolicyForm } from '../policies/PolicyForm';

const mockCreatePolicy = vi.fn();
const mockGetPolicy = vi.fn();
const mockUpdatePolicy = vi.fn();
const mockShow = vi.fn();
const mockNavigate = vi.fn();

vi.mock('../../api/policies', () => ({
  createPolicy: (...a: unknown[]) => mockCreatePolicy(...a),
  getPolicy: (...a: unknown[]) => mockGetPolicy(...a),
  updatePolicy: (...a: unknown[]) => mockUpdatePolicy(...a),
}));
vi.mock('../../store/toast', () => ({ useToast: () => ({ show: mockShow }) }));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

function renderCreate() {
  return render(
    <MemoryRouter initialEntries={['/dashboard/policies/new']}>
      <Routes><Route path="/dashboard/policies/new" element={<PolicyForm />} /></Routes>
    </MemoryRouter>,
  );
}

function renderEdit() {
  return render(
    <MemoryRouter initialEntries={['/dashboard/policies/p1/edit']}>
      <Routes><Route path="/dashboard/policies/:id/edit" element={<PolicyForm />} /></Routes>
    </MemoryRouter>,
  );
}

describe('PolicyForm', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('renders Create Policy mode', () => {
    renderCreate();
    // "Create Policy" appears as both the page heading and the submit button.
    expect(screen.getByRole('heading', { name: 'Create Policy' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create Policy' })).toBeInTheDocument();
  });

  it('disables submit when name is empty', () => {
    renderCreate();
    expect(screen.getByRole('button', { name: 'Create Policy' })).toBeDisabled();
  });

  it('creates policy on submit', async () => {
    mockCreatePolicy.mockResolvedValueOnce({ id: 'p-new' });
    const user = userEvent.setup();
    renderCreate();
    await user.type(screen.getByLabelText('Name'), 'Test Policy');
    await user.click(screen.getByRole('button', { name: 'Create Policy' }));
    await waitFor(() => expect(mockCreatePolicy).toHaveBeenCalled());
    expect(mockShow).toHaveBeenCalledWith('Policy created', 'success');
    expect(mockNavigate).toHaveBeenCalledWith('/dashboard/policies');
  });

  it('shows error toast on create failure', async () => {
    mockCreatePolicy.mockRejectedValueOnce(new Error('fail'));
    const user = userEvent.setup();
    renderCreate();
    await user.type(screen.getByLabelText('Name'), 'Test');
    await user.click(screen.getByRole('button', { name: 'Create Policy' }));
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Failed to create policy', 'error'));
  });

  it('loads policy data in edit mode', async () => {
    mockGetPolicy.mockResolvedValueOnce({
      id: 'p1', name: 'Existing', effect: 'deny', priority: 5,
      agentId: 'a1', principalId: null, scopes: ['read'],
      timeOfDayStart: '09:00', timeOfDayEnd: '17:00',
    });
    renderEdit();
    await waitFor(() => expect(screen.getByDisplayValue('Existing')).toBeInTheDocument());
    expect(screen.getByText('Edit Policy')).toBeInTheDocument();
    expect(screen.getByText('read')).toBeInTheDocument();
  });

  it('updates policy in edit mode', async () => {
    mockGetPolicy.mockResolvedValueOnce({
      id: 'p1', name: 'Old', effect: 'allow', priority: 0,
      agentId: '', principalId: '', scopes: [], timeOfDayStart: '', timeOfDayEnd: '',
    });
    mockUpdatePolicy.mockResolvedValueOnce({ id: 'p1' });
    const user = userEvent.setup();
    renderEdit();
    await waitFor(() => expect(screen.getByDisplayValue('Old')).toBeInTheDocument());
    await user.clear(screen.getByLabelText('Name'));
    await user.type(screen.getByLabelText('Name'), 'Updated');
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(mockUpdatePolicy).toHaveBeenCalled());
    expect(mockShow).toHaveBeenCalledWith('Policy updated', 'success');
  });

  it('navigates back on policy not found in edit', async () => {
    mockGetPolicy.mockRejectedValueOnce(new Error('not found'));
    renderEdit();
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Policy not found', 'error'));
    expect(mockNavigate).toHaveBeenCalledWith('/dashboard/policies');
  });

  it('has Cancel button', () => {
    renderCreate();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('has effect selector', () => {
    renderCreate();
    expect(screen.getByLabelText('Effect')).toBeInTheDocument();
  });
});
