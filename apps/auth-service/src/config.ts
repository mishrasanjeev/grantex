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
} as const;

if (!config.rsaPrivateKey && !config.autoGenerateKeys) {
  throw new Error(
    'Either RSA_PRIVATE_KEY or AUTO_GENERATE_KEYS=true must be set',
  );
}
