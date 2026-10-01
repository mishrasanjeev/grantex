#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Demo 2: one-call verification by a relying party, end to end, against the
// mock accredited issuer. No external party, no network beyond loopback.
//
//   passport issued (mock issuer) -> grant bound to it (registry) ->
//   verify() passes -> issuer revokes -> verify() denies ->
//   every adversarial fixture denied
//
// The relying party is https://merchant.example. It verifies the agent's
// signed request with grantex_verifier.verify(): passport signature against
// the registry manifest, the issuer's status list, the registry's acceptance
// list, the grant's signature, revocation state and audience, three-way key
// equality, and the transaction against the grant's constraints. Every step
// prints `live` (the registry), `fixture` (the mock issuer) or `verifier`
// (the relying party's own check). `make demo-verify`.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { COMPACT_JWS, MOCK_ISSUER_ORIGIN, REGISTRY_ORIGIN, REPO, RegistryDemo, SD_JWT_PRESENTATION, expect, findPython, http, runDemo } from './lib/registry-demo.mjs';

const MERCHANT = 'https://merchant.example';
const AUDIENCE = `${MERCHANT}/checkout`;
const COMMERCE = 'urn:grantex:commerce:v1';
const AMOUNT_MINOR = 12_500;

function decodeJwtPayload(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

await runDemo('demo-verify', async () => {
  const demo = new RegistryDemo('demo-verify');
  try {
    const python = findPython('import grantex.cli.attest, grantex_verifier, grantex_agent_httpsig');
    await demo.start();
    await demo.signup('sandbox');
    await demo.registerProvider();
    await demo.registerAgent({ resourceServers: [AUDIENCE] });
    demo.generateAgentKey(python);

    // ── the passport: issued by the mock, attested in the registry ─────────
    const passportFile = join(demo.state, 'passport.sd-jwt');
    demo.runGrantexAttest(python, ['--passport-out', passportFile]);
    const passport = readFileSync(passportFile, 'utf8').trim();
    // Only a well-formed presentation goes to the registry.
    expect(SD_JWT_PRESENTATION.test(passport), 'the passport file does not hold an SD-JWT presentation');

    // ── a grant bound to the passport, for this merchant ───────────────────
    const authorized = await http('POST', `${demo.baseUrl}/v1/authorize`, {
      headers: demo.auth,
      body: {
        agentId: demo.agent.id,
        principalId: 'user_shopper',
        scopes: ['read'],
        audience: AUDIENCE,
        passport,
        authorization_details: [{ type: COMMERCE, allowed_merchants: [MERCHANT], amount_range: { currency: 'EUR', max: '250.00' } }],
      },
    });
    expect(authorized.status === 201, `authorize answered ${authorized.status}: ${authorized.text}`);
    const requestId = authorized.json.requestId ?? authorized.json.id ?? authorized.json.authRequestId ?? '?';
    demo.step('authorization requested with the passport', 'live', `${requestId} status=${authorized.json.status ?? '?'}`);

    // A sandbox developer's request is approved as it is made and answers
    // with the code; a live one goes through the consent page (or, for a
    // sandbox developer, POST /v1/authorize/{id}/approve).
    let code = authorized.json.code;
    if (!code) {
      const approved = await http('POST', `${demo.baseUrl}/v1/authorize/${encodeURIComponent(requestId)}/approve`, { headers: demo.auth });
      expect(approved.status === 200 && approved.json.code, `approve answered ${approved.status}: ${approved.text}`);
      code = approved.json.code;
    }
    demo.step('principal consent recorded (sandbox approval)', 'live', `${requestId} code issued`);

    const exchanged = await http('POST', `${demo.baseUrl}/v1/token`, { headers: demo.auth, body: { code, agentId: demo.agent.id } });
    expect(exchanged.status === 201 || exchanged.status === 200, `token answered ${exchanged.status}: ${exchanged.text}`);
    const grant = exchanged.json.grantToken;
    // Only a compact JWS is kept; nothing else the registry might answer reaches the file.
    expect(typeof grant === 'string' && COMPACT_JWS.test(grant), 'the token answer is not a compact JWS');
    const claims = decodeJwtPayload(grant);
    const detail = (claims.authorization_details ?? []).find((d) => d.type === COMMERCE);
    expect(detail?.passport?.key_thumbprint === demo.agentKey.thumbprint, `the grant is not bound to the passport's key: ${JSON.stringify(claims.authorization_details)}`);
    expect(claims.cnf?.jkt === demo.agentKey.thumbprint, `cnf.jkt is ${claims.cnf?.jkt}, not the agent's key`);
    expect(claims.aud === AUDIENCE, `aud is ${claims.aud}, not ${AUDIENCE}`);
    const grantFile = join(demo.state, 'grant.jwt');
    writeFileSync(grantFile, `${grant}\n`, { mode: 0o600 });
    demo.step('grant issued, bound to the passport', 'live',
      `${exchanged.json.grantId} aud=${claims.aud} cnf.jkt=${claims.cnf.jkt} passport.id=${detail.passport.id} acceptance idx=${detail.acceptance_status?.idx}`);

    // ── the relying party verifies the agent's signed request ──────────────
    const verifyArgs = [
      join(REPO, 'scripts', 'demo_verify_step.py'),
      '--registry-origin', REGISTRY_ORIGIN, '--registry-loopback', demo.baseUrl,
      '--mock-origin', MOCK_ISSUER_ORIGIN, '--mock-loopback', demo.serve.origin,
      '--passport', passportFile, '--grant', grantFile, '--agent-key', demo.agentKey.file,
      '--merchant', MERCHANT, '--audience', AUDIENCE, '--amount-minor', String(AMOUNT_MINOR),
    ];
    const runVerify = (expectation) => {
      const result = spawnSync(python, [...verifyArgs, '--expect', expectation], {
        cwd: REPO, encoding: 'utf8', env: { ...process.env, GRANTEX_API_KEY: demo.apiKey },
      });
      const lines = result.stdout.trim().split('\n').filter(Boolean);
      let decision = null;
      try { decision = JSON.parse(lines[lines.length - 1]); } catch { /* no decision line */ }
      expect(decision !== null, `the verifier step printed no decision: ${result.stderr.trim()}\n${result.stdout}`);
      return { result, decision };
    };

    const first = runVerify('ok');
    const checks = Object.entries(first.decision.checks).map(([name, c]) => `${name}=${c.ok ? 'ok' : c.code}`).join(' ');
    demo.step('verify(): passport, grant, statuses, key binding, request', 'verifier', `ok=${first.decision.ok} level=${first.decision.level} tier=${first.decision.tier}`);
    demo.step('verify(): every check', 'verifier', checks);
    expect(first.result.status === 0 && first.decision.ok === true, `verify() did not pass: ${first.decision.denial_code} (${first.result.stderr.trim()})`);

    // ── the issuer revokes; the relying party denies on its next call ──────
    demo.revokeAtIssuer();
    const second = runVerify('denied');
    const failed = Object.entries(second.decision.checks).filter(([, c]) => !c.ok && c.code).map(([name, c]) => `${name}=${c.code}`).join(' ');
    demo.step('verify() after revocation', 'verifier', `ok=${second.decision.ok} denial=${second.decision.denial_code} (${failed})`);
    expect(second.result.status === 0 && second.decision.ok === false, 'verify() still passes after the issuer revoked the passport');
    expect(second.decision.denial_code === 'passport_revoked', `expected passport_revoked, got ${second.decision.denial_code}`);

    // ── the registry's acceptance entry follows within the status window ───
    const entry = detail.acceptance_status;
    const deadline = Date.now() + 30_000;
    let acceptance = await demo.acceptanceStatus(entry);
    while (!acceptance.isInvalid && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      acceptance = await demo.acceptanceStatus(entry);
    }
    expect(acceptance.isInvalid, `the registry's acceptance entry reads ${acceptance.name} after revocation`);
    const lookupUrl = `${demo.baseUrl}/v1/registry/agents/${encodeURIComponent(demo.agent.did)}`;
    const relying = await demo.pollLookup(lookupUrl, (json) => json.level !== 'attested', 30_000, demo.auth);
    demo.step('registry acceptance entry for the bound grant', 'live', `idx=${entry.idx} ${acceptance.name}; lookup level=${relying.json.level}`);

    // ── every adversarial fixture denied ───────────────────────────────────
    const pytest = spawnSync(python, ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', 'packages/verifier-py/tests/test_adversarial.py'], { cwd: REPO, encoding: 'utf8' });
    const summary = pytest.stdout.trim().split('\n').pop() ?? '';
    expect(pytest.status === 0, `adversarial fixtures: ${summary}\n${pytest.stdout}`);
    const passed = Number(/(\d+) passed/.exec(summary)?.[1] ?? 0);
    expect(passed > 0, `no adversarial fixtures ran: ${summary}`);
    demo.step('adversarial fixtures denied with their Appendix C codes', 'verifier', summary);
  } finally {
    await demo.finish();
  }
});
