/**
 * Reference DecisionVerifier (PRD G-3) wired to the TypeScript SDK's decision
 * grant verification, through the Express middleware: decision_required in
 * WWW-Authenticate without a grant, decision_invalid with the sub-reason for a
 * wrong one, and one successful call per grant.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import * as jose from 'jose';
import { requireMcpAuth } from '../src/middleware/express.js';
import type { McpAuthRequest } from '../src/middleware/express.js';
import { toolPolicyFromManifests } from '../src/resource/tool-policy.js';
import { DECISION_GRANT_HEADER, grantexDecisionVerifier } from '../src/resource/grantex-decisions.js';
import { verifyDecisionGrants, type DecisionGrantSet } from '../../sdk-ts/src/decisions/verify.js';
import { computeActionHash } from '../../sdk-ts/src/decisions/action.js';

const RESOURCE = 'https://mcp.example.com/mcp';
const tools = toolPolicyFromManifests([{
  connector: 'acme_kyb',
  tools: { case_decision: { permission: 'write', requires_decision: true, four_eyes_on: ['decline'] } },
}]);

let privateKey: jose.CryptoKey;
let jwks: Server;
let issuer: string;

beforeAll(async () => {
  const pair = await jose.generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const jwk = { ...(await jose.exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  jwks = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => jwks.listen(0, '127.0.0.1', resolve));
  const address = jwks.address();
  issuer = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => jwks.close(() => resolve()));
});

const ACTION = { case_id: 'case_8841', action: 'case_decision', decision: 'approve', subject: 'gb:00000001' };
let jtiCounter = 0;
const jti = () => `dgnt_01K8Z0000000000000000000${String(++jtiCounter).padStart(2, '0')}`.slice(0, 31);

function grantToken(): Promise<string> {
  return new jose.SignJWT({ scp: ['tool:acme_kyb:write'], aud: RESOURCE, dev: 'dev_01', grnt: 'grnt_01' })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(issuer).setSubject('client-a').setJti('tok_1').setIssuedAt().setExpirationTime('1h')
    .sign(privateKey);
}

function decisionGrant(overrides: Record<string, unknown> = {}): Promise<string> {
  const action = (overrides['action'] as typeof ACTION | undefined) ?? ACTION;
  const now = Math.floor(Date.now() / 1000);
  return new jose.SignJWT({
    dev: 'dev_01', idp: 'https://idp.example.com', approver_auth: 'sso+hwk', amr: ['hwk'], auth_time: now - 60,
    action, action_hash: computeActionHash(action), connector: 'acme_kyb', case_version: 'v7', dwell_ms: 42000,
    decision_request: 'dreq_01K8Z000000000000000000QR1', ...overrides,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1', typ: 'decision+jwt' })
    .setIssuer(issuer).setAudience('urn:grantex:decision').setSubject('user:approver-a').setJti(jti())
    .setIssuedAt(now).setExpirationTime(now + 3600)
    .sign(privateKey);
}

async function callTool(verifier: ReturnType<typeof grantexDecisionVerifier>, headers: Record<string, string>, args: Record<string, unknown>) {
  const mw = requireMcpAuth({ issuer, audience: RESOURCE, tools, decisions: verifier, warn: () => {} });
  const server = createServer((raw: IncomingMessage, res: ServerResponse) => {
    const req = raw as McpAuthRequest;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      (req as unknown as { body: unknown }).body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const response = res as ServerResponse & { status: (n: number) => typeof response; json: (b: unknown) => void; set: (k: string, v: string) => typeof response };
      response.status = (n: number) => { res.statusCode = n; return response; };
      response.set = (k: string, v: string) => { res.setHeader(k, v); return response; };
      response.json = (b: unknown) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(b)); };
      void mw(req, response as never, () => response.status(200).json({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await grantToken()}`, ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'case_decision', arguments: args } }),
    });
    return { status: res.status, challenge: res.headers.get('www-authenticate'), body: (await res.json()) as Record<string, unknown> };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function verifierWithIssuer() {
  const consumed = new Set<string>();
  const consume = vi.fn(async (set: DecisionGrantSet) => {
    const jtis = set.grants.map((g) => g.jti);
    if (jtis.some((j) => consumed.has(j))) throw Object.assign(new Error('used'), { subReason: 'consumed' });
    jtis.forEach((j) => consumed.add(j));
    return { consumed: true };
  });
  const verifier = grantexDecisionVerifier({
    issuer,
    verify: (tokens, action, caseVersion, options) => verifyDecisionGrants(tokens, action, caseVersion, options),
    consume,
    caseVersion: (caseId) => (caseId === 'case_8841' ? 'v7' : undefined),
  });
  return { verifier, consume };
}

const args = { case_id: 'case_8841', decision: 'approve', subject: 'gb:00000001', planned_at: '2026-09-15T10:00:00Z' };

describe('grantexDecisionVerifier', () => {
  it('returns decision_required in WWW-Authenticate when no decision grant is presented', async () => {
    const { verifier, consume } = verifierWithIssuer();
    const outcome = await callTool(verifier, {}, args);
    expect(outcome.status).toBe(403);
    expect(outcome.challenge).toContain('error="insufficient_authorization"');
    expect(outcome.challenge).toContain('decision_required="acme_kyb:case_decision"');
    expect(outcome.body).toMatchObject({ reason: 'decision_required' });
    expect(consume).not.toHaveBeenCalled();
  });

  it('allows one call per decision grant: replay is decision_invalid / consumed', async () => {
    const { verifier, consume } = verifierWithIssuer();
    const token = await decisionGrant();
    expect((await callTool(verifier, { [DECISION_GRANT_HEADER]: token }, args)).status).toBe(200);
    const replay = await callTool(verifier, { [DECISION_GRANT_HEADER]: token }, args);
    expect(replay.status).toBe(403);
    expect(replay.body).toMatchObject({ reason: 'decision_invalid', sub_reason: 'consumed' });
    expect(replay.challenge).toContain('decision_required="acme_kyb:case_decision"');
    expect(consume).toHaveBeenCalledTimes(2);
  });

  it.each([
    [{ ...args, decision: 'decline' }, 'action_mismatch'],
    [{ ...args, case_id: 'case_9999' }, 'case_changed'],
    [{ ...args, subject: 'gb:00000002' }, 'action_mismatch'],
    [{ case_id: 'case_8841' }, 'malformed'],
  ])('refuses %o with %s and never consumes', async (callArgs, subReason) => {
    const { verifier, consume } = verifierWithIssuer();
    const outcome = await callTool(verifier, { [DECISION_GRANT_HEADER]: await decisionGrant() }, callArgs);
    expect(outcome.body).toMatchObject({ reason: 'decision_invalid', sub_reason: subReason });
    expect(consume).not.toHaveBeenCalled();
  });

  it('never answers valid when the issuer cannot confirm consumption', async () => {
    const verifier = grantexDecisionVerifier({
      issuer,
      verify: (tokens, action, caseVersion, options) => verifyDecisionGrants(tokens, action, caseVersion, options),
      consume: async () => { throw new Error('connection refused'); },
      caseVersion: () => 'v7',
    });
    const outcome = await callTool(verifier, { [DECISION_GRANT_HEADER]: await decisionGrant() }, args);
    expect(outcome.body).toMatchObject({ reason: 'decision_invalid', sub_reason: 'consume_unavailable' });
  });

  it('requires two approvers for a decision in four_eyes_on', async () => {
    const { verifier } = verifierWithIssuer();
    const decline = { ...ACTION, decision: 'decline' };
    const outcome = await callTool(verifier, { [DECISION_GRANT_HEADER]: await decisionGrant({ action: decline }) }, { ...args, decision: 'decline' });
    expect(outcome.body).toMatchObject({ reason: 'decision_invalid', sub_reason: 'four_eyes_incomplete' });
  });

  it('refuses more than two or malformed tokens in the header', async () => {
    const { verifier } = verifierWithIssuer();
    const token = await decisionGrant();
    expect((await callTool(verifier, { [DECISION_GRANT_HEADER]: [token, token, token].join(',') }, args)).body).toMatchObject({ sub_reason: 'malformed' });
    expect((await callTool(verifier, { [DECISION_GRANT_HEADER]: 'not a token' }, args)).body).toMatchObject({ sub_reason: 'malformed' });
  });
});
