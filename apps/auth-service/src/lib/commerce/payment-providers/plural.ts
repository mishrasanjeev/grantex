import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  providerError,
  type CommerceEnvironment,
  type NormalizedProviderError,
  type PaymentProvider,
  type ProviderErrorCode,
} from './types.js';
import { sha256hex } from '../../hash.js';

const PLURAL_WEBHOOK_REPLAY_WINDOW_SECONDS = 300;
const TOKEN_REFRESH_SKEW_MS = 60_000;
const DEFAULT_TOKEN_TTL_MS = 3_000_000;
const PLURAL_SANDBOX_BASE_URL = 'https://pluraluat.v2.pinepg.in/api';
const PLURAL_LIVE_BASE_URL = 'https://api.pluralpay.in/api';
const ALL_PAYMENT_METHODS = [
  'CARD',
  'UPI',
  'NETBANKING',
  'WALLET',
  'CREDIT_EMI',
  'DEBIT_EMI',
] as const;

interface PluralConfig {
  environment: CommerceEnvironment;
  provider_environment: 'sandbox' | 'production';
  base_url: string;
  client_id: string;
  client_secret: string;
  webhook_secret?: string;
}

interface PluralTokenCache {
  cache_key: string;
  access_token: string;
  expires_at_ms: number;
}

interface PluralTokenResponse {
  access_token?: unknown;
  expires_at?: unknown;
  expires_in?: unknown;
}

interface PluralCheckoutResponse {
  order_id?: unknown;
  redirect_url?: unknown;
  status?: unknown;
}

interface PluralStatusResponse {
  data?: unknown;
  order_id?: unknown;
  merchant_order_reference?: unknown;
  status?: unknown;
  order_amount?: unknown;
  payments?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
}

interface PluralApiErrorOptions {
  status?: number;
  provider_error_code?: string;
  provider_request_id?: string;
  safe_metadata?: Record<string, unknown>;
  cause?: unknown;
}

class PluralApiError extends Error {
  readonly status?: number;
  readonly provider_error_code?: string;
  readonly provider_request_id?: string;
  readonly safe_metadata?: Record<string, unknown>;

  constructor(message: string, options: PluralApiErrorOptions = {}) {
    super(message);
    this.name = 'PluralApiError';
    if (options.status !== undefined) this.status = options.status;
    if (options.provider_error_code !== undefined) this.provider_error_code = options.provider_error_code;
    if (options.provider_request_id !== undefined) this.provider_request_id = options.provider_request_id;
    if (options.safe_metadata !== undefined) this.safe_metadata = options.safe_metadata;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

let tokenCache: PluralTokenCache | null = null;

function nowIso(): string {
  return new Date().toISOString();
}

function envValue(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return '';
}

function blockedError(environment: CommerceEnvironment): NormalizedProviderError {
  const commerceLiveDisabled = environment === 'live' && process.env['COMMERCE_LIVE_MODE_ENABLED'] !== 'true';
  const pluralLiveDisabled = environment === 'live' && process.env['PLURAL_LIVE_ENABLED'] !== 'true';
  const sandboxBlocked = environment === 'sandbox' && process.env['PLURAL_SANDBOX_ENABLED'] !== 'true';
  const providerErrorCode = commerceLiveDisabled
    ? 'commerce_live_mode_disabled'
    : pluralLiveDisabled
    ? 'plural_live_disabled'
    : sandboxBlocked
      ? 'plural_sandbox_blocked'
      : 'plural_provider_disabled';
  return {
    code: 'provider_validation_failed',
    message: commerceLiveDisabled
      ? 'Commerce live mode is disabled pending legal, partner, and production readiness review'
      : pluralLiveDisabled
        ? 'Plural live mode is disabled pending legal, partner, and production readiness review'
      : sandboxBlocked
        ? 'Plural sandbox mode is disabled pending integration confirmation'
        : 'Plural provider is disabled in this deployment',
    retryable: false,
    provider_key: 'plural',
    provider_error_code: providerErrorCode,
    safe_metadata: {
      environment,
      blocker: providerErrorCode,
      api_contract_confirmed: true,
      webhook_signature_confirmed: true,
      integration_mode: 'hosted_checkout',
    },
  };
}

function invalidCredentialsError(
  environment: CommerceEnvironment,
  missingEnvVars: string[],
): NormalizedProviderError {
  return {
    code: 'invalid_provider_credentials',
    message: 'Plural credentials are not configured for this deployment',
    retryable: false,
    provider_key: 'plural',
    provider_error_code: 'plural_credentials_missing',
    safe_metadata: {
      environment,
      missing_env_vars: missingEnvVars,
      integration_mode: 'hosted_checkout',
    },
  };
}

function assertProviderEnabled(environment: CommerceEnvironment): void {
  if (environment === 'live'
    && (process.env['COMMERCE_LIVE_MODE_ENABLED'] !== 'true'
      || process.env['PLURAL_LIVE_ENABLED'] !== 'true')) {
    throw providerError(blockedError(environment));
  }
  if (environment === 'sandbox' && process.env['PLURAL_SANDBOX_ENABLED'] !== 'true') {
    throw providerError(blockedError(environment));
  }
}

function getPluralConfig(environment: CommerceEnvironment, opts: { webhook?: boolean } = {}): PluralConfig {
  assertProviderEnabled(environment);
  const clientId = envValue('PLURAL_PINE_CLIENT_ID', 'PLURAL_CLIENT_ID');
  const clientSecret = envValue('PLURAL_PINE_CLIENT_SECRET', 'PLURAL_CLIENT_SECRET');
  const missing: string[] = [];
  if (!clientId) missing.push('PLURAL_PINE_CLIENT_ID');
  if (!clientSecret) missing.push('PLURAL_PINE_CLIENT_SECRET');

  const webhookSecret = envValue('PLURAL_WEBHOOK_SECRET', 'PLURAL_PINE_WEBHOOK_SECRET');
  if (opts.webhook && !webhookSecret) missing.push('PLURAL_WEBHOOK_SECRET');
  if (missing.length > 0) {
    throw providerError(invalidCredentialsError(environment, missing));
  }

  const baseUrl = envValue('PLURAL_PINE_BASE_URL', 'PLURAL_BASE_URL')
    || (environment === 'live' ? PLURAL_LIVE_BASE_URL : PLURAL_SANDBOX_BASE_URL);
  const config: PluralConfig = {
    environment,
    provider_environment: environment === 'live' ? 'production' : 'sandbox',
    base_url: baseUrl.replace(/\/+$/, ''),
    client_id: clientId,
    client_secret: clientSecret,
  };
  if (webhookSecret) config.webhook_secret = webhookSecret;
  return config;
}

function tokenCacheKey(config: PluralConfig): string {
  return `${config.base_url}|${config.client_id}`;
}

function parseTokenExpiry(data: PluralTokenResponse): number {
  if (typeof data.expires_at === 'string' && data.expires_at.trim()) {
    const parsed = Date.parse(data.expires_at);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (typeof data.expires_in === 'number' && Number.isFinite(data.expires_in)) {
    return Date.now() + Math.max(1, data.expires_in) * 1000;
  }
  if (typeof data.expires_in === 'string' && /^\d+$/.test(data.expires_in)) {
    return Date.now() + Number.parseInt(data.expires_in, 10) * 1000;
  }
  return Date.now() + DEFAULT_TOKEN_TTL_MS;
}

function requestTimestamp(): string {
  return new Date().toISOString();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function pluralStatusBody(value: PluralStatusResponse): Record<string, unknown> {
  if (value.data && typeof value.data === 'object' && !Array.isArray(value.data)) {
    return value.data as Record<string, unknown>;
  }
  return value as Record<string, unknown>;
}

function providerRequestId(response: Response): string | undefined {
  return response.headers.get('request-id')
    ?? response.headers.get('x-request-id')
    ?? response.headers.get('x-correlation-id')
    ?? undefined;
}

async function safeResponseMetadata(response: Response): Promise<Record<string, unknown>> {
  const metadata: Record<string, unknown> = { http_status: response.status };
  try {
    const data = await response.clone().json() as unknown;
    const obj = objectValue(data);
    const code = stringValue(obj['error_code']) ?? stringValue(obj['code']);
    const message = stringValue(obj['message']) ?? stringValue(obj['error']);
    if (code) metadata.provider_error_code = code;
    if (message) metadata.provider_error_message_hash = sha256hex(message);
  } catch {
    // Non-JSON provider errors are intentionally reduced to status metadata.
  }
  return metadata;
}

async function readJson<T>(response: Response, defaultValue: T): Promise<T> {
  try {
    return await response.json() as T;
  } catch (err) {
    const requestId = providerRequestId(response);
    throw new PluralApiError('Plural provider returned an invalid JSON response', {
      status: response.status,
      provider_error_code: 'plural_invalid_json',
      cause: err,
      ...(requestId ? { provider_request_id: requestId } : {}),
    });
  }
}

async function pluralFetchJson<T>(
  config: PluralConfig,
  path: string,
  init: {
    method: 'GET' | 'POST';
    body?: Record<string, unknown>;
    accessToken?: string;
  },
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Request-Timestamp': requestTimestamp(),
    'Request-ID': randomUUID(),
  };
  if (init.accessToken) {
    headers.Authorization = `Bearer ${init.accessToken}`;
  }

  let response: Response;
  try {
    response = await fetch(`${config.base_url}${path}`, {
      method: init.method,
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    const name = err && typeof err === 'object' && 'name' in err ? String((err as { name: unknown }).name) : '';
    throw new PluralApiError(
      name === 'TimeoutError' ? 'Plural provider request timed out' : 'Plural provider is unavailable',
      {
        provider_error_code: name === 'TimeoutError' ? 'plural_timeout' : 'plural_fetch_failed',
        cause: err,
      },
    );
  }

  if (!response.ok) {
    const metadata = await safeResponseMetadata(response);
    const requestId = providerRequestId(response);
    throw new PluralApiError('Plural provider returned an error response', {
      status: response.status,
      provider_error_code: stringValue(metadata.provider_error_code) ?? `plural_http_${response.status}`,
      safe_metadata: metadata,
      ...(requestId ? { provider_request_id: requestId } : {}),
    });
  }

  return readJson<T>(response, {} as T);
}

async function getAccessToken(config: PluralConfig): Promise<string> {
  const cacheKey = tokenCacheKey(config);
  if (tokenCache?.cache_key === cacheKey && tokenCache.expires_at_ms > Date.now() + TOKEN_REFRESH_SKEW_MS) {
    return tokenCache.access_token;
  }

  const data = await pluralFetchJson<PluralTokenResponse>(config, '/auth/v1/token', {
    method: 'POST',
    body: {
      client_id: config.client_id,
      client_secret: config.client_secret,
      grant_type: 'client_credentials',
    },
  });
  const accessToken = stringValue(data.access_token);
  if (!accessToken) {
    throw new PluralApiError('Plural token response did not include an access token', {
      provider_error_code: 'plural_token_missing',
    });
  }

  tokenCache = {
    cache_key: cacheKey,
    access_token: accessToken,
    expires_at_ms: parseTokenExpiry(data),
  };
  return accessToken;
}

async function authedPluralFetchJson<T>(
  config: PluralConfig,
  path: string,
  init: { method: 'GET' | 'POST'; body?: Record<string, unknown> },
): Promise<T> {
  const accessToken = await getAccessToken(config);
  return pluralFetchJson<T>(config, path, { ...init, accessToken });
}

function merchantOrderReference(paymentIntentId: string): string {
  const cleaned = paymentIntentId.replace(/[^A-Za-z0-9_-]/g, '_');
  if (cleaned.length >= 8 && cleaned.length <= 50) return cleaned;
  const digest = sha256hex(paymentIntentId).slice(0, 16);
  if (cleaned.length > 50) return `${cleaned.slice(0, 33)}_${digest}`;
  return `cpi_${digest}`;
}

function mapPluralStatus(rawStatus: string): 'payment_pending' | 'paid' | 'failed' | 'expired' | 'cancelled' {
  const status = rawStatus.toUpperCase();
  if (['PROCESSED', 'AUTHORIZED', 'CAPTURED', 'PAID', 'SUCCESS', 'SUCCEEDED'].includes(status)) return 'paid';
  if (['FAILED', 'DECLINED'].includes(status)) return 'failed';
  if (status === 'EXPIRED') return 'expired';
  if (status === 'CANCELLED' || status === 'CANCELED') return 'cancelled';
  return 'payment_pending';
}

function statusEventType(rawStatus: string): string {
  const status = mapPluralStatus(rawStatus);
  if (status === 'paid') return 'payment.paid';
  if (status === 'failed') return 'payment.failed';
  if (status === 'expired') return 'payment.expired';
  return 'payment.updated';
}

function normalizePluralApiError(error: PluralApiError): NormalizedProviderError {
  const status = error.status;
  let code: ProviderErrorCode = 'unknown_provider_error';
  let message = 'Plural provider returned an unknown error';
  let retryable = false;

  if (status === 401 || status === 403) {
    code = 'invalid_provider_credentials';
    message = 'Plural provider rejected the configured credentials';
  } else if (status === 408 || error.provider_error_code === 'plural_timeout') {
    code = 'provider_timeout';
    message = 'Plural provider request timed out';
    retryable = true;
  } else if (status === 429) {
    code = 'provider_rate_limited';
    message = 'Plural provider rate limited the request';
    retryable = true;
  } else if (status !== undefined && status >= 500) {
    code = 'provider_unavailable';
    message = 'Plural provider is unavailable';
    retryable = true;
  } else if (error.provider_error_code === 'plural_fetch_failed') {
    code = 'provider_unavailable';
    message = 'Plural provider is unavailable';
    retryable = true;
  } else if (error.provider_error_code === 'plural_token_missing' || error.provider_error_code === 'plural_invalid_json') {
    code = 'provider_validation_failed';
    message = error.message;
  }

  return {
    code,
    message,
    retryable,
    provider_key: 'plural',
    ...(error.provider_error_code ? { provider_error_code: error.provider_error_code } : {}),
    ...(error.provider_request_id ? { provider_request_id: error.provider_request_id } : {}),
    ...(error.safe_metadata ? { safe_metadata: error.safe_metadata } : {}),
  };
}

function normalizeUnknownError(error: unknown): NormalizedProviderError {
  if (error && typeof error === 'object' && 'normalized' in error) {
    return (error as { normalized: NormalizedProviderError }).normalized;
  }
  if (error instanceof PluralApiError) {
    return normalizePluralApiError(error);
  }
  return {
    code: 'unknown_provider_error',
    message: 'Plural provider returned an unknown error',
    retryable: false,
    provider_key: 'plural',
    provider_error_code: 'plural_unknown_error',
  };
}

function decodeWebhookSecret(secret: string): Buffer | null {
  try {
    const decoded = Buffer.from(secret, 'base64');
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

function pluralWebhookSignatureMatches(
  rawBody: string,
  webhookId: string,
  webhookTimestamp: string,
  webhookSignature: string,
  webhookSecret: string,
): boolean {
  const secretBytes = decodeWebhookSecret(webhookSecret);
  if (!secretBytes) return false;
  const signedContent = Buffer.concat([
    Buffer.from(`${webhookId}.${webhookTimestamp}.`, 'utf8'),
    Buffer.from(rawBody, 'utf8'),
  ]);
  const expected = createHmac('sha256', secretBytes).update(signedContent).digest();
  const signatures = webhookSignature.split(/\s+/).filter(Boolean);
  for (const sig of signatures) {
    const value = sig.startsWith('v1,') ? sig.slice(3) : sig;
    let actual: Buffer;
    try {
      actual = Buffer.from(value, 'base64');
    } catch {
      continue;
    }
    if (actual.length === expected.length && timingSafeEqual(actual, expected)) return true;
  }
  return false;
}

function parsePluralWebhookPayload(rawBody: string): Record<string, unknown> {
  const parsed = JSON.parse(rawBody) as unknown;
  return objectValue(parsed);
}

function normalizedWebhookError(
  code: 'webhook_signature_invalid' | 'webhook_replay_detected',
  providerErrorCode: string,
  message: string,
): NormalizedProviderError {
  return {
    code,
    message,
    retryable: false,
    provider_key: 'plural',
    provider_error_code: providerErrorCode,
    safe_metadata: {
      signature_scheme: 'plural-hmac-sha256-v1',
    },
  };
}

export class PluralPaymentProvider implements PaymentProvider {
  public readonly providerKey = 'plural' as const;

  async healthCheck(input: {
    tenant_id: string;
    merchant_id: string;
    environment: CommerceEnvironment;
  }): Promise<{
    ok: boolean;
    status: 'healthy' | 'degraded' | 'down';
    checked_at: string;
    details: Record<string, unknown>;
  }> {
    try {
      const config = getPluralConfig(input.environment);
      await getAccessToken(config);
      return {
        ok: true,
        status: 'healthy',
        checked_at: nowIso(),
        details: {
          provider_environment: config.provider_environment,
          integration_mode: 'hosted_checkout',
          capabilities: ['payment_intent.prepare', 'checkout_link.create', 'payment_status.read'],
        },
      };
    } catch (err) {
      const normalized = this.normalizeError(err);
      return {
        ok: false,
        status: normalized.retryable ? 'degraded' : 'down',
        checked_at: nowIso(),
        details: normalized.safe_metadata ?? {
          provider_error_code: normalized.provider_error_code,
        },
      };
    }
  }

  async validateCredentials(input: {
    tenant_id: string;
    merchant_id: string;
    environment: CommerceEnvironment;
    credential_ref: string;
  }): Promise<{
    valid: boolean;
    merchant_account_ref?: string;
    capabilities: string[];
    checked_at: string;
    error?: NormalizedProviderError;
  }> {
    try {
      const config = getPluralConfig(input.environment);
      await getAccessToken(config);
      return {
        valid: true,
        merchant_account_ref: `plural_${config.provider_environment}_${input.merchant_id}`,
        capabilities: ['payment_intent.prepare', 'checkout_link.create', 'payment_status.read', 'webhook.verify'],
        checked_at: nowIso(),
      };
    } catch (err) {
      return {
        valid: false,
        capabilities: [],
        checked_at: nowIso(),
        error: this.normalizeError(err),
      };
    }
  }

  async createPaymentIntent(input: {
    tenant_id: string;
    merchant_id: string;
    agent_id: string;
    payment_intent_id: string;
    cart_id: string;
    passport_jti: string;
    amount: { amount_minor_units: number; currency: string };
    line_items_snapshot: unknown[];
    idempotency_key: string;
    environment: CommerceEnvironment;
    metadata: Record<string, string>;
  }): Promise<{
    provider_payment_id: string;
    status: 'authorized';
    raw_status: string;
    provider_metadata: Record<string, unknown>;
  }> {
    const config = getPluralConfig(input.environment);
    const merchantRef = merchantOrderReference(input.payment_intent_id);
    return {
      provider_payment_id: merchantRef,
      status: 'authorized',
      raw_status: 'plural_ready_for_checkout',
      provider_metadata: {
        provider_environment: config.provider_environment,
        integration_mode: 'hosted_checkout',
        merchant_order_reference: merchantRef,
        amount_minor_units: input.amount.amount_minor_units,
        currency: input.amount.currency,
        idempotency_key_hash: sha256hex(input.idempotency_key),
      },
    };
  }

  async createCheckoutLink(input: {
    tenant_id: string;
    merchant_id: string;
    payment_intent_id: string;
    provider_payment_id: string;
    provider_order_id?: string | null;
    provider_metadata?: Record<string, unknown>;
    amount: { amount_minor_units: number; currency: string };
    environment: CommerceEnvironment;
    success_url: string;
    cancel_url: string;
    expires_at: string;
    idempotency_key: string;
  }): Promise<{
    checkout_url: string;
    expires_at: string;
    raw_status: string;
    provider_order_id?: string;
    provider_metadata: Record<string, unknown>;
  }> {
    const config = getPluralConfig(input.environment);
    const merchantRef = input.provider_payment_id || merchantOrderReference(input.payment_intent_id);
    const response = await authedPluralFetchJson<PluralCheckoutResponse>(config, '/checkout/v1/orders', {
      method: 'POST',
      body: {
        merchant_order_reference: merchantRef,
        order_amount: {
          value: input.amount.amount_minor_units,
          currency: input.amount.currency,
        },
        pre_auth: false,
        allowed_payment_methods: [...ALL_PAYMENT_METHODS],
        callback_url: input.success_url,
        failure_callback_url: input.cancel_url,
      },
    });

    const orderId = stringValue(response.order_id);
    const redirectUrl = stringValue(response.redirect_url);
    const rawStatus = stringValue(response.status) ?? 'CREATED';
    if (!orderId || !redirectUrl) {
      throw providerError({
        code: 'provider_validation_failed',
        message: 'Plural checkout response did not include an order id and redirect URL',
        retryable: false,
        provider_key: 'plural',
        provider_error_code: 'plural_checkout_response_incomplete',
        safe_metadata: {
          provider_environment: config.provider_environment,
          response_has_order_id: Boolean(orderId),
          response_has_redirect_url: Boolean(redirectUrl),
        },
      });
    }

    return {
      checkout_url: redirectUrl,
      expires_at: input.expires_at,
      raw_status: rawStatus,
      provider_order_id: orderId,
      provider_metadata: {
        provider_environment: config.provider_environment,
        integration_mode: 'hosted_checkout',
        plural_order_id: orderId,
        merchant_order_reference: merchantRef,
        allowed_payment_methods: [...ALL_PAYMENT_METHODS],
        idempotency_key_hash: sha256hex(input.idempotency_key),
      },
    };
  }

  async getPaymentStatus(input: {
    tenant_id: string;
    merchant_id: string;
    payment_intent_id: string;
    provider_payment_id: string;
    provider_order_id?: string | null;
    environment: CommerceEnvironment;
  }): Promise<{
    status: 'payment_pending' | 'paid' | 'failed' | 'expired' | 'cancelled';
    raw_status: string;
    provider_metadata: Record<string, unknown>;
  }> {
    const config = getPluralConfig(input.environment);
    const orderId = input.provider_order_id || input.provider_payment_id;
    const response = await authedPluralFetchJson<PluralStatusResponse>(
      config,
      `/pay/v1/orders/${encodeURIComponent(orderId)}`,
      { method: 'GET' },
    );
    const data = pluralStatusBody(response);
    const rawStatus = stringValue(data['status']) ?? 'UNKNOWN';
    return {
      status: mapPluralStatus(rawStatus),
      raw_status: rawStatus,
      provider_metadata: {
        provider_environment: config.provider_environment,
        integration_mode: 'hosted_checkout',
        plural_order_id: stringValue(data['order_id']) ?? orderId,
        merchant_order_reference: stringValue(data['merchant_order_reference']) ?? null,
      },
    };
  }

  async handleWebhook(input: {
    provider_key: 'plural';
    headers: Record<string, string>;
    raw_body: string;
    received_at: string;
  }): Promise<{
    event_id: string;
    event_type: string;
    merchant_ref?: string;
    provider_payment_id?: string;
    status?: string;
    signature_valid: boolean;
    replay: boolean;
    provider_metadata: Record<string, unknown>;
  }> {
    const config = getPluralConfig('live', { webhook: true });
    const webhookId = input.headers['webhook-id'];
    const webhookTimestamp = input.headers['webhook-timestamp'];
    const webhookSignature = input.headers['webhook-signature'];
    if (!webhookId || !webhookTimestamp || !webhookSignature || !config.webhook_secret) {
      throw providerError(normalizedWebhookError(
        'webhook_signature_invalid',
        'plural_webhook_headers_missing',
        'Plural webhook signature headers are missing',
      ));
    }

    const timestampSeconds = Number.parseInt(webhookTimestamp, 10);
    const receivedSeconds = Math.floor(new Date(input.received_at).getTime() / 1000);
    if (!Number.isSafeInteger(timestampSeconds)
      || Math.abs(receivedSeconds - timestampSeconds) > PLURAL_WEBHOOK_REPLAY_WINDOW_SECONDS) {
      throw providerError(normalizedWebhookError(
        'webhook_replay_detected',
        'plural_webhook_timestamp_stale',
        'Plural webhook timestamp is outside the replay window',
      ));
    }

    if (!pluralWebhookSignatureMatches(
      input.raw_body,
      webhookId,
      webhookTimestamp,
      webhookSignature,
      config.webhook_secret,
    )) {
      throw providerError(normalizedWebhookError(
        'webhook_signature_invalid',
        'plural_webhook_signature_invalid',
        'Plural webhook signature is invalid',
      ));
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = parsePluralWebhookPayload(input.raw_body);
    } catch (err) {
      throw providerError({
        code: 'unsupported_provider_event',
        message: 'Plural webhook payload is not valid JSON',
        retryable: false,
        provider_key: 'plural',
        provider_error_code: 'plural_webhook_invalid_json',
        safe_metadata: {
          signature_scheme: 'plural-hmac-sha256-v1',
          payload_hash: sha256hex(input.raw_body),
        },
      });
    }

    const orderId = stringValue(parsed['order_id']);
    const merchantRef = stringValue(parsed['merchant_order_reference'])
      ?? stringValue(parsed['merchant_ref']);
    const rawStatus = (stringValue(parsed['status']) ?? 'UNKNOWN').toUpperCase();
    const eventType = stringValue(parsed['event_type']) ?? statusEventType(rawStatus);
    const eventId = stringValue(parsed['event_id'])
      ?? stringValue(parsed['id'])
      ?? webhookId;
    const providerPaymentId = merchantRef ?? orderId;

    const out: {
      event_id: string;
      event_type: string;
      merchant_ref?: string;
      provider_payment_id?: string;
      status?: string;
      signature_valid: boolean;
      replay: boolean;
      provider_metadata: Record<string, unknown>;
    } = {
      event_id: eventId,
      event_type: eventType,
      signature_valid: true,
      replay: false,
      provider_metadata: {
        provider_environment: config.provider_environment,
        signature_scheme: 'plural-hmac-sha256-v1',
        plural_order_id: orderId ?? null,
        merchant_order_reference: merchantRef ?? null,
      },
    };
    if (merchantRef !== undefined) out.merchant_ref = merchantRef;
    if (providerPaymentId !== undefined) out.provider_payment_id = providerPaymentId;
    if (rawStatus) out.status = rawStatus;
    return out;
  }

  normalizeError(error: unknown): NormalizedProviderError {
    return normalizeUnknownError(error);
  }
}
