import 'dotenv/config';

function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function isValidVaultEncryptionKey(value: string): boolean {
  if (/^[0-9a-fA-F]{64}$/.test(value)) return true;
  if (!/^[A-Za-z0-9+/]{43}={0,2}$/.test(value)) return false;
  return Buffer.from(value, 'base64').length === 32;
}

export const config = {
  port: parseInt(optional('PORT', '3001'), 10),
  host: optional('HOST', '0.0.0.0'),
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
  policyBackend: optional('POLICY_BACKEND', 'builtin') as 'builtin' | 'opa' | 'cedar',
  opaUrl: process.env['OPA_URL'] ?? null,
  opaFallbackToBuiltin: process.env['OPA_FALLBACK_TO_BUILTIN'] !== 'false',
  cedarUrl: process.env['CEDAR_URL'] ?? null,
  cedarFallbackToBuiltin: process.env['CEDAR_FALLBACK_TO_BUILTIN'] !== 'false',
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
  commerceSandboxEnabled: process.env['COMMERCE_SANDBOX_ENABLED'] !== 'false',
  commerceAllowAutoTenant: process.env['COMMERCE_ALLOW_AUTO_TENANT'] === 'true',
  pluralSandboxEnabled: process.env['PLURAL_SANDBOX_ENABLED'] === 'true',
  pluralLiveEnabled: process.env['PLURAL_LIVE_ENABLED'] === 'true',
  commerceLiveModeEnabled: process.env['COMMERCE_LIVE_MODE_ENABLED'] === 'true',
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
  const missing: string[] = [];

  if (!config.databaseUrl) missing.push('DATABASE_URL');
  if (!config.redisUrl) missing.push('REDIS_URL');
  if (!config.rsaPrivateKey && !config.autoGenerateKeys) {
    missing.push('RSA_PRIVATE_KEY (or AUTO_GENERATE_KEYS=true)');
  }
  if (!config.jwtIssuer) missing.push('JWT_ISSUER');
  if (config.metricsEnabled && config.metricsRequireAuth && !config.metricsApiKey) {
    missing.push('METRICS_API_KEY');
  }
  if (process.env['NODE_ENV'] === 'production' && !config.adminApiKey) {
    missing.push('ADMIN_API_KEY');
  }
  if (process.env['NODE_ENV'] === 'production' && !config.vaultEncryptionKey) {
    missing.push('VAULT_ENCRYPTION_KEY');
  }
  if (config.vaultEncryptionKey && !isValidVaultEncryptionKey(config.vaultEncryptionKey)) {
    missing.push('VAULT_ENCRYPTION_KEY (must be 32-byte hex or base64)');
  }

  if (missing.length > 0) {
    console.error(
      `[config] Fatal: missing required configuration: ${missing.join(', ')}`,
    );
    process.exit(1);
  }
}
