#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Demo 1: developer opt-in attestation, end to end, against the mock
// accredited issuer. No external party, no network beyond loopback.
//
//   register agent -> prove key -> request attestation -> level attested ->
//   lookup shows it -> issuer revokes -> level drops and lookup shows revoked
//
// Every step prints `live` (the registry, a real auth-service process on a
// local port backed by the Postgres in DATABASE_URL) or `fixture` (the mock
// issuer, packages/mock-issuer). The script exits non-zero at the first step
// whose outcome is not the expected one.
//
// Needs: Postgres (DATABASE_URL) and Redis (REDIS_URL), Node 24+, a Python
// with the SDK installed from packages/sdk-py (DEMO_PYTHON, default python3
// then python), apps/auth-service built (npm run build), packages/agent-passport
// built and packages/mock-issuer installed (make install). `make demo-attest`.

import { RegistryDemo, TRUST_MARKS, expect, findPython, http, runDemo, summarizeAttestations } from './lib/registry-demo.mjs';

const REVOCATION_TIMEOUT_MS = 30_000;
const LOOKUP_SETTLE_MS = 15_000;

await runDemo('demo-attest', async () => {
  const demo = new RegistryDemo('demo-attest');
  try {
    const python = findPython();
    await demo.start();
    await demo.signup();
    await demo.registerProvider();
    await demo.registerAgent();
    demo.generateAgentKey(python);

    // ── the attestation step: one command ──────────────────────────────────
    demo.runGrantexAttest(python);

    // ── the public lookup shows it ─────────────────────────────────────────
    const lookupUrl = `${demo.baseUrl}/v1/registry/agents/${encodeURIComponent(demo.agent.did)}`;
    const shown = await demo.pollLookup(lookupUrl, (json) => json.level === 'attested', LOOKUP_SETTLE_MS);
    expect(shown.json.level === 'attested', `public lookup shows level ${shown.json.level}, expected attested: ${shown.text}`);
    demo.step('public lookup (no API key) shows the level', 'live', `level=${shown.json.level} attestations: ${summarizeAttestations(shown.json)} (${shown.polls} polls)`);

    // ── a relying party reads the status list entries behind the level ─────
    const relying = await http('GET', lookupUrl, { headers: demo.auth });
    expect(relying.status === 200, `relying-party lookup answered ${relying.status}: ${relying.text}`);
    const identity = (relying.json.attestations ?? []).find((a) => a.type === TRUST_MARKS[0]);
    expect(identity?.acceptance_status_list?.uri, `relying-party lookup carries no acceptance list entry: ${relying.text}`);
    const before = await demo.acceptanceStatus(identity.acceptance_status_list);
    expect(before.isValid, `acceptance entry reads ${before.name} before revocation`);
    demo.step('relying-party lookup (API key): acceptance entry', 'live', `${identity.acceptance_status_list.uri} idx=${identity.acceptance_status_list.idx} ${before.name}`);

    // ── the issuer revokes; the registry notices through the status list ───
    demo.revokeAtIssuer();
    const after = await demo.pollLookup(lookupUrl, (json) => json.level !== 'attested', REVOCATION_TIMEOUT_MS);
    expect(after.json.level !== 'attested', `level is still attested ${REVOCATION_TIMEOUT_MS / 1000}s after revocation: ${after.text}`);
    demo.step('level dropped; revoked attestations no longer listed', 'live', `level=${after.json.level} attestations: ${summarizeAttestations(after.json)} (${after.polls} polls)`);

    // The registry's own word on it: the acceptance entry is INVALID.
    const deadline = Date.now() + REVOCATION_TIMEOUT_MS;
    let acceptance = await demo.acceptanceStatus(identity.acceptance_status_list);
    while (!acceptance.isInvalid && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      acceptance = await demo.acceptanceStatus(identity.acceptance_status_list);
    }
    expect(acceptance.isInvalid, `acceptance entry reads ${acceptance.name} after revocation`);
    demo.step('acceptance list shows the attestation revoked', 'live', `idx=${identity.acceptance_status_list.idx} ${acceptance.name}`);
  } finally {
    await demo.finish();
  }
});
