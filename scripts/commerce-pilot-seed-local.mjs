#!/usr/bin/env node
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from '../apps/auth-service/node_modules/postgres/src/index.js';
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  importJWK,
} from '../apps/auth-service/node_modules/jose/dist/node/esm/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const migrationsDir = join(repoRoot, 'apps', 'auth-service', 'src', 'db', 'migrations');

const LOCAL_VAULT_KEY_HEX = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const OPERATOR_API_KEY = 'sandbox-api-key-local';
const AGENT_API_KEY = 'grtx_agent_local_pilot_seed_00000000000000000001';
const MOCK_WEBHOOK_SECRET = 'mock-webhook-secret';
const TENANT_ID = 'cten_internal_sandbox';
const DEVELOPER_ID = 'dev_commerce_local_pilot';
const MERCHANT_ID = 'mch_internal_sandbox_pilot';
const AGENT_ID = 'cag_internal_sandbox_pilot';
const POLICY_ID = 'cpol_internal_sandbox_pilot_v1';
const POLICY_VERSION = 'm7c-local-pilot-v1';
const PRODUCT_ID = 'cprd_internal_sandbox_pilot_001';
const VARIANT_ID = 'cvar_internal_sandbox_pilot_001';
const PASSPORT_AUDIENCE = 'grantex-commerce';
const CHECKOUT_SCOPES = [
  'commerce:catalog.read',
  'commerce:inventory.read',
  'commerce:checkout.create',
  'commerce:payment.initiate',
  'commerce:payment.status.read',
];

function arg(name, fallback = undefined) {
  const eqPrefix = `${name}=`;
  const eqFound = process.argv.find((item) => item.startsWith(eqPrefix));
  if (eqFound) return eqFound.slice(eqPrefix.length);
  const index = process.argv.indexOf(name);
  if (index !== -1 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) {
    return process.argv[index + 1];
  }
  return fallback;
}

function boolArg(name) {
  return process.argv.includes(name);
}

function sha256hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function isLocalDatabaseUrl(value) {
  try {
    const url = new URL(value);
    const localHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'postgres']);
    const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ''));
    const productionWords = /prod|production|live/i;
    return (url.protocol === 'postgres:' || url.protocol === 'postgresql:')
      && localHosts.has(url.hostname)
      && !productionWords.test(url.hostname)
      && !productionWords.test(databaseName)
      && !productionWords.test(url.username);
  } catch {
    return false;
  }
}

function assertLocalOnly(databaseUrl) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed commerce pilot data when NODE_ENV=production');
  }
  if (process.env.COMMERCE_LIVE_MODE_ENABLED === 'true' || process.env.PLURAL_LIVE_ENABLED === 'true') {
    throw new Error('Refusing to seed commerce pilot data when live commerce or live Plural flags are enabled');
  }
  if (!isLocalDatabaseUrl(databaseUrl)) {
    throw new Error('Refusing to seed commerce pilot data against a non-local or production-like DATABASE_URL');
  }
}

function aesKey() {
  const configured = process.env.VAULT_ENCRYPTION_KEY || process.env.COMMERCE_SEED_VAULT_KEY || LOCAL_VAULT_KEY_HEX;
  if (/^[0-9a-fA-F]{64}$/.test(configured)) return Buffer.from(configured, 'hex');
  return Buffer.from(configured, 'base64');
}

function encrypt(plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', aesKey(), iv, { authTagLength: 16 });
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decrypt(ciphertext) {
  const data = Buffer.from(ciphertext, 'base64');
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const encrypted = data.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', aesKey(), iv, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  return decipher.update(encrypted, undefined, 'utf8') + decipher.final('utf8');
}

function makeRunId() {
  return new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
}

function cartId(runId, index) {
  return `ccart_m7c_${runId}_${String(index).padStart(3, '0')}`;
}

function webhookCartId(runId, index) {
  return `ccart_m7c_wh_${runId}_${String(index).padStart(3, '0')}`;
}

function paymentIntentId(runId, index) {
  return `cpi_m7c_wh_${runId}_${String(index).padStart(3, '0')}`;
}

function providerPaymentId(runId, index) {
  return `mock_pay_cpi_m7c_wh_${runId}_${String(index).padStart(3, '0')}`;
}

function lineItemsSnapshot() {
  return [{
    variant_id: VARIANT_ID,
    sku: 'PILOT-DEMO-001',
    title: 'Pilot Demo Induction Cooktop',
    variant_title: 'Black',
    quantity: 1,
    unit_amount: 1000,
    line_total_amount: 1000,
    currency: 'INR',
    availability_status: 'in_stock',
  }];
}

async function runMigrations(sql) {
  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const content = readFileSync(join(migrationsDir, file), 'utf8');
    await sql.unsafe(content);
  }
  return files.length;
}

async function ensurePassportSigner(sql) {
  const activeRows = await sql`
    SELECT kid, public_key_jwk, encrypted_private_key_jwk
      FROM commerce_passport_keys
     WHERE status = 'active'
     LIMIT 1
  `;
  if (activeRows[0]) {
    try {
      const privateJwk = JSON.parse(decrypt(activeRows[0].encrypted_private_key_jwk));
      const privateKey = await importJWK(privateJwk, 'ES256');
      return { kid: activeRows[0].kid, privateKey };
    } catch (err) {
      throw new Error(
        'Active commerce passport key exists but could not be decrypted with VAULT_ENCRYPTION_KEY '
        + 'or COMMERCE_SEED_VAULT_KEY. Use the same local key as auth-service or reset the local DB.',
      );
    }
  }

  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const suffix = randomBytes(4).toString('hex');
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const kid = `commerce-passport-${today}-${suffix}`;
  const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: 'ES256', use: 'sig' };
  const privateJwk = { ...(await exportJWK(privateKey)), kid, alg: 'ES256' };
  await sql`
    INSERT INTO commerce_passport_keys (
      kid, algorithm, public_key_jwk, encrypted_private_key_jwk, status
    ) VALUES (
      ${kid}, 'ES256', ${sql.json(publicJwk)}, ${encrypt(JSON.stringify(privateJwk))}, 'active'
    )
  `;
  return { kid, privateKey };
}

async function signCheckoutPassport(sql, runId, jwtIssuer) {
  const signer = await ensurePassportSigner(sql);
  const now = Math.floor(Date.now() / 1000);
  const consentRecordId = `crec_m7c_${runId}`;
  const consentRequestId = `m7c_${runId}_${randomBytes(12).toString('base64url')}`;
  const jti = `cpsp_m7c_${runId}`;
  await sql`
    INSERT INTO commerce_consent_records (
      id, tenant_id, merchant_id, agent_id, user_principal_id, user_principal_hint,
      consent_request_id, passport_type, requested_scopes, approved_scopes,
      max_amount, currency, consent_text_version, presented_payload_hash,
      status, agent_auth_method, expires_at, approved_at
    ) VALUES (
      ${consentRecordId}, ${TENANT_ID}, ${MERCHANT_ID}, ${AGENT_ID}, 'user_local_pilot',
      'user_local_pilot', ${consentRequestId}, 'checkout', ${CHECKOUT_SCOPES}, ${CHECKOUT_SCOPES},
      500000, 'INR', 'commerce-v1-local-pilot', ${sha256hex(`m7c:${runId}`)},
      'granted', 'api_key', to_timestamp(${now + 600}), to_timestamp(${now})
    )
  `;
  const jwt = await new SignJWT({
    passport_type: 'checkout',
    tenant_id: TENANT_ID,
    merchant_id: MERCHANT_ID,
    agent_id: AGENT_ID,
    consent_record_id: consentRecordId,
    scopes: CHECKOUT_SCOPES,
    max_amount: 500000,
    currency: 'INR',
    policy_version: POLICY_VERSION,
    env: 'sandbox',
    ver: '1',
  })
    .setProtectedHeader({ alg: 'ES256', kid: signer.kid })
    .setIssuer(jwtIssuer)
    .setAudience(PASSPORT_AUDIENCE)
    .setSubject('user_local_pilot')
    .setJti(jti)
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + 600)
    .sign(signer.privateKey);

  await sql`
    INSERT INTO commerce_passports (
      jti, tenant_id, merchant_id, agent_id, consent_record_id, passport_type,
      kid, subject, scopes, max_amount, currency, policy_version, environment,
      audience, issued_at, not_before, expires_at, agent_auth_method
    ) VALUES (
      ${jti}, ${TENANT_ID}, ${MERCHANT_ID}, ${AGENT_ID}, ${consentRecordId}, 'checkout',
      ${signer.kid}, 'user_local_pilot', ${CHECKOUT_SCOPES}, 500000, 'INR', ${POLICY_VERSION}, 'sandbox',
      ${PASSPORT_AUDIENCE}, to_timestamp(${now}), to_timestamp(${now}), to_timestamp(${now + 600}), 'api_key'
    )
  `;
  return { jwt, jti };
}

async function ensureDeveloper(sql) {
  const keyHash = sha256hex(OPERATOR_API_KEY);
  const existing = await sql`SELECT id FROM developers WHERE api_key_hash = ${keyHash} LIMIT 1`;
  if (existing[0]?.id) return existing[0].id;
  await sql`
    INSERT INTO developers (id, api_key_hash, name, mode)
    VALUES (${DEVELOPER_ID}, ${keyHash}, 'Commerce Local Pilot Operator', 'sandbox')
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, mode = 'sandbox'
  `;
  return DEVELOPER_ID;
}

async function seedBaseData(sql) {
  const developerId = await ensureDeveloper(sql);
  await sql`
    INSERT INTO commerce_tenants (id, display_name, status, metadata)
    VALUES (${TENANT_ID}, 'Grantex Internal Sandbox', 'active', '{"internal_sandbox": true}'::jsonb)
    ON CONFLICT (id) DO UPDATE SET status = 'active', metadata = commerce_tenants.metadata || EXCLUDED.metadata
  `;
  await sql`
    INSERT INTO commerce_developer_tenants (developer_id, tenant_id, is_default)
    VALUES (${developerId}, ${TENANT_ID}, TRUE)
    ON CONFLICT (developer_id, tenant_id) DO UPDATE SET is_default = TRUE
  `;
  await sql`
    INSERT INTO commerce_tenant_operators (developer_id, tenant_id, role)
    VALUES (${developerId}, ${TENANT_ID}, 'owner')
    ON CONFLICT (developer_id, tenant_id) DO UPDATE SET role = 'owner'
  `;
  await sql`
    INSERT INTO commerce_merchants (
      id, tenant_id, legal_name, display_name, category_preset, verification_status,
      environment, agentic_commerce_enabled, default_currency, country_code,
      provider_account_refs, metadata
    ) VALUES (
      ${MERCHANT_ID}, ${TENANT_ID}, 'Grantex Internal Sandbox Pilot',
      'Grantex Internal Sandbox Pilot', 'electronics_appliances', 'verified',
      'sandbox', TRUE, 'INR', 'IN',
      '{"mock": {"account_ref": "mock_internal_sandbox"}}'::jsonb,
      '{"internal_sandbox_only": true, "live_payments": false}'::jsonb
    )
    ON CONFLICT (id) DO UPDATE SET
      verification_status = 'verified',
      environment = 'sandbox',
      agentic_commerce_enabled = TRUE,
      provider_account_refs = commerce_merchants.provider_account_refs || EXCLUDED.provider_account_refs,
      metadata = commerce_merchants.metadata || EXCLUDED.metadata,
      disabled_at = NULL
  `;
  await sql`
    INSERT INTO commerce_agents (
      id, tenant_id, display_name, agent_type, api_key_hash, trust_status, disabled_at
    ) VALUES (
      ${AGENT_ID}, ${TENANT_ID}, 'Commerce Local Pilot Agent', 'sales',
      ${sha256hex(AGENT_API_KEY)}, 'trusted', NULL
    )
    ON CONFLICT (id) DO UPDATE SET
      api_key_hash = EXCLUDED.api_key_hash,
      trust_status = 'trusted',
      disabled_at = NULL
  `;
  await sql`
    INSERT INTO commerce_provider_credentials (
      id, tenant_id, merchant_id, provider_key, environment, credential_ref,
      encrypted_secret_blob, status, last_validated_at, capabilities
    ) VALUES (
      'cpc_internal_sandbox_mock', ${TENANT_ID}, ${MERCHANT_ID}, 'mock', 'sandbox',
      'mock_internal_sandbox', ${encrypt('{"mock":true,"local_only":true}')}, 'valid', NOW(),
      ARRAY['payment_intent.create','checkout_link.create','payment_status.read']::text[]
    )
    ON CONFLICT (tenant_id, merchant_id, provider_key, environment, credential_ref) DO UPDATE SET
      status = 'valid',
      last_validated_at = NOW(),
      capabilities = EXCLUDED.capabilities
  `;
  await sql`
    UPDATE commerce_policies
       SET status = 'archived', updated_at = NOW()
     WHERE tenant_id = ${TENANT_ID}
       AND merchant_id = ${MERCHANT_ID}
       AND status = 'active'
       AND version <> ${POLICY_VERSION}
  `;
  await sql`
    INSERT INTO commerce_policies (
      id, tenant_id, merchant_id, version, rules, status, created_by, activated_by, activated_at
    ) VALUES (
      ${POLICY_ID}, ${TENANT_ID}, ${MERCHANT_ID}, ${POLICY_VERSION},
      '{
        "amount_cap": {"max_amount_minor_units": 500000, "currency": "INR"},
        "scope_allowlist": [
          "commerce:catalog.read", "commerce:inventory.read",
          "commerce:checkout.create", "commerce:payment.initiate",
          "commerce:payment.status.read"
        ],
        "emergency_disable": false,
        "checkout_passport_max_ttl_seconds": 600,
        "browse_passport_max_ttl_seconds": 3600,
        "stale_price_max_age_seconds": 86400,
        "allow_unknown_inventory_checkout": false
      }'::jsonb,
      'active', ${developerId}, ${developerId}, NOW()
    )
    ON CONFLICT (tenant_id, merchant_id, version) DO NOTHING
  `;
  return { developerId };
}

async function seedCatalog(sql) {
  await sql`
    INSERT INTO commerce_products (
      id, tenant_id, merchant_id, product_id, title, brand, description,
      image_url, category_preset, source_system, manually_maintained
    ) VALUES (
      ${PRODUCT_ID}, ${TENANT_ID}, ${MERCHANT_ID}, 'pilot-demo-cooktop',
      'Pilot Demo Induction Cooktop', 'Grantex Demo', 'Local-only sandbox product for pilot load testing.',
      NULL, 'electronics_appliances', 'local_seed', TRUE
    )
    ON CONFLICT (id) DO UPDATE SET
      title = EXCLUDED.title,
      brand = EXCLUDED.brand,
      archived_at = NULL,
      updated_at = NOW()
  `;
  await sql`
    INSERT INTO commerce_product_variants (
      id, tenant_id, merchant_id, product_id, sku, model, variant_title,
      attributes, price_amount, currency, tax_inclusive, gst_slab, tax_rate,
      hsn_code, availability_status, warranty_summary, return_policy_summary,
      source_system, last_synced_at
    ) VALUES (
      ${VARIANT_ID}, ${TENANT_ID}, ${MERCHANT_ID}, ${PRODUCT_ID}, 'PILOT-DEMO-001',
      'PILOT-1000', 'Black', '{"color":"black"}'::jsonb, 1000, 'INR', TRUE, '18',
      0.18, '85166000', 'in_stock', 'Local sandbox warranty only',
      'Local sandbox returns only', 'local_seed', NOW()
    )
    ON CONFLICT (id) DO UPDATE SET
      price_amount = 1000,
      currency = 'INR',
      availability_status = 'in_stock',
      archived_at = NULL,
      last_synced_at = NOW(),
      updated_at = NOW()
  `;
}

async function seedCartsAndPendingPayments(sql, runId, passportJti) {
  const snapshot = lineItemsSnapshot();
  const lineItems = [{ variant_id: VARIANT_ID, quantity: 1 }];
  const snapshotHash = sha256hex(JSON.stringify(snapshot));
  const cartIds = [];
  for (let i = 1; i <= 100; i += 1) {
    const id = cartId(runId, i);
    cartIds.push(id);
    await sql`
      INSERT INTO commerce_carts (
        id, tenant_id, merchant_id, agent_id, passport_jti, line_items,
        line_items_snapshot, currency, subtotal_amount, tax_amount, total_amount,
        status, expires_at, line_items_snapshot_hash, idempotency_key_hash
      ) VALUES (
        ${id}, ${TENANT_ID}, ${MERCHANT_ID}, ${AGENT_ID}, NULL,
        ${sql.json(lineItems)}, ${sql.json(snapshot)},
        'INR', 1000, 0, 1000, 'draft', NOW() + INTERVAL '30 minutes',
        ${snapshotHash}, NULL
      )
    `;
  }

  const providerPaymentIds = [];
  for (let i = 1; i <= 51; i += 1) {
    const whCartId = webhookCartId(runId, i);
    const intentId = paymentIntentId(runId, i);
    const providerId = providerPaymentId(runId, i);
    providerPaymentIds.push(providerId);
    await sql`
      INSERT INTO commerce_carts (
        id, tenant_id, merchant_id, agent_id, passport_jti, line_items,
        line_items_snapshot, currency, subtotal_amount, tax_amount, total_amount,
        status, expires_at, line_items_snapshot_hash, idempotency_key_hash
      ) VALUES (
        ${whCartId}, ${TENANT_ID}, ${MERCHANT_ID}, ${AGENT_ID}, ${passportJti},
        ${sql.json(lineItems)}, ${sql.json(snapshot)},
        'INR', 1000, 0, 1000, 'payment_intent_created', NOW() + INTERVAL '30 minutes',
        ${snapshotHash}, NULL
      )
    `;
    await sql`
      INSERT INTO commerce_payment_intents (
        id, tenant_id, merchant_id, agent_id, cart_id, passport_jti,
        amount, currency, provider, provider_environment, provider_payment_id,
        provider_order_id, checkout_url, status, line_items_snapshot,
        idempotency_key_hash, provider_metadata, provider_raw_status,
        policy_version, decision_id, expires_at
      ) VALUES (
        ${intentId}, ${TENANT_ID}, ${MERCHANT_ID}, ${AGENT_ID}, ${whCartId}, ${passportJti},
        1000, 'INR', 'mock', 'sandbox', ${providerId},
        ${`mock_order_${intentId}`}, NULL, 'payment_pending',
        ${sql.json(snapshot)}, ${sha256hex(`seed:${intentId}`)},
        '{"local_seed": true}'::jsonb, 'mock_payment_pending',
        ${POLICY_VERSION}, ${`cpdec_m7c_${runId}_${String(i).padStart(3, '0')}`},
        NOW() + INTERVAL '15 minutes'
      )
    `;
  }
  return { cartIds, providerPaymentIds };
}

function envFileContent(input) {
  return `# Local-only Grantex Commerce M7C pilot load inputs.
# Synthetic sandbox values generated by scripts/commerce-pilot-seed-local.mjs.
# Do not commit real secrets. Do not use for production or live Plural payments.
COMMERCE_LOAD_API_BASE=http://localhost:3001
COMMERCE_LOAD_AUTH_TOKEN=${input.agentApiKey}
COMMERCE_LOAD_MERCHANT_ID=${MERCHANT_ID}
COMMERCE_LOAD_AGENT_ID=${AGENT_ID}
COMMERCE_LOAD_CART_IDS=${input.cartIds.join(',')}
COMMERCE_LOAD_CHECKOUT_PASSPORT=${input.passportJwt}
COMMERCE_LOAD_PROVIDER_PAYMENT_IDS=${input.providerPaymentIds.join(',')}
COMMERCE_LOAD_MOCK_WEBHOOK_SECRET=${MOCK_WEBHOOK_SECRET}
COMMERCE_LOAD_AMOUNT_MINOR_UNITS=1000
COMMERCE_LOAD_CURRENCY=INR
`;
}

function writeEnvFile(outputPath, data) {
  const resolved = resolve(outputPath);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, envFileContent(data), 'utf8');
  return resolved;
}

function dryRunReport(databaseUrl) {
  return {
    mode: 'dry-run',
    local_only: true,
    database_url_allowed: isLocalDatabaseUrl(databaseUrl),
    would_seed: {
      tenant_id: TENANT_ID,
      merchant_id: MERCHANT_ID,
      agent_id: AGENT_ID,
      provider_key: 'mock',
      cart_count: 100,
      pending_provider_payment_count: 51,
      live_plural_enabled: false,
    },
  };
}

async function main() {
  const databaseUrl = arg('--database-url', process.env.DATABASE_URL ?? 'postgres://grantex:grantex@localhost:5432/grantex');
  const dryRun = boolArg('--dry-run') || !boolArg('--run');
  if (dryRun) {
    console.log(JSON.stringify(dryRunReport(databaseUrl), null, 2));
    return;
  }

  assertLocalOnly(databaseUrl);
  const outputPath = arg('--env-output', join(repoRoot, '.tmp', 'commerce-pilot-load.env'));
  const jwtIssuer = arg('--jwt-issuer', process.env.JWT_ISSUER ?? 'https://grantex.dev');
  const runId = arg('--run-id', makeRunId());
  const shouldMigrate = boolArg('--migrate');
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    if (shouldMigrate) {
      await runMigrations(sql);
    }
    const tableCheck = await sql`
      SELECT to_regclass('public.commerce_tenants') AS commerce_tenants,
             to_regclass('public.commerce_carts') AS commerce_carts
    `;
    if (!tableCheck[0]?.commerce_tenants || !tableCheck[0]?.commerce_carts) {
      throw new Error('Commerce tables are missing. Start auth-service once to run migrations or rerun with --migrate against a local DB.');
    }

    const seeded = await sql.begin(async (tx) => {
      await seedBaseData(tx);
      await seedCatalog(tx);
      const passport = await signCheckoutPassport(tx, runId, jwtIssuer);
      const loadInputs = await seedCartsAndPendingPayments(tx, runId, passport.jti);
      return { passport, loadInputs };
    });
    const envPath = writeEnvFile(outputPath, {
      agentApiKey: AGENT_API_KEY,
      passportJwt: seeded.passport.jwt,
      cartIds: seeded.loadInputs.cartIds,
      providerPaymentIds: seeded.loadInputs.providerPaymentIds,
    });
    console.log(JSON.stringify({
      mode: 'run',
      local_only: true,
      run_id: runId,
      tenant_id: TENANT_ID,
      merchant_id: MERCHANT_ID,
      agent_id: AGENT_ID,
      cart_count: seeded.loadInputs.cartIds.length,
      pending_provider_payment_count: seeded.loadInputs.providerPaymentIds.length,
      env_output: envPath,
      live_plural_enabled: false,
      provider_key: 'mock',
    }, null, 2));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  const message = err instanceof AggregateError
    ? 'Could not connect to local Postgres. Start the local dev stack first and confirm localhost:5432 is reachable.'
    : (err instanceof Error && err.message ? err.message : String(err));
  console.error(message || 'commerce pilot local seed failed');
  process.exit(1);
});
