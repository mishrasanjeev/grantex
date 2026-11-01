import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const scope = 'https://www.googleapis.com/auth/cloud-platform.read-only';
const digest = (value) => createHash('sha256').update(value).digest('hex');

function credential(value) {
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw new Error('Invalid Portal credential JSON'); }
  if (parsed?.type !== 'service_account'
    || !/^[a-z0-9._-]+@[a-z0-9.-]+\.gserviceaccount\.com$/.test(parsed.client_email ?? '')
    || !/^[a-f0-9]{40}$/.test(parsed.private_key_id ?? '')
    || typeof parsed.private_key !== 'string' || !parsed.private_key.startsWith('-----BEGIN PRIVATE KEY-----')
    || parsed.token_uri !== 'https://oauth2.googleapis.com/token') {
    throw new Error('Unexpected Portal service-account credential');
  }
  return parsed;
}

export async function hostingPreflight({ credentialJson, credentialFileJson, getAccessToken,
  request = fetch, report = (value) => console.log(JSON.stringify(value)), projectId = 'grantex-prod' }) {
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) throw new Error('Invalid deployment project');
  const original = credential(credentialJson);
  const active = credential(credentialFileJson);
  for (const key of ['client_email', 'private_key_id', 'private_key', 'token_uri']) {
    if (original[key] !== active[key]) throw new Error('Active credential differs from existing Portal secret');
  }
  let token;
  try { token = await getAccessToken(original.client_email); }
  catch { throw new Error('Existing Portal credential authentication failed'); }
  if (typeof token !== 'string' || !token.trim() || /\s/.test(token.trim())) {
    throw new Error('Existing Portal credential returned no valid access token');
  }
  // Hash identifiers so public CI logs do not disclose the deployment account or key ID.
  report({ phase: 'authenticated-identity', accountSha256: digest(original.client_email),
    keyIdSha256: digest(original.private_key_id), readOnlyScope: true, projectId });
  let response;
  try {
    response = await request(`https://serviceusage.googleapis.com/v1/projects/${projectId}/services/firebasehosting.googleapis.com`, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { authorization: `Bearer ${token.trim()}`, 'x-goog-user-project': projectId },
    });
  } catch { throw new Error('Hosting service preflight request failed'); }
  if (response.status !== 200) {
    report({ phase: 'hosting-service', status: response.status, permissionGranted: false });
    throw new Error(`Hosting service preflight failed (HTTP ${response.status})`);
  }
  let service;
  try { service = await response.json(); } catch { throw new Error('Invalid Hosting service response'); }
  if (service?.state !== 'ENABLED' || service?.config?.name !== 'firebasehosting.googleapis.com') {
    throw new Error('Hosting service is not confirmed enabled');
  }
  const result = { phase: 'hosting-service', status: 200, permissionGranted: true,
    serviceEnabled: true, projectId };
  report(result);
  return result;
}

async function main() {
  const path = process.env.GOOGLE_GHA_CREDS_PATH;
  if (!path || process.env.CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE !== path
    || process.env.GOOGLE_APPLICATION_CREDENTIALS !== path
    || process.env.CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT
    || process.env.CLOUDSDK_AUTH_ACCESS_TOKEN || process.env.CLOUDSDK_AUTH_ACCESS_TOKEN_FILE) {
    throw new Error('Expected existing Portal credential override without impersonation');
  }
  let file;
  try { file = await readFile(path, 'utf8'); } catch { throw new Error('Portal credential file is unavailable'); }
  await hostingPreflight({ credentialJson: process.env.FIREBASE_SERVICE_ACCOUNT,
    credentialFileJson: file, getAccessToken: async (account) => {
      const { stdout } = await run('gcloud', ['auth', 'print-access-token', '--quiet',
        `--account=${account}`, `--scopes=${scope}`], { timeout: 30_000, maxBuffer: 1024 * 1024 });
      return stdout;
    } });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
