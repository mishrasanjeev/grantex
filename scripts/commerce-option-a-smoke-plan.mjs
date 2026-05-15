#!/usr/bin/env node

const DEFAULTS = {
  serviceName: 'grantex-auth-smoke',
  sqlInstance: 'grantex-commerce-smoke-pg',
  sqlDatabase: 'grantex_commerce_smoke',
  sqlUser: 'grantex_commerce_smoke_app',
  redisInstance: 'grantex-commerce-smoke-redis',
  artifactRepo: 'grantex-images',
  provider: 'mock',
  minInstances: 0,
  maxInstances: 1,
};

const REFUSED_RESOURCE_NAMES = new Set(['grantex-auth', 'grantex-pg16', 'grantex-redis']);
const REFUSED_PRODUCTION_ORIGINS = new Set([
  'https://grantex.dev',
  'https://api.grantex.dev',
  'https://app.agenticorg.ai',
]);

const SECRET_NAMES = [
  'grantex-smoke-database-url',
  'grantex-smoke-redis-url',
  'grantex-smoke-admin-api-key',
  'grantex-smoke-vault-encryption-key',
  'grantex-smoke-rsa-private-key',
  'grantex-smoke-sso-state-secret',
  'grantex-smoke-metrics-api-key',
  'grantex-smoke-mock-payment-webhook-secret',
  'grantex-smoke-commerce-passport-signing-key',
];

function fail(message) {
  console.error(message);
  process.exit(1);
}

function argValue(name, fallback = '') {
  const prefix = `${name}=`;
  for (let index = 2; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    if (arg === name && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) {
      return process.argv[index + 1];
    }
    if (arg.startsWith(prefix)) {
      return arg.slice(prefix.length);
    }
  }
  return fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function requireArg(name) {
  const value = argValue(name);
  if (!value.trim()) {
    fail(`Missing required argument ${name}`);
  }
  return value.trim();
}

function validateResourceName(value, label) {
  if (!/^[a-z][a-z0-9-]{2,62}$/.test(value)) {
    fail(`Refusing invalid ${label}: ${value}`);
  }
  if (REFUSED_RESOURCE_NAMES.has(value)) {
    fail(`Refusing production resource name for ${label}: ${value}`);
  }
  return value;
}

function validateUrlIfPresent(value, label) {
  if (!value) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`Refusing invalid ${label}: ${value}`);
  }
  if (url.username || url.password) {
    fail(`Refusing credentialed ${label}`);
  }
  if (REFUSED_PRODUCTION_ORIGINS.has(url.origin)) {
    fail(`Refusing production URL for ${label}: ${url.origin}`);
  }
  if (url.protocol !== 'https:') {
    fail(`Refusing non-HTTPS ${label}`);
  }
  return url.origin;
}

function validateCleanupWindow(cleanupBy, allowLongWindow) {
  const cleanupDate = new Date(cleanupBy);
  if (Number.isNaN(cleanupDate.getTime())) {
    fail(`Refusing invalid --cleanup-by timestamp: ${cleanupBy}`);
  }
  const maxMs = 24 * 60 * 60 * 1000;
  if (cleanupDate.getTime() - Date.now() > maxMs && !allowLongWindow) {
    fail('Refusing cleanup window more than 24 hours in the future without --allow-long-cleanup-window');
  }
  return cleanupDate.toISOString();
}

function notRun(command) {
  return `# NOT RUN\n${command}`;
}

const dryRun = hasFlag('--dry-run') || !hasFlag('--run');
if (hasFlag('--run')) {
  fail('This planner is dry-run command generation only. It never creates resources or deploys.');
}

const project = requireArg('--project');
const region = requireArg('--region');
const sqlTier = requireArg('--sql-tier');
const cleanupBy = validateCleanupWindow(requireArg('--cleanup-by'), hasFlag('--allow-long-cleanup-window'));
const provider = argValue('--provider', DEFAULTS.provider);
if (provider !== 'mock') {
  fail('Refusing non-mock provider for Option A smoke planning');
}

const serviceName = validateResourceName(argValue('--service-name', DEFAULTS.serviceName), 'Cloud Run service');
const sqlInstance = validateResourceName(argValue('--sql-instance', DEFAULTS.sqlInstance), 'Cloud SQL instance');
const redisInstance = validateResourceName(argValue('--redis-instance', DEFAULTS.redisInstance), 'Redis instance');
const maxInstances = Number(argValue('--max-instances', String(DEFAULTS.maxInstances)));
if (maxInstances !== 1) {
  fail('Refusing Option A smoke plan unless --max-instances=1');
}
const smokeUrl = validateUrlIfPresent(argValue('--smoke-url', ''), 'smoke URL') ?? '<approved-smoke-run-app-origin>';
const image = `${region}-docker.pkg.dev/${project}/${DEFAULTS.artifactRepo}/auth-service-smoke:<approved-commit-sha>`;

const secretCreateCommands = SECRET_NAMES.map(
  (name) => `gcloud secrets create ${name} --project=${project} --replication-policy=automatic`,
);
const secretDeleteCommands = SECRET_NAMES.map((name) => `gcloud secrets delete ${name} --project=${project} --quiet`);

const commands = [
  {
    phase: 'create_cloud_sql',
    command: notRun([
      `gcloud sql instances create ${sqlInstance}`,
      `  --project=${project}`,
      `  --region=${region}`,
      '  --database-version=POSTGRES_16',
      `  --tier=${sqlTier}`,
      '  --storage-type=HDD',
      '  --storage-size=10GB',
      '  --availability-type=zonal',
      '  --no-deletion-protection',
    ].join(' \\\n')),
  },
  {
    phase: 'create_database_and_user',
    command: notRun([
      `gcloud sql databases create ${DEFAULTS.sqlDatabase} --project=${project} --instance=${sqlInstance}`,
      `gcloud sql users create ${DEFAULTS.sqlUser} --project=${project} --instance=${sqlInstance} --password=<smoke-db-password-provided-outside-logs>`,
    ].join('\n')),
  },
  {
    phase: 'create_redis',
    command: notRun([
      `gcloud redis instances create ${redisInstance}`,
      `  --project=${project}`,
      `  --region=${region}`,
      '  --size=1',
      '  --tier=basic',
      '  --redis-version=redis_7_0',
    ].join(' \\\n')),
  },
  {
    phase: 'create_smoke_secret_names',
    command: notRun(secretCreateCommands.join('\n')),
  },
  {
    phase: 'build_smoke_image',
    command: notRun(`gcloud builds submit apps/auth-service --project=${project} --tag=${image}`),
  },
  {
    phase: 'deploy_smoke_service',
    command: notRun([
      `gcloud run deploy ${serviceName}`,
      `  --project=${project}`,
      `  --region=${region}`,
      `  --image=${image}`,
      '  --min-instances=0',
      '  --max-instances=1',
      '  --cpu=1',
      '  --memory=512Mi',
      '  --concurrency=20',
      '  --no-allow-unauthenticated',
      '  --set-env-vars=NODE_ENV=staging,COMMERCE_V1_ENABLED=true,COMMERCE_SANDBOX_ENABLED=true,COMMERCE_ALLOW_AUTO_TENANT=false,COMMERCE_LOCAL_LOAD_TEST=false,COMMERCE_LIVE_MODE_ENABLED=false,PLURAL_SANDBOX_ENABLED=false,PLURAL_LIVE_ENABLED=false,COMMERCE_RECONCILIATION_WORKER_ENABLED=false,METRICS_ENABLED=true,METRICS_REQUIRE_AUTH=true,SSO_ALLOW_INSECURE_URLS=false,WEBHOOK_ALLOW_INSECURE_URLS=false,LDAP_TLS_REJECT_UNAUTHORIZED=true,AUTO_GENERATE_KEYS=false',
      '  --set-secrets=DATABASE_URL=grantex-smoke-database-url:latest,REDIS_URL=grantex-smoke-redis-url:latest,ADMIN_API_KEY=grantex-smoke-admin-api-key:latest,VAULT_ENCRYPTION_KEY=grantex-smoke-vault-encryption-key:latest,RSA_PRIVATE_KEY=grantex-smoke-rsa-private-key:latest,SSO_STATE_SECRET=grantex-smoke-sso-state-secret:latest,METRICS_API_KEY=grantex-smoke-metrics-api-key:latest,MOCK_PAYMENT_WEBHOOK_SECRET=grantex-smoke-mock-payment-webhook-secret:latest',
    ].join(' \\\n')),
  },
  {
    phase: 'smoke_harness_dry_run',
    command: notRun(`node scripts/commerce-staging-e2e-harness.mjs --dry-run --api-base=${smokeUrl} --allow-smoke-cloud-run-url=${smokeUrl}`),
  },
  {
    phase: 'smoke_evidence_run_placeholder',
    command: notRun(`node scripts/commerce-option-a-smoke-evidence.mjs --dry-run --api-base=${smokeUrl} --allow-smoke-cloud-run-url=${smokeUrl}`),
  },
  {
    phase: 'agenticorg_local_real_staging_eval',
    command: notRun([
      '$env:GRANTEX_COMMERCE_BASE_URL=\'<approved-smoke-run-app-origin>\'',
      '$env:GRANTEX_BASE_URL=\'<approved-smoke-run-app-origin>\'',
      '$env:AGENTICORG_COMMERCE_ALLOWED_SMOKE_URL=\'<approved-smoke-run-app-origin>\'',
      '$env:AGENTICORG_COMMERCE_REAL_STAGING=\'1\'',
      '# Set exactly one Grantex auth env var securely outside logs.',
      'python demos/commerce_sales_agent_demo.py --mode=real-staging --grantex-base \'<approved-smoke-run-app-origin>\' --allow-smoke-cloud-run-url \'<approved-smoke-run-app-origin>\' --evidence-report docs/reports/commerce-agent-real-staging-evidence.md',
      'python -m pytest tests/evals/test_commerce_sales_agent_real_staging.py -q',
    ].join('\n')),
  },
  {
    phase: 'cleanup',
    command: notRun([
      `gcloud run services delete ${serviceName} --project=${project} --region=${region} --quiet`,
      `gcloud redis instances delete ${redisInstance} --project=${project} --region=${region} --quiet`,
      `gcloud sql instances delete ${sqlInstance} --project=${project} --quiet`,
      secretDeleteCommands.join('\n'),
      `gcloud artifacts docker images delete ${image} --project=${project} --quiet`,
    ].join('\n')),
  },
];

console.log(JSON.stringify({
  mode: dryRun ? 'dry-run' : 'run',
  status: 'not_executed',
  creates_resources: false,
  deploys: false,
  project,
  region,
  service_name: serviceName,
  cloud_sql_instance: sqlInstance,
  cloud_sql_tier: sqlTier,
  redis_instance: redisInstance,
  provider,
  min_instances: DEFAULTS.minInstances,
  max_instances: maxInstances,
  cleanup_by: cleanupBy,
  cleanup_window_guard_hours: 24,
  secret_names: SECRET_NAMES,
  refused_resource_names: [...REFUSED_RESOURCE_NAMES],
  refused_production_origins: [...REFUSED_PRODUCTION_ORIGINS],
  commands,
}, null, 2));

