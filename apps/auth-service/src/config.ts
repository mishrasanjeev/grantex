import 'dotenv/config';

function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const config = {
  port: parseInt(optional('PORT', '3001'), 10),
  host: optional('HOST', '0.0.0.0'),
  databaseUrl: required('DATABASE_URL'),
  redisUrl: required('REDIS_URL'),
  rsaPrivateKey: process.env['RSA_PRIVATE_KEY'] ?? null,
  autoGenerateKeys: process.env['AUTO_GENERATE_KEYS'] === 'true',
  jwtIssuer: optional('JWT_ISSUER', 'https://grantex.dev'),
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
  otelEndpoint: process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? null,
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

  if (missing.length > 0) {
    console.error(
      `[config] Fatal: missing required configuration: ${missing.join(', ')}`,
    );
    process.exit(1);
  }
}
