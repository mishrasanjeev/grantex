import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { CommerceAudit } from '../commerce/CommerceAudit';
import { CommercePassports } from '../commerce/CommercePassports';
import { CommercePayments } from '../commerce/CommercePayments';
import { CommerceOps } from '../commerce/CommerceOps';
import { CommercePlayground } from '../commerce/CommercePlayground';
import { CommerceSettings } from '../commerce/CommerceSettings';

const mockListCommercePaymentIntents = vi.fn();
const mockReconcileCommercePaymentIntent = vi.fn();
const mockListCommerceAuditEvents = vi.fn();
const mockListCommercePassports = vi.fn();
const mockRevokeCommercePassport = vi.fn();
const mockGetCommerceMerchant = vi.fn();
const mockDisableMerchantAgenticCommerce = vi.fn();
const mockListCommerceProviderCredentials = vi.fn();
const mockValidateCommerceProviderCredential = vi.fn();
const mockGetCommerceOpsHealth = vi.fn();
const mockListCommerceProviderWebhookEvents = vi.fn();
const mockGetCommerceWellKnownProfile = vi.fn();
const mockShow = vi.fn();

vi.mock('../../api/commerce', () => ({
  listCommercePaymentIntents: (...a: unknown[]) => mockListCommercePaymentIntents(...a),
  reconcileCommercePaymentIntent: (...a: unknown[]) => mockReconcileCommercePaymentIntent(...a),
  listCommerceAuditEvents: (...a: unknown[]) => mockListCommerceAuditEvents(...a),
  listCommercePassports: (...a: unknown[]) => mockListCommercePassports(...a),
  revokeCommercePassport: (...a: unknown[]) => mockRevokeCommercePassport(...a),
  getCommerceMerchant: (...a: unknown[]) => mockGetCommerceMerchant(...a),
  disableMerchantAgenticCommerce: (...a: unknown[]) => mockDisableMerchantAgenticCommerce(...a),
  listCommerceProviderCredentials: (...a: unknown[]) => mockListCommerceProviderCredentials(...a),
  validateCommerceProviderCredential: (...a: unknown[]) => mockValidateCommerceProviderCredential(...a),
  getCommerceOpsHealth: (...a: unknown[]) => mockGetCommerceOpsHealth(...a),
  listCommerceProviderWebhookEvents: (...a: unknown[]) => mockListCommerceProviderWebhookEvents(...a),
  getCommerceWellKnownProfile: (...a: unknown[]) => mockGetCommerceWellKnownProfile(...a),
}));
vi.mock('../../store/toast', () => ({ useToast: () => ({ show: mockShow }) }));

function r(ui: ReactNode) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

const payment = {
  id: 'cpi_pending',
  tenant_id: 'cten_1',
  merchant_id: 'mch_1',
  agent_id: 'cag_1',
  cart_id: 'cart_1',
  passport_jti: 'cpsp_1',
  amount: 1299,
  amount_minor_units: 1299,
  currency: 'INR',
  provider: 'mock' as const,
  provider_environment: 'sandbox' as const,
  provider_payment_id: 'mock_pay_1',
  provider_order_id: null,
  checkout_url: null,
  checkout_expires_at: null,
  status: 'payment_pending' as const,
  policy_version: 'v1',
  decision_id: 'cpdec_1',
  provider_raw_status: 'pending',
  idempotency_key_hash: 'idem_hash_1',
  reconciled_at: null,
  last_reconciliation_attempt_at: null,
  last_reconciliation_error: null,
  last_reconciliation_retryable: null,
  expires_at: '2026-01-01T00:15:00Z',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:01:00Z',
};

const auditEvent = {
  id: 'caud_1',
  tenant_id: 'cten_1',
  merchant_id: 'mch_1',
  agent_id: 'cag_1',
  user_principal_id: null,
  event_type: 'payment_intent.created',
  resource_type: 'commerce_payment_intent',
  resource_id: 'cpi_pending',
  passport_jti: 'cpsp_1',
  policy_version: 'v1',
  decision_id: 'cpdec_1',
  idempotency_key_hash: 'idem_hash_1',
  request_id: 'req_1',
  occurred_at: '2026-01-01T00:00:00Z',
  metadata: { payment_intent_id: 'cpi_pending' },
};

const checkoutPassport = {
  jti: 'cpsp_checkout',
  tenant_id: 'cten_1',
  merchant_id: 'mch_1',
  agent_id: 'cag_1',
  passport_type: 'checkout' as const,
  subject: 'agent:cag_1',
  scopes: ['commerce:payment.initiate'],
  max_amount: 5000,
  currency: 'INR',
  environment: 'sandbox' as const,
  issued_at: '2026-01-01T00:00:00Z',
  expires_at: '2026-01-01T00:10:00Z',
  revoked: false,
  revocation_reason: null,
  passport_jwt: 'raw-passport-token-must-not-render',
};

const browsePassport = {
  ...checkoutPassport,
  jti: 'cpsp_browse',
  passport_type: 'browse' as const,
  scopes: ['commerce:catalog.search'],
  revoked: true,
  revocation_reason: 'operator',
};

const merchant = {
  id: 'mch_1',
  tenant_id: 'cten_1',
  legal_name: 'Grantex Commerce Pvt Ltd',
  display_name: 'Grantex Store',
  category_preset: 'software',
  verification_status: 'verified',
  environment: 'sandbox' as const,
  agentic_commerce_enabled: true,
  default_currency: 'INR',
  country_code: 'IN',
  support_email: 'ops@example.test',
  disabled_at: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

const credential = {
  id: 'cpcred_1',
  tenant_id: 'cten_1',
  merchant_id: 'mch_1',
  provider_key: 'mock' as const,
  environment: 'sandbox' as const,
  credential_ref: 'mock_ref_1',
  secret_version: 1,
  status: 'valid' as const,
  last_validated_at: '2026-01-01T00:00:00Z',
  last_validation_error: null,
  capabilities: ['payment_intents'],
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  rotated_at: null,
  encrypted_secret_blob: 'encrypted-secret-must-not-render',
};

const health = {
  status: 'degraded' as const,
  checked_at: '2026-01-01T00:00:00Z',
  tenant_id: 'cten_1',
  merchant_id: 'mch_1',
  environment: 'sandbox' as const,
  checks: {
    api: { ok: true },
    database: { ok: true },
    provider_adapters: {
      mock: { ok: true, status: 'healthy' },
      plural: { ok: false, status: 'blocked' },
    },
    reconciliation_worker: { ok: true },
    webhook_backlog: { backlog_count: 1, recent_failure_count: 0 },
  },
  blockers: ['plural_signature_scheme_unconfirmed', 'live_payments_disabled'],
};

const failedWebhookEvent = {
  id: 'cwh_failed',
  tenant_id: 'cten_1',
  provider_key: 'mock' as const,
  merchant_id: 'mch_1',
  payment_intent_id: 'cpi_pending',
  provider_payment_id: 'mock_pay_1',
  provider_event_id: 'evt_failed',
  provider_event_type: 'payment.updated',
  signature_validation_status: 'valid' as const,
  replay_status: 'fresh' as const,
  processing_status: 'failed' as const,
  payload_hash: 'hash_safe',
  error_code: 'invalid_payment_status_transition',
  error_message: 'safe error',
  attempt_count: 1,
  received_at: '2026-01-01T00:02:00Z',
  processed_at: null,
  updated_at: '2026-01-01T00:03:00Z',
  replay_available: false,
  replay_blocker: 'webhook_failed_event_replay_requires_safe_raw_payload_storage',
  raw_payload_ref: 'raw-payload-ref-must-not-render',
  raw_signature: 'signature-must-not-render',
};

describe('CommercePayments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListCommercePaymentIntents.mockResolvedValue({ items: [payment], next_cursor: null });
    mockReconcileCommercePaymentIntent.mockResolvedValue({ data: { ...payment, status: 'paid' }, reconciliation: {} });
  });

  it('lists payment intents and exposes manual reconcile for pending payments', async () => {
    const user = userEvent.setup();
    r(<CommercePayments />);
    await waitFor(() => expect(screen.getByText('cpi_pending')).toBeInTheDocument());
    expect(screen.getByText('Live payments and Plural remain blocked')).toBeInTheDocument();
    expect(screen.getAllByText('payment_pending').length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: 'Reconcile' }));
    await waitFor(() => expect(mockReconcileCommercePaymentIntent).toHaveBeenCalledWith('cpi_pending'));
    expect(mockShow).toHaveBeenCalledWith('Payment reconciliation completed', 'success');
  });

  it('shows empty and error states', async () => {
    mockListCommercePaymentIntents.mockResolvedValueOnce({ items: [], next_cursor: null });
    r(<CommercePayments />);
    await waitFor(() => expect(screen.getByText('No payment intents')).toBeInTheDocument());

    mockListCommercePaymentIntents.mockRejectedValueOnce(new Error('fail'));
    r(<CommercePayments />);
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Failed to load commerce payments', 'error'));
  });
});

describe('CommerceOps', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCommerceOpsHealth.mockResolvedValue(health);
    mockListCommercePaymentIntents.mockResolvedValue({ items: [payment], next_cursor: null });
    mockListCommerceProviderWebhookEvents.mockResolvedValue({
      items: [failedWebhookEvent],
      next_cursor: null,
      replay_available: false,
      replay_blocker: 'webhook_failed_event_replay_requires_safe_raw_payload_storage',
    });
    mockReconcileCommercePaymentIntent.mockResolvedValue({ data: { ...payment, status: 'paid' }, reconciliation: {} });
  });

  it('shows SLA readiness, stuck payments, and failed webhook metadata without raw payloads', async () => {
    const user = userEvent.setup();
    r(<CommerceOps />);
    await waitFor(() => expect(screen.getByText('Payment intent create')).toBeInTheDocument());
    expect(screen.getByText('10 RPS, p95 < 500 ms')).toBeInTheDocument();
    expect(screen.getByText('measured')).toBeInTheDocument();
    expect(screen.getByText('passing')).toBeInTheDocument();
    expect(screen.getAllByText('not-yet-measured').length).toBeGreaterThan(0);
    expect(screen.getByText('Plural live readiness')).toBeInTheDocument();
    expect(screen.getAllByText('cpi_pending').length).toBeGreaterThan(0);
    expect(screen.getByText('evt_failed')).toBeInTheDocument();
    expect(screen.getByText('Replay blocked')).toBeInTheDocument();
    expect(screen.queryByText('raw-payload-ref-must-not-render')).not.toBeInTheDocument();
    expect(screen.queryByText('signature-must-not-render')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reconcile' }));
    await waitFor(() => expect(mockReconcileCommercePaymentIntent).toHaveBeenCalledWith('cpi_pending'));
  });

  it('supports empty and error states', async () => {
    mockListCommercePaymentIntents.mockResolvedValueOnce({ items: [], next_cursor: null });
    mockListCommerceProviderWebhookEvents.mockResolvedValueOnce({
      items: [],
      next_cursor: null,
      replay_available: false,
      replay_blocker: 'blocked',
    });
    r(<CommerceOps />);
    await waitFor(() => expect(screen.getByText('No stuck pending payments')).toBeInTheDocument());
    expect(screen.getByText('No failed webhook events')).toBeInTheDocument();

    mockGetCommerceOpsHealth.mockRejectedValueOnce(new Error('fail'));
    r(<CommerceOps />);
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Failed to load commerce operations readiness', 'error'));
  });
});

describe('CommerceAudit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListCommerceAuditEvents.mockResolvedValue({ items: [auditEvent], next_cursor: null });
  });

  it('shows read-only commerce audit events and filters by payment intent evidence', async () => {
    const user = userEvent.setup();
    r(<CommerceAudit />);
    await waitFor(() => expect(screen.getByText('payment_intent.created')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /revoke|disable|delete/i })).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Payment intent search'), 'missing');
    expect(screen.getByText('No commerce audit events')).toBeInTheDocument();
  });

  it('shows an error toast when audit loading fails', async () => {
    mockListCommerceAuditEvents.mockRejectedValueOnce(new Error('fail'));
    r(<CommerceAudit />);
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith('Failed to load commerce audit events', 'error'));
  });
});

describe('CommercePassports', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListCommercePassports.mockResolvedValue({ items: [checkoutPassport, browsePassport], next_cursor: null });
    mockRevokeCommercePassport.mockResolvedValue({
      data: { jti: 'cpsp_checkout', revoked: true, reason: 'dashboard_emergency_review' },
      audit_event_id: 'aud_1',
    });
  });

  it('distinguishes browse and checkout passports without rendering raw tokens', async () => {
    r(<CommercePassports />);
    await waitFor(() => expect(screen.getByText('cpsp_checkout')).toBeInTheDocument());
    expect(screen.getByText('checkout')).toBeInTheDocument();
    expect(screen.getByText('browse')).toBeInTheDocument();
    expect(screen.queryByText('raw-passport-token-must-not-render')).not.toBeInTheDocument();
  });

  it('confirms and revokes an active passport through the API', async () => {
    const user = userEvent.setup();
    r(<CommercePassports />);
    await waitFor(() => expect(screen.getByText('cpsp_checkout')).toBeInTheDocument());
    await user.click(screen.getAllByRole('button', { name: 'Revoke' })[0]!);
    const revokeButtons = screen.getAllByRole('button', { name: 'Revoke' });
    await user.click(revokeButtons[revokeButtons.length - 1]!);
    await waitFor(() => expect(mockRevokeCommercePassport).toHaveBeenCalledWith({
      jti: 'cpsp_checkout',
      reason: 'dashboard_emergency_review',
    }));
  });
});

describe('CommerceSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCommerceMerchant.mockResolvedValue({ data: merchant });
    mockListCommerceProviderCredentials.mockResolvedValue({ items: [credential], next_cursor: null });
    mockGetCommerceOpsHealth.mockResolvedValue(health);
    mockDisableMerchantAgenticCommerce.mockResolvedValue({
      data: { merchant_id: 'mch_1', agentic_commerce_enabled: false, disabled: true },
      audit_event_id: 'aud_1',
    });
    mockValidateCommerceProviderCredential.mockResolvedValue({ data: credential, audit_event_id: 'aud_2' });
  });

  it('loads merchant settings, provider status, and redacted credential metadata', async () => {
    const user = userEvent.setup();
    r(<CommerceSettings />);
    await user.type(screen.getByLabelText('Merchant ID'), 'mch_1');
    await user.click(screen.getByRole('button', { name: 'Load settings' }));
    await waitFor(() => expect(screen.getByText('Grantex Store')).toBeInTheDocument());
    expect(screen.getByText('cpcred_1')).toBeInTheDocument();
    expect(screen.getByText('blocked')).toBeInTheDocument();
    expect(screen.getByText('live_payments_disabled')).toBeInTheDocument();
    expect(screen.queryByText('encrypted-secret-must-not-render')).not.toBeInTheDocument();
  });

  it('validates credentials and confirms emergency disable', async () => {
    const user = userEvent.setup();
    r(<CommerceSettings />);
    await user.type(screen.getByLabelText('Merchant ID'), 'mch_1');
    await user.click(screen.getByRole('button', { name: 'Load settings' }));
    await waitFor(() => expect(screen.getByText('cpcred_1')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Validate' }));
    await waitFor(() => expect(mockValidateCommerceProviderCredential).toHaveBeenCalledWith('cpcred_1'));
    await user.click(screen.getByRole('button', { name: 'Emergency disable' }));
    await user.click(screen.getByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(mockDisableMerchantAgenticCommerce).toHaveBeenCalledWith('mch_1', 'dashboard_emergency_disable'));
  });
});

describe('CommercePlayground', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCommerceWellKnownProfile.mockResolvedValue({
      version: '1.0.0',
      merchant: {
        merchant_id: 'mch_1',
        display_name: 'Grantex Store',
        legal_name: 'Grantex Commerce Pvt Ltd',
        environment: 'sandbox',
        capabilities: ['catalog.search'],
      },
      environment: 'sandbox',
      supported_tools: ['merchant.get_profile', 'catalog.search', 'payment.get_status'],
      capabilities: ['mcp_json_rpc_http'],
    });
  });

  it('loads the well-known profile and links to the static playground without certification claims', async () => {
    const user = userEvent.setup();
    r(<CommercePlayground />);
    await user.type(screen.getByLabelText('Merchant selector'), 'mch_1');
    await user.click(screen.getByRole('button', { name: 'Fetch' }));
    await waitFor(() => expect(mockGetCommerceWellKnownProfile).toHaveBeenCalledWith('mch_1'));
    expect(screen.getByText('catalog.search')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open static playground' })).toHaveAttribute('href', '/commerce-playground.html');
    expect(screen.getByText(/out of browser storage/i)).toBeInTheDocument();
    expect(screen.queryByText(/certified|certification/i)).not.toBeInTheDocument();
  });
});
