import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parse } from 'yaml';
import { hostingPreflight } from '../../scripts/firebase-hosting-preflight.mjs';

const account = { type: 'service_account', client_email: 'synthetic-deployer@synthetic-project.iam.gserviceaccount.com',
  private_key_id: 'a'.repeat(40), private_key: '-----BEGIN PRIVATE KEY-----synthetic-only',
  token_uri: 'https://oauth2.googleapis.com/token' };
const enabled = { state: 'ENABLED', config: { name: 'firebasehosting.googleapis.com' } };
const sha = (value) => createHash('sha256').update(value).digest('hex');
function fixture(overrides = {}) {
  const reports = [], calls = [];
  return { reports, calls, options: { credentialJson: JSON.stringify(account), credentialFileJson: JSON.stringify(account),
    projectId: 'synthetic-project', report: (value) => reports.push(value),
    getAccessToken: async (email) => { assert.equal(email, account.client_email); return 'synthetic-bearer-token\n'; },
    request: async (url, options) => { calls.push({ url, options }); return Response.json(enabled); }, ...overrides } };
}

test('preflight uses only the fixed read-only service-state request and reports identity hashes', async () => {
  const f = fixture();
  assert.equal((await hostingPreflight(f.options)).permissionGranted, true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'https://serviceusage.googleapis.com/v1/projects/synthetic-project/services/firebasehosting.googleapis.com');
  assert.equal(f.calls[0].options.method, 'GET');
  assert.equal(f.calls[0].options.redirect, 'error');
  assert.equal(f.calls[0].options.headers.authorization, 'Bearer synthetic-bearer-token');
  assert.equal(f.reports[0].accountSha256, sha(account.client_email));
  assert.equal(f.reports[0].keyIdSha256, sha(account.private_key_id));
  for (const value of [account.client_email, account.private_key_id, account.private_key, 'synthetic-bearer-token']) {
    assert(!JSON.stringify(f.reports).includes(value));
  }
});

for (const status of [401, 403, 500]) {
  test(`preflight fails closed on HTTP ${status} without logging response bodies`, async () => {
    const f = fixture({ request: async () => Response.json({ private: 'synthetic-sensitive-response' }, { status }) });
    await assert.rejects(hostingPreflight(f.options), new RegExp(`HTTP ${status}`));
    assert.equal(f.reports.at(-1).permissionGranted, false);
    assert(!JSON.stringify(f.reports).includes('synthetic-sensitive-response'));
  });
}

for (const field of ['client_email', 'private_key_id', 'private_key', 'token_uri']) {
  test(`preflight rejects a different active ${field} before authentication`, async () => {
    const f = fixture({ credentialFileJson: JSON.stringify({ ...account, [field]: field === 'client_email'
      ? 'other@synthetic-project.iam.gserviceaccount.com' : field === 'private_key_id' ? 'b'.repeat(40)
        : field === 'private_key' ? account.private_key + '-other' : 'https://provider.example/token' }),
    getAccessToken: async () => assert.fail('must not authenticate') });
    await assert.rejects(hostingPreflight(f.options), /credential/i);
    assert.equal(f.calls.length, 0);
    assert.equal(f.reports.length, 0);
  });
}

test('malformed credentials, project paths and empty tokens fail closed', async () => {
  for (const overrides of [{ credentialJson: '{}' }, { credentialJson: 'invalid' },
    { projectId: 'synthetic-project/other' }, { getAccessToken: async () => '' }]) {
    const f = fixture(overrides);
    await assert.rejects(hostingPreflight(f.options));
    assert.equal(f.calls.length, 0);
  }
});

test('authentication and transport errors cannot disclose raw error details', async () => {
  for (const overrides of [{ getAccessToken: async () => { throw new Error(account.private_key); } },
    { request: async () => { throw new Error('synthetic-bearer-token'); } }]) {
    const f = fixture(overrides);
    await assert.rejects(hostingPreflight(f.options), (error) => !error.message.includes(account.private_key)
      && !error.message.includes('synthetic-bearer-token'));
  }
});

test('preflight never enables a disabled service or trusts another service response', async () => {
  for (const body of [{ ...enabled, state: 'DISABLED' }, { state: 'ENABLED', config: { name: 'other.googleapis.com' } }]) {
    const f = fixture({ request: async () => Response.json(body) });
    await assert.rejects(hostingPreflight(f.options), /not confirmed enabled/);
  }
});

test('CLI refuses missing, mismatched and impersonated credential environments', () => {
  const script = new URL('../../scripts/firebase-hosting-preflight.mjs', import.meta.url);
  for (const env of [{}, { GOOGLE_GHA_CREDS_PATH: '/synthetic-missing-file' },
    { GOOGLE_GHA_CREDS_PATH: '/synthetic', CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: '/synthetic',
      GOOGLE_APPLICATION_CREDENTIALS: '/synthetic', CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT: account.client_email },
    { GOOGLE_GHA_CREDS_PATH: '/synthetic', CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: '/synthetic',
      GOOGLE_APPLICATION_CREDENTIALS: '/synthetic', CLOUDSDK_AUTH_ACCESS_TOKEN: 'synthetic-bearer-token' }]) {
    const child = spawnSync(process.execPath, [fileURLToPath(script)], { env, encoding: 'utf8', timeout: 5000 });
    assert.equal(child.status, 1);
    assert.match(child.stderr, /credential override without impersonation/);
    assert(!child.stderr.includes(account.client_email));
    assert(!child.stderr.includes('synthetic-bearer-token'));
  }
});

test('manual Portal runs default to preflight only and every deployment step is guarded', () => {
  const workflow = parse(readFileSync(new URL('../../.github/workflows/deploy-portal.yml', import.meta.url), 'utf8'));
  assert.equal(workflow.on.workflow_dispatch.inputs.preflight_only.type, 'boolean');
  assert.equal(workflow.on.workflow_dispatch.inputs.preflight_only.default, true);
  const steps = workflow.jobs.deploy.steps;
  const authenticate = steps.findIndex((step) => step.name === 'Authenticate with the existing Portal deployment credential');
  const preflight = steps.findIndex((step) => step.run === 'node scripts/firebase-hosting-preflight.mjs');
  assert(authenticate > 0 && preflight > authenticate);
  assert.equal(steps[authenticate].with.credentials_json, '${{ secrets.FIREBASE_SERVICE_ACCOUNT }}');
  assert.equal(steps[authenticate].with.create_credentials_file, true);
  assert.equal(steps[authenticate].with.cleanup_credentials, true);
  assert.equal(steps[preflight].env.FIREBASE_SERVICE_ACCOUNT, '${{ secrets.FIREBASE_SERVICE_ACCOUNT }}');
  for (const name of ['Install portal dependencies', 'Build portal', 'Copy portal build to web/dashboard',
    'Deploy to Firebase Hosting', 'Smoke test Firebase -> Cloud Run rewrites']) {
    const index = steps.findIndex((step) => step.name === name);
    assert(index >= 0);
    if (name === 'Deploy to Firebase Hosting' || name === 'Smoke test Firebase -> Cloud Run rewrites') assert(index > preflight);
    else assert(index < authenticate, 'install/build must finish before deployment credentials are available');
    assert.equal(steps[index].if, "${{ github.event_name != 'workflow_dispatch' || inputs.preflight_only == false }}");
  }
  assert(!steps[preflight]['continue-on-error']);
  assert.equal(steps.find((step) => step.name === 'Deploy to Firebase Hosting').with.firebaseServiceAccount,
    '${{ secrets.FIREBASE_SERVICE_ACCOUNT }}');
});
