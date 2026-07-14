import 'dotenv/config';
import { isIP } from 'node:net';
import {
  commercePublicDiscoveryMerchantAllowlist,
  isCommercePublicDiscoveryEnabled,
} from './lib/commerce/public-discovery.js';

function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export type TrustProxySetting = false | number | string[];

export function parseTrustProxySetting(value: string | undefined): TrustProxySetting {
  if (!value || value.trim() === '' || value.trim() === 'false') return false;

  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return parseIntegerSetting('TRUST_PROXY', trimmed, 1, 16);
  }

  const proxies = trimmed.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (proxies.length === 0 || proxies.some((entry) => !isProxyIpOrCidr(entry))) {
    throw new Error('TRUST_PROXY must list trusted proxy IPs/CIDRs or a hop count from 1 to 16');
  }
  return proxies;
}

function isProxyIpOrCidr(value: string): boolean {
  const slash = value.lastIndexOf('/');
  if (slash === -1) return isIP(value) !== 0;
  if (value.indexOf('/') !== slash) return false;

  const address = value.slice(0, slash);
  const prefix = value.slice(slash + 1);
  const version = isIP(address);
  if (version === 0 || !/^\d+$/.test(prefix)) return false;

  const bits = version === 4 ? 32 : 128;
  const prefixLength = Number(prefix);
  return prefixLength >= 1 && prefixLength <= bits;
}

export function parseIntegerSetting(
  name: string,
  value: string,
  min: number,
  max: number,
): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function integerSetting(name: string, fallback: string, min: number, max: number): number {
  return parseIntegerSetting(name, optional(name, fallback), min, max);
}

const POLICY_BACKENDS = ['builtin', 'opa', 'cedar'] as const;
type PolicyBackendName = (typeof POLICY_BACKENDS)[number];

export function parsePolicyBackend(value: string): PolicyBackendName {
  if (!(POLICY_BACKENDS as readonly string[]).includes(value)) {
    throw new Error(`POLICY_BACKEND must be one of: ${POLICY_BACKENDS.join(', ')}`);
  }
  return value as PolicyBackendName;
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && parsed.hostname.length > 0
      && !parsed.username
      && !parsed.password;
  } catch {
    return false;
  }
}

function isValidVaultEncryptionKey(value: string): boolean {
  if (/^[0-9a-fA-F]{64}$/.test(value)) return true;
  if (!/^[A-Za-z0-9+/]{43}={0,2}$/.test(value)) return false;
  return Buffer.from(value, 'base64').length === 32;
}

export const config = {
  port: integerSetting('PORT', '3001', 1, 65_535),
  host: optional('HOST', '0.0.0.0'),
  trustProxy: parseTrustProxySetting(process.env['TRUST_PROXY']),
  databaseUrl: required('DATABASE_URL'),
  redisUrl: required('REDIS_URL'),
  rsaPrivateKey: process.env['RSA_PRIVATE_KEY'] ?? null,
  autoGenerateKeys: process.env['AUTO_GENERATE_KEYS'] === 'true',
  jwtIssuer: optional('JWT_ISSUER', 'https://grantex.dev'),
  // Base URL for client-facing pages and endpoints embedded in responses
  // (consent page, VC status lists, offline-sync endpoint, email links).
  // Defaults to JWT_ISSUER for back-compat, but is conceptually distinct:
  // jwtIssuer is the JWT `iss` claim string, publicBaseUrl is the
  // browser-reachable base URL. They differ when the issuer URL is fronted
  // by a static host (Firebase) that proxies only some paths to the API.
  publicBaseUrl: optional('PUBLIC_BASE_URL', process.env['JWT_ISSUER'] ?? 'https://grantex.dev'),
  seedApiKey: process.env['SEED_API_KEY'] ?? null,
  seedSandboxKey: process.env['SEED_SANDBOX_KEY'] ?? null,
  // Stripe billing (optional — billing endpoints return 503 when not configured)
  stripeSecretKey: process.env['STRIPE_SECRET_KEY'] ?? null,
  stripeWebhookSecret: process.env['STRIPE_WEBHOOK_SECRET'] ?? null,
  stripePricePro: process.env['STRIPE_PRICE_PRO'] ?? null,
  stripePriceEnterprise: process.env['STRIPE_PRICE_ENTERPRISE'] ?? null,
  vaultEncryptionKey: process.env['VAULT_ENCRYPTION_KEY'] ?? null,
  adminApiKey: optional('ADMIN_API_KEY', ''),
  metricsEnabled: process.env['METRICS_ENABLED'] !== 'false',
  metricsApiKey: process.env['METRICS_API_KEY'] ?? null,
  metricsRequireAuth: process.env['METRICS_REQUIRE_AUTH'] === 'true'
    || process.env['NODE_ENV'] === 'production',
  otelEndpoint: process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? null,
  allowInsecureSsoUrls: process.env['SSO_ALLOW_INSECURE_URLS'] === 'true'
    || process.env['NODE_ENV'] !== 'production',
  allowPrivateSsoHosts: process.env['SSO_ALLOW_PRIVATE_HOSTS'] === 'true',
  allowInsecureWebhookUrls: process.env['WEBHOOK_ALLOW_INSECURE_URLS'] === 'true'
    || process.env['NODE_ENV'] !== 'production',
  allowPrivateWebhookHosts: process.env['WEBHOOK_ALLOW_PRIVATE_HOSTS'] === 'true'
    || process.env['NODE_ENV'] !== 'production',
  ldapTlsRejectUnauthorized: process.env['LDAP_TLS_REJECT_UNAUTHORIZED'] !== 'false',
  // Policy backend ('builtin' | 'opa' | 'cedar')
  policyBackend: parsePolicyBackend(optional('POLICY_BACKEND', 'builtin')),
  opaUrl: process.env['OPA_URL'] ?? null,
  opaFallbackToBuiltin: process.env['OPA_FALLBACK_TO_BUILTIN'] === 'true',
  cedarUrl: process.env['CEDAR_URL'] ?? null,
  cedarFallbackToBuiltin: process.env['CEDAR_FALLBACK_TO_BUILTIN'] === 'true',
  // Usage metering
  usageMeteringEnabled: process.env['USAGE_METERING_ENABLED'] === 'true',
  // Email (Resend)
  emailApiKey: process.env['RESEND_API_KEY'] ?? null,
  emailFrom: optional('EMAIL_FROM', 'Grantex <noreply@grantex.dev>'),
  // Ed25519 key for VC Data Integrity proofs (optional)
  ed25519PrivateKey: process.env['ED25519_PRIVATE_KEY'] ?? null,
  // DID Web domain
  didWebDomain: optional('DID_WEB_DOMAIN', 'grantex.dev'),
  // FIDO/WebAuthn
  fidoRpId: optional('FIDO_RP_ID', 'grantex.dev'),
  fidoRpName: optional('FIDO_RP_NAME', 'Grantex'),
  fidoOrigin: optional('FIDO_ORIGIN', 'https://grantex.dev'),
  // SSO state HMAC key (optional — derived from RSA_PRIVATE_KEY if not set)
  ssoStateSecret: process.env['SSO_STATE_SECRET'] ?? null,
  // CORS: comma-separated list of browser origins allowed to call the API
  // (developer dashboard, docs, etc.). Empty string disables CORS.
  corsAllowedOrigins: optional(
    'CORS_ALLOWED_ORIGINS',
    'https://grantex.dev,https://portal.grantex.dev,http://localhost:5173',
  )
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0),
  // ---------------------------------------------------------------------
  // Grantex Commerce V1 feature flags. M1 reads them at request time
  // (process.env directly) so test toggling via vi.stubEnv works.
  // Flag-flip events that affect payment or agentic commerce must be
  // audited as merchant.feature_flag.updated (M2+).
  // commerceAllowAutoTenant: gates the test/local-sandbox auto-provision
  // path in lib/commerce/tenant.ts. MUST stay false in staging/production;
  // unmapped developers there receive 422 tenant_not_provisioned and must
  // be provisioned via the explicit endpoints planned for M2.
  // ---------------------------------------------------------------------
  commerceV1Enabled: process.env['COMMERCE_V1_ENABLED'] === 'true',
  commercePublicDiscoveryEnabled: isCommercePublicDiscoveryEnabled(),
  commercePublicDiscoveryMerchantAllowlist: commercePublicDiscoveryMerchantAllowlist(),
  commerceSandboxEnabled: process.env['COMMERCE_SANDBOX_ENABLED'] !== 'false',
  commerceAllowAutoTenant: process.env['COMMERCE_ALLOW_AUTO_TENANT'] === 'true',
  pluralSandboxEnabled: process.env['PLURAL_SANDBOX_ENABLED'] === 'true',
  pluralLiveEnabled: process.env['PLURAL_LIVE_ENABLED'] === 'true',
  commerceLiveModeEnabled: process.env['COMMERCE_LIVE_MODE_ENABLED'] === 'true',
  commerceReconciliationWorkerEnabled: process.env['COMMERCE_RECONCILIATION_WORKER_ENABLED'] === 'true',
  commerceReconciliationIntervalMs: integerSetting(
    'COMMERCE_RECONCILIATION_INTERVAL_MS',
    '300000',
    1,
    2_147_483_647,
  ),
  commerceReconciliationLimit: integerSetting('COMMERCE_RECONCILIATION_LIMIT', '50', 1, 1_000),
} as const;

if (!config.rsaPrivateKey && !config.autoGenerateKeys) {
  throw new Error(
    'Either RSA_PRIVATE_KEY or AUTO_GENERATE_KEYS=true must be set',
  );
}

/**
 * Validate that all critical configuration values are present.
 * Call before the server starts listening. Exits the process if
 * any required value is missing.
 */
export function validateConfig(): void {
  const errors: string[] = [];

  if (!config.databaseUrl) errors.push('DATABASE_URL is required');
  if (!config.redisUrl) errors.push('REDIS_URL is required');
  if (!config.rsaPrivateKey && !config.autoGenerateKeys) {
    errors.push('RSA_PRIVATE_KEY is required (or AUTO_GENERATE_KEYS=true outside production)');
  }
  if (!config.jwtIssuer) errors.push('JWT_ISSUER is required');
  if (config.metricsEnabled && config.metricsRequireAuth && !config.metricsApiKey) {
    errors.push('METRICS_API_KEY is required');
  }
  if (process.env['NODE_ENV'] === 'production' && !config.adminApiKey) {
    errors.push('ADMIN_API_KEY is required');
  }
  if (process.env['NODE_ENV'] === 'production' && !config.vaultEncryptionKey) {
    errors.push('VAULT_ENCRYPTION_KEY is required');
  }
  if (process.env['NODE_ENV'] === 'production' && !config.rsaPrivateKey) {
    errors.push('RSA_PRIVATE_KEY is required in production; AUTO_GENERATE_KEYS is development-only');
  }
  if (process.env['NODE_ENV'] === 'production' && (config.seedApiKey || config.seedSandboxKey)) {
    errors.push('SEED_API_KEY and SEED_SANDBOX_KEY must not be configured in production');
  }
  if (config.vaultEncryptionKey && !isValidVaultEncryptionKey(config.vaultEncryptionKey)) {
    errors.push('VAULT_ENCRYPTION_KEY must be 32-byte hex or base64');
  }
  if (config.policyBackend === 'opa' && (!config.opaUrl || !isHttpUrl(config.opaUrl))) {
    errors.push('OPA_URL must be a valid HTTP or HTTPS URL when POLICY_BACKEND=opa');
  }
  if (config.policyBackend === 'cedar' && (!config.cedarUrl || !isHttpUrl(config.cedarUrl))) {
    errors.push('CEDAR_URL must be a valid HTTP or HTTPS URL when POLICY_BACKEND=cedar');
  }

  if (errors.length > 0) {
    console.error(
      `[config] Fatal: invalid configuration: ${errors.join(', ')}`,
    );
    process.exit(1);
  }
}
