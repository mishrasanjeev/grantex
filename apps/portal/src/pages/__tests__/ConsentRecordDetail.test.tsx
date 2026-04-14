import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ConsentRecordDetail } from '../dpdp/ConsentRecordDetail';

const mockWithdrawConsent = vi.fn();
const mockShow = vi.fn();

vi.mock('../../api/dpdp', () => ({
  withdrawConsent: (...a: unknown[]) => mockWithdrawConsent(...a),
}));
vi.mock('../../store/toast', () => ({ useToast: () => ({ show: mockShow }) }));

function r() {
  return render(
    <MemoryRouter initialEntries={['/dashboard/dpdp/records/crec-1']}>
      <Routes><Route path="/dashboard/dpdp/records/:recordId" element={<ConsentRecordDetail />} /></Routes>
    </MemoryRouter>,
  );
}

describe('ConsentRecordDetail', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('renders the page with back link', async () => {
    r();
    // Since ConsentRecordDetail doesn't have a direct API fetch and shows a fallback message
    // when record is null (navigated directly without state), we test that fallback
    await waitFor(() => expect(screen.getByText('Go to Consent Records')).toBeInTheDocument());
  });

  it('shows fallback message when record is not available', async () => {
    r();
    await waitFor(() => expect(screen.getByText(/Record details are available when navigating from the consent records list/)).toBeInTheDocument());
  });

  it('shows guidance to search by principal ID', async () => {
    r();
    await waitFor(() => expect(screen.getByText(/Search by Data Principal ID/)).toBeInTheDocument());
  });

  it('has back navigation link', async () => {
    r();
    // Link text is "← Consent Records" in one node, so exact match fails.
    // Regex matches the label; also check by href to prove it's a real link.
    await waitFor(() => expect(screen.getAllByText(/Consent Records/).length).toBeGreaterThan(0));
    expect(document.querySelector('a[href="/dashboard/dpdp/records"]')).toBeTruthy();
  });
});
