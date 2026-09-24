/**
 * The TypeScript examples in docs/concepts/decision-grants.md are the files in
 * tests/docs/examples, embedded verbatim (checked here) and exercised here, so
 * the documentation cannot drift from the SDK.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SignJWT, generateKeyPair, type JWTPayload } from 'jose';
import type { DecisionAction } from '../src/decisions/action.js';
import { computeActionHash } from '../src/decisions/action.js';
import type { DecisionConsumer } from '../src/resources/decisions.js';
import type { VerifiedGrant } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const keys = vi.hoisted(() => ({ publicKey: undefined as unknown }));

vi.mock('../src/verify.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/verify.js')>();
  return { ...actual, verifyGrantToken: vi.fn() };
});
vi.mock('../src/decisions/verify.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/decisions/verify.js')>();
  return {
    ...actual,
    verifyDecisionGrants: (tokens: string[], action: DecisionAction, caseVersion: string, options: Parameters<typeof actual.verifyDecisionGrants>[3]) =>
      actual.verifyDecisionGrants(tokens, action, caseVersion, { ...options, key: keys.publicKey as CryptoKey }),
  };
});

const { verifyGrantToken } = await import('../src/verify.js');
const { Grantex } = await import('../src/client.js');
const { DecisionGrantError } = await import('../src/decisions/verify.js');
const { ToolManifest } = await import('../src/manifest.js');
const { callCaseDecision } = await import('./docs/examples/decision-enforce.js');
const { requestDecline } = await import('./docs/examples/decision-request.js');

const read = (path: string) => readFileSync(path, 'utf8').split(String.fromCharCode(13)).join('');

describe('docs/concepts/decision-grants.md TypeScript examples', () => {
  let privateKey: CryptoKey;
  beforeAll(async () => {
    const pair = await generateKeyPair('RS256');
    privateKey = pair.privateKey;
    keys.publicKey = pair.publicKey;
  });

  it('embeds every example verbatim', () => {
    const doc = read(join(repoRoot, 'docs', 'concepts', 'decision-grants.md'));
    for (const file of ['decision-enforce.ts', 'decision-request.ts']) {
      const path = `packages/sdk-ts/tests/docs/examples/${file}`;
      const opening = `{/* snippet: ${path} */}\n\`\`\`ts\n`;
      const start = doc.indexOf(opening);
      expect(start, path).toBeGreaterThanOrEqual(0);
      const body = doc.slice(start + opening.length);
      const end = body.indexOf('\n```');
      expect(end, path).toBeGreaterThanOrEqual(0);
      expect(body.slice(0, end)).toBe(read(join(repoRoot, path)).replace(/\n+$/, ''));
    }
  });

  it('callCaseDecision allows a call with a valid grant once, then refuses the spent grant', async () => {
    vi.mocked(verifyGrantToken).mockResolvedValue({
      tokenId: 'tok_1', grantId: 'grnt_1', principalId: 'user_1', agentDid: 'did:grantex:ag_1',
      developerId: 'dev_01', scopes: ['tool:acme_kyb:write'], issuedAt: 1, expiresAt: 9_999_999_999,
    } as VerifiedGrant);
    const consumed = new Set<string>();
    const consumer: DecisionConsumer = {
      async consume(set) {
        const jtis = set.grants.map((g) => g.jti);
        if (jtis.some((j) => consumed.has(j))) throw new DecisionGrantError('consumed', 'used');
        jtis.forEach((j) => consumed.add(j));
        return { requestId: set.grants[0]!.decisionRequest, jtis, actionHash: set.actionHash, approvers: [] };
      },
    };
    const grantex = new Grantex({ apiKey: 'test-key', decisionConsumer: consumer });
    grantex.loadManifest(ToolManifest.fromJSON({ connector: 'acme_kyb', tools: { case_decision: { permission: 'write', requires_decision: true, four_eyes_on: ['decline'] } } }));
    const action = { case_id: 'case_8841', action: 'case_decision', decision: 'approve', subject: 'gb:00000001' };
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      dev: 'dev_01', idp: 'https://idp.example.com', approver_auth: 'sso+hwk', amr: ['hwk'], auth_time: now - 60,
      action, action_hash: computeActionHash(action), connector: 'acme_kyb', case_version: 'v7', dwell_ms: 42_000,
      dwell_source: 'server', memo_hash: `sha256:${'M'.repeat(43)}`, policy_score_hash: `sha256:${'P'.repeat(43)}`,
      decision_request: 'dreq_01K8Z000000000000000000QR1',
    } as JWTPayload)
      .setProtectedHeader({ alg: 'RS256', kid: 'k1', typ: 'decision+jwt' })
      .setIssuer('https://grantex.dev').setAudience('urn:grantex:decision').setSubject('user:ns:approver-a')
      .setJti('dgnt_01K8Z000000000000000000QA1').setIssuedAt(now).setExpirationTime(now + 3600)
      .sign(privateKey);
    const args = { case_id: 'case_8841', decision: 'approve', subject: 'gb:00000001', planned_at: '2026-09-15T10:00:00Z' };
    await expect(callCaseDecision(grantex, 'grant-token', [token], args, 'v7')).resolves.toBeUndefined();
    await expect(callCaseDecision(grantex, 'grant-token', [token], args, 'v7')).rejects.toThrow(/decision_invalid\/consumed/);
    await expect(callCaseDecision(grantex, 'grant-token', [], args, 'v7')).rejects.toThrow(/decision_required/);
  });

  it('requestDecline sends the action, four eyes, memo and policy score and returns the approval page', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ requestId: 'dreq_1', approvalPage: 'https://grantex.dev/decisions/dreq_1' }), { status: 201, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const page = await requestDecline(new Grantex({ apiKey: 'test-key' }), 'case_8841', 'v7', 'Owners do not reconcile.', { tier: 'medium' });
      expect(page).toBe('https://grantex.dev/decisions/dreq_1');
      const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as Record<string, unknown>;
      expect(body).toMatchObject({ connector: 'acme_kyb', caseVersion: 'v7', fourEyesOn: ['decline'], memo: { content: 'Owners do not reconcile.' }, policyScore: { content: { tier: 'medium' } } });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
