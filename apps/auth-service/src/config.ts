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
  adminApiKey: optional('ADMIN_API_KEY', ''),
} as const;

if (!config.rsaPrivateKey && !config.autoGenerateKeys) {
  throw new Error(
    'Either RSA_PRIVATE_KEY or AUTO_GENERATE_KEYS=true must be set',
  );
}
