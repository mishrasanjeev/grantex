import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import postgres from 'postgres';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3001';
const ISSUER = `http://host.docker.internal:9919/idp-${randomUUID()}`;
const REDIRECT = process.env.E2E_REDIRECT_URL ?? `${BASE}/dashboard/sso/callback`;
const CLIENT_ID = 'local-sso-test';
const CLIENT_SECRET = 'local-sso-test-secret';
const db = postgres(process.env.E2E_DATABASE_URL ?? 'postgres://grantex:grantex@localhost:5432/grantex');
const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(publicKey), alg: 'RS256', use: 'sig', kid: 'local-test-key' };
const codes = new Map();

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

const idp = createServer(async (req, res) => {
  const url = new URL(req.url, ISSUER);
  if (url.pathname.endsWith('/.well-known/openid-configuration')) {
    return json(res, 200, {
      issuer: ISSUER, authorization_endpoint: `${ISSUER.replace('host.docker.internal', 'localhost')}/authorize`,
      token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/jwks`,
    });
  }
  if (url.pathname.endsWith('/jwks')) return json(res, 200, { keys: [jwk] });
  if (url.pathname.endsWith('/authorize')) {
    if (url.searchParams.get('client_id') !== CLIENT_ID || url.searchParams.get('redirect_uri') !== REDIRECT) {
      return json(res, 400, { error: 'invalid_request' });
    }
    const code = randomUUID();
    codes.set(code, {
      nonce: url.searchParams.get('nonce'), redirectUri: REDIRECT,
      subject: url.searchParams.get('test-subject') ?? 'local-subject',
      email: url.searchParams.get('test-email') ?? 'user@example.test',
    });
    const next = new URL(REDIRECT);
    next.searchParams.set('code', code);
    next.searchParams.set('state', url.searchParams.get('state') ?? '');
    res.writeHead(302, { Location: next.toString(), 'Cache-Control': 'no-store' });
    return res.end();
  }
  if (url.pathname.endsWith('/token') && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const form = new URLSearchParams(body);
    const code = form.get('code');
    const record = codes.get(code);
    if (!record || form.get('client_id') !== CLIENT_ID || form.get('client_secret') !== CLIENT_SECRET
      || form.get('redirect_uri') !== record.redirectUri) return json(res, 400, { error: 'invalid_grant' });
    codes.delete(code);
    const idToken = await new SignJWT({ email: record.email, name: 'Test User', nonce: record.nonce, groups: ['admins'] })
      .setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).setIssuer(ISSUER).setAudience(CLIENT_ID)
      .setSubject(record.subject).setIssuedAt().setExpirationTime('5m').sign(privateKey);
    return json(res, 200, { id_token: idToken, token_type: 'Bearer' });
  }
  return json(res, 404, { error: 'not_found' });
});

async function request(path, { key, method = 'GET', body } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}

function assert(condition, description) {
  if (!condition) throw new Error(description);
  process.stdout.write(`PASS ${description}\n`);
}

async function login(org, subject = 'local-subject', email = 'user@example.test', expectedStatus = 200, checkReplay = false) {
  const start = await request(`/sso/login?org=${encodeURIComponent(org)}&redirect_uri=${encodeURIComponent(REDIRECT)}`);
  assert(start.status === 200 && start.data.protocol === 'oidc', 'OIDC login starts');
  const localAuthorize = new URL(start.data.authorizeUrl);
  localAuthorize.host = 'localhost:9919';
  localAuthorize.searchParams.set('test-subject', subject);
  localAuthorize.searchParams.set('test-email', email);
  const challenge = await fetch(localAuthorize, { redirect: 'manual' });
  assert(challenge.status === 302, 'local IdP issues authorization code');
  const callback = new URL(challenge.headers.get('location'));
  const finish = await request('/sso/callback/oidc', {
    method: 'POST', body: { code: callback.searchParams.get('code'), state: callback.searchParams.get('state'), redirect_uri: REDIRECT },
  });
  assert(finish.status === expectedStatus && (expectedStatus !== 200 || finish.data.sessionToken?.startsWith('gx_sso_')),
    expectedStatus === 200 ? `signed ID token yields opaque SSO session (${finish.status})`
      : `SSO callback rejects identity conflict (${finish.status})`);
  if (checkReplay) {
    const replay = await request('/sso/callback/oidc', {
      method: 'POST', body: { code: callback.searchParams.get('code'), state: callback.searchParams.get('state'), redirect_uri: REDIRECT },
    });
    assert(replay.status === 400, 'OIDC callback replay rejected');
  }
  return finish.data;
}

async function main() {
  await new Promise((resolve) => idp.listen(9919, '0.0.0.0', resolve));
  const account = await request('/v1/signup', { method: 'POST', body: { name: `sso-e2e-${Date.now()}`, mode: 'sandbox' } });
  assert(account.status === 201, 'sandbox organization created');
  const key = account.data.apiKey;
  const org = account.data.developerId;
  const connection = await request('/v1/sso/connections', { key, method: 'POST', body: {
    name: 'Local test IdP', protocol: 'oidc', issuerUrl: ISSUER, clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET, jitProvisioning: true, groupAttribute: 'groups',
    groupMappings: { admins: ['admin'] }, defaultScopes: ['read'],
  } });
  assert(connection.status === 201, 'OIDC connection created');
  const first = await login(org, 'local-subject', 'user@example.test', 200, true);
  const admin = await request('/v1/me', { key: first.sessionToken });
  assert(admin.status === 200 && admin.data.humanSession === true, `admin SSO token authorizes dashboard API (${admin.status} ${admin.data.code ?? ''})`);
  const enforced = await request('/v1/sso/enforce', { key, method: 'POST', body: { enforce: true } });
  assert(enforced.status === 200 && enforced.data.enforce, 'organization policy enabled');
  const stale = await request('/v1/me', { key: first.sessionToken });
  assert(stale.status === 401, 'pre-enforcement browser session invalidated');
  const machine = await request('/v1/me', { key });
  assert(machine.status === 200 && machine.data.ssoEnforced && !machine.data.humanSession, 'machine API key remains usable');
  const second = await login(org);
  assert(second.principalId === first.principalId, 'principal identity preserved across enforcement');
  const other = await login(org, 'other-subject', 'other@example.test');
  assert(other.principalId !== second.principalId, 'distinct IdP subject has distinct principal');
  const racePrincipalId = `scimuser_${randomUUID()}`;
  await db`INSERT INTO scim_users (id, developer_id, external_id, user_name, active)
    VALUES (${racePrincipalId}, ${org}, 'race-subject', 'race@example.test', true)`;
  await db`INSERT INTO sso_sessions (id, developer_id, connection_id, principal_id, idp_subject,
      groups, mapped_scopes, expires_at, subject_namespace_version)
    VALUES (${`ssosess_${randomUUID()}`}, ${org}, ${connection.data.id}, ${racePrincipalId},
      'race-subject', ARRAY['admins'], ARRAY['admin'], NOW() + INTERVAL '1 hour', 0)`;
  const raceLogin = await login(org, 'race-subject', 'race@example.test');
  assert(raceLogin.principalId === racePrincipalId, 'late legacy login is promoted only with session binding proof');
  await db`INSERT INTO scim_users (id, developer_id, external_id, user_name, active)
    VALUES (${`scimuser_${randomUUID()}`}, ${org}, 'unrelated-subject', 'conflict@example.test', true)`;
  const conflict = await login(org, 'new-subject', 'conflict@example.test', 409);
  assert(conflict.code === 'SSO_IDENTITY_CONFLICT', 'same email without identity proof fails closed');
  const agent = await request('/v1/agents', { key, method: 'POST', body: { name: 'Local test agent', scopes: ['read'] } });
  assert(agent.status === 201, 'agent created');
  const auth = await request('/v1/authorize', { key, method: 'POST', body: {
    agentId: agent.data.agentId, principalId: second.principalId, scopes: ['read'],
  } });
  assert(auth.status === 200 || auth.status === 201, 'authorization request created');
  const authRequestId = auth.data.authRequestId;
  await db`UPDATE auth_requests SET status = 'pending', fido_verified = TRUE WHERE id = ${authRequestId}`;
  const path = `/v1/consent/${encodeURIComponent(authRequestId)}/approve`;
  const missing = await request(path, { method: 'POST' });
  assert(missing.status === 403 && missing.data.code === 'SSO_REQUIRED', 'consent without SSO fails closed');
  const wrongPrincipal = await request(path, { key: other.sessionToken, method: 'POST' });
  assert(wrongPrincipal.status === 403 && wrongPrincipal.data.code === 'SSO_REQUIRED', 'other principal cannot approve');
  const approved = await request(path, { key: second.sessionToken, method: 'POST' });
  assert(approved.status === 200 && typeof approved.data.code === 'string', 'matching SSO principal can approve');

  const otherAccount = await request('/v1/signup', { method: 'POST', body: { name: `other-sso-e2e-${Date.now()}`, mode: 'sandbox' } });
  assert(otherAccount.status === 201, 'second organization created');
  const otherKey = otherAccount.data.apiKey;
  const otherOrg = otherAccount.data.developerId;
  const otherConnection = await request('/v1/sso/connections', { key: otherKey, method: 'POST', body: {
    name: 'Second local IdP connection', protocol: 'oidc', issuerUrl: ISSUER, clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET, jitProvisioning: true, groupAttribute: 'groups',
    groupMappings: { admins: ['admin'] }, defaultScopes: ['read'],
  } });
  assert(otherConnection.status === 201, 'second organization SSO configured');
  await login(otherOrg);
  const otherEnforce = await request('/v1/sso/enforce', { key: otherKey, method: 'POST', body: { enforce: true } });
  assert(otherEnforce.status === 200, 'second organization enforcement enabled');
  const otherHuman = await login(otherOrg);
  const otherAgent = await request('/v1/agents', { key: otherKey, method: 'POST', body: { name: 'Other tenant agent', scopes: ['read'] } });
  const otherAuth = await request('/v1/authorize', { key: otherKey, method: 'POST', body: {
    agentId: otherAgent.data.agentId, principalId: otherHuman.principalId, scopes: ['read'],
  } });
  await db`UPDATE auth_requests SET status = 'pending', fido_verified = TRUE WHERE id = ${otherAuth.data.authRequestId}`;
  const crossTenant = await request(`/v1/consent/${encodeURIComponent(otherAuth.data.authRequestId)}/approve`, {
    key: second.sessionToken, method: 'POST',
  });
  assert(crossTenant.status === 403 && crossTenant.data.code === 'SSO_REQUIRED', 'SSO session cannot cross organization boundary');
  const ownTenant = await request(`/v1/consent/${encodeURIComponent(otherAuth.data.authRequestId)}/approve`, {
    key: otherHuman.sessionToken, method: 'POST',
  });
  assert(ownTenant.status === 200, 'same-tenant principal approves');

  const denialRequest = await request('/v1/authorize', { key, method: 'POST', body: {
    agentId: agent.data.agentId, principalId: second.principalId, scopes: ['read'],
  } });
  await db`UPDATE auth_requests SET status = 'pending', fido_verified = TRUE WHERE id = ${denialRequest.data.authRequestId}`;
  const denialPath = `/v1/consent/${encodeURIComponent(denialRequest.data.authRequestId)}/deny`;
  const wrongDeny = await request(denialPath, { key: other.sessionToken, method: 'POST' });
  assert(wrongDeny.status === 403 && wrongDeny.data.code === 'SSO_REQUIRED', 'other principal cannot deny');
  const deniedByPrincipal = await request(denialPath, { key: second.sessionToken, method: 'POST' });
  assert(deniedByPrincipal.status === 200, 'matching principal can deny');

  const expiring = await login(org);
  await db`UPDATE sso_sessions SET expires_at = NOW() - INTERVAL '1 second' WHERE id = ${expiring.sessionId}`;
  const expired = await request('/v1/me', { key: expiring.sessionToken });
  assert(expired.status === 401, 'expired SSO session rejected');

  const auth2 = await request('/v1/authorize', { key, method: 'POST', body: {
    agentId: agent.data.agentId, principalId: second.principalId, scopes: ['read'],
  } });
  await db`UPDATE auth_requests SET status = 'pending', fido_verified = TRUE WHERE id = ${auth2.data.authRequestId}`;
  const revoked = await request(`/v1/sso/sessions/${encodeURIComponent(second.sessionId)}`, { key, method: 'DELETE' });
  assert(revoked.status === 204, 'SSO session revoked');
  const denied = await request(`/v1/consent/${encodeURIComponent(auth2.data.authRequestId)}/approve`, { key: second.sessionToken, method: 'POST' });
  assert(denied.status === 403 && denied.data.code === 'SSO_REQUIRED', 'revoked session cannot approve');

  const rollbackAccount = await request('/v1/signup', { method: 'POST', body: { name: `sso-rollback-${Date.now()}`, mode: 'sandbox' } });
  const rollbackOrg = rollbackAccount.data.developerId;
  const rollbackKey = rollbackAccount.data.apiKey;
  const rollbackConnection = await request('/v1/sso/connections', { key: rollbackKey, method: 'POST', body: {
    name: 'Rollback test IdP', protocol: 'oidc', issuerUrl: ISSUER, clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET, jitProvisioning: true, groupAttribute: 'groups',
    groupMappings: { admins: ['admin'] }, defaultScopes: ['read'],
  } });
  assert(rollbackConnection.status === 201, 'rollback organization configured');
  await login(rollbackOrg, 'rollback-one', 'one@example.test');
  await login(rollbackOrg, 'rollback-two', 'two@example.test');
  const legacy = await db`SELECT id, external_id FROM scim_users WHERE developer_id = ${rollbackOrg} ORDER BY id`;
  assert(legacy.length === 2, 'two legacy principals available for migration');
  await db`UPDATE scim_users SET external_id = 'unrelated-subject' WHERE id = ${legacy[1].id}`;
  const rejectedEnable = await request('/v1/sso/enforce', { key: rollbackKey, method: 'POST', body: { enforce: true } });
  assert(rejectedEnable.status === 409 && rejectedEnable.data.code === 'SSO_IDENTITY_CONFLICT', 'partial identity migration rejected');
  const unchanged = await db`SELECT external_id FROM scim_users WHERE id = ${legacy[0].id}`;
  const policy = await db`SELECT sso_enforced, sso_subject_namespace FROM developers WHERE id = ${rollbackOrg}`;
  assert(unchanged[0].external_id === legacy[0].external_id
    && !policy[0].sso_enforced && !policy[0].sso_subject_namespace, 'failed migration rolls back every principal and policy flag');
  if (process.env.E2E_BROWSER_HOLD === 'true') {
    process.stdout.write(`BROWSER_ORG=${org}\n`);
    await new Promise((resolve) => process.once('SIGINT', resolve));
  }
}

try {
  await main();
} finally {
  idp.close();
  await db.end();
}
