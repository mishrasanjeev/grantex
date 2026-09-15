/**
 * Evidence records and export against real Postgres (PRD G-5): migrations,
 * tenant isolation, anchoring in the audit chain, tamper detection, and the
 * export duration benchmark (p95 under five seconds for a decided case).
 */
import { createHash, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { computeAuditHash } from '../src/lib/hash.js';
import { verifyPackage } from '../src/lib/evidence/verify.js';
import { appendEvidenceRecords, exportCasePackage } from '../src/lib/evidence-service/service.js';
import { evidenceSettings } from '../src/lib/evidence-service/settings.js';

const databaseUrl = process.env['AUDIT_INTEGRATION_DATABASE_URL'];
const ci = process.env['CI']?.trim().toLowerCase();
if ((ci === 'true' || ci === '1') && !databaseUrl) {
  throw new Error('AUDIT_INTEGRATION_DATABASE_URL must be set in CI; refusing to skip the real-Postgres evidence integration tests');
}
const describePostgres = databaseUrl ? describe : describe.skip;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const digest = (label: string): string => `sha256:${createHash('sha256').update(label).digest('hex')}`;
const ISSUER = 'https://auth.example.com';
const settings = evidenceSettings({
  EVIDENCE_EXPORT_ENABLED: 'true',
  EVIDENCE_PSEUDONYMISATION_SECRET: 'placeholder-evidence-secret-for-tests-only-0000',
});

/** A realistic decided onboarding case: 250 provider calls, 3 evaluations, a cited memo, four-eyes decision. */
function caseRecords(grantId: string, caseId: string, calls: number): Json[] {
  const base = Date.parse('2026-09-14T09:05:00.000Z');
  const at = (ms: number): string => new Date(base + ms).toISOString();
  const records: Json[] = [{
    type: 'run_context', at: at(0), agent_id: 'ag_underwriter',
    data: {
      agent_id: 'ag_underwriter', run_id: 'run_1', model: { name: 'stub-model', provider: 'model-stub', version: '2026-09-01' },
      prompts: [{ digest: digest('prompt'), id: 'business_underwriter', version: '1.0.0' }],
      policies: [{ digest: digest('policy'), id: 'business_onboarding_uk', version: '1.2.0' }],
      schemas: [{ id: 'underwriting_memo', version: '1.0.0' }],
    },
  }];
  const tools = ['resolve_business', 'verify_business', 'ownership', 'screen_person', 'web_presence'];
  for (let n = 0; n < calls; n++) {
    records.push({
      type: 'tool_call', at: at(10 + n * 10), agent_id: 'ag_underwriter',
      data: {
        call_id: `call_${n}`, connector: 'acme_kyb', cost_units: 1 + (n % 5), grant_id: grantId, input_hash: digest(`${caseId}:in:${n}`),
        outcome: 'allowed', output_hash: digest(`${caseId}:out:${n}`), provider: 'mock', purpose: 'aml.cdd.onboarding', run_id: 'run_1',
        started_at: at(10 + n * 10), completed_at: at(15 + n * 10), tool: tools[n % tools.length],
        upstream_records: [0, 1, 2].map((k) => ({ record_id: `mock:${tools[n % tools.length]}:${n}-${k}`, record_type: 'record', retrieved_at: at(12 + n * 10) })),
      },
    });
  }
  const ref = (n: number, k = 0): Json => ({ call_id: `call_${n}`, field: 'status', provider: 'mock', record_id: `mock:${tools[n % tools.length]}:${n}-${k}`, retrieved_at: at(12 + n * 10) });
  const t = 10 + calls * 10;
  for (let e = 0; e < 3; e++) {
    records.push({
      type: 'policy_evaluation', at: at(t + e), agent_id: 'ag_underwriter',
      data: {
        evaluation_id: `eval_${e}`, run_id: 'run_1', policy: { digest: digest('policy'), id: 'business_onboarding_uk', version: '1.2.0' },
        score: 40 + e, tier: 'medium', fired_rules: [{ reason: 'Declared owners do not reconcile with the ownership graph', rule_id: 'ownership_reconciled', tier: 'medium' }],
        inputs: Array.from({ length: 20 }, (_, i) => ({ evidence: [ref(i * 7 % calls)], path: `field.${i}`, value: i })),
      },
    });
  }
  records.push({
    type: 'recommendation', at: at(t + 10), agent_id: 'ag_underwriter',
    data: {
      evaluation_id: 'eval_2', memo_digest: digest('memo'), outcome: 'refer', recommendation_id: 'rec_1',
      sections: ['registry', 'verification', 'ownership', 'screening', 'web_presence', 'activity', 'officers', 'address'].map((section, i) => ({
        evidence: [ref(i * 11 % calls), ref(i * 13 % calls, 1)], section, status: 'complete',
      })),
    },
  });
  return records;
}

async function seedDecisions(sql: postgres.Sql, developerId: string, caseId: string): Promise<void> {
  const action = { action: 'case_decision', case_id: caseId, decision: 'decline', subject: 'gb:00000001' };
  const actionHash = `sha256:${createHash('sha256').update(JSON.stringify({ action: 'case_decision', case_id: caseId, decision: 'decline', subject: 'gb:00000001' })).digest('base64url')}`;
  const entries: Array<{ action: string; principal: string; metadata: Json }> = [
    { action: 'decision.approved', principal: 'user:approver-a', metadata: { request_id: 'dreq_1', jti: 'dgnt_1', approver: { sub: 'user:approver-a' }, approver_auth: 'sso+webauthn', dwell_ms: 61250, action, action_hash: actionHash, approval_position: 1, approvals_required: 2, expires_at: '2099-01-01T00:00:00.000Z' } },
    { action: 'decision.approved', principal: 'user:approver-b', metadata: { request_id: 'dreq_1', jti: 'dgnt_2', approver: { sub: 'user:approver-b' }, approver_auth: 'sso+webauthn', dwell_ms: 48020, action, action_hash: actionHash, approval_position: 2, approvals_required: 2, first_jti: 'dgnt_1', expires_at: '2099-01-01T00:00:00.000Z' } },
    { action: 'decision.consumed', principal: 'user:approver-b', metadata: { request_id: 'dreq_1', jtis: ['dgnt_1', 'dgnt_2'], action, action_hash: actionHash } },
  ];
  for (const entry of entries) {
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${developerId}, 0))`;
      const [last] = await tx`SELECT hash, timestamp FROM audit_entries WHERE developer_id = ${developerId} ORDER BY timestamp DESC, id DESC LIMIT 1`;
      const id = `alog_dec_${randomUUID().replace(/-/g, '')}`;
      const timestamp = new Date(Math.max(Date.now(), last ? new Date(last['timestamp'] as Date).getTime() + 1 : 0)).toISOString();
      const prevHash = (last?.['hash'] as string | undefined) ?? null;
      const hash = computeAuditHash({ id, agentId: '', agentDid: '', grantId: '', principalId: entry.principal, developerId, action: entry.action, metadata: entry.metadata, timestamp, prevHash, status: 'success' });
      await tx`INSERT INTO audit_entries (id, agent_id, agent_did, grant_id, principal_id, developer_id, action, metadata, hash, previous_hash, timestamp, status)
        VALUES (${id}, '', '', '', ${entry.principal}, ${developerId}, ${entry.action}, ${tx.json(entry.metadata as never)}, ${hash}, ${prevHash}, ${timestamp}, 'success')`;
    });
  }
}

describePostgres('evidence export against real Postgres', () => {
  it('records, exports, anchors, isolates tenants, detects tampering and meets the p95 budget', async () => {
    const sql = postgres(databaseUrl!, { max: 4, idle_timeout: 5, connect_timeout: 10, onnotice: () => {} });
    const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
    const developerId = `dev_evidence_${suffix}`;
    const otherDeveloperId = `dev_evidence_other_${suffix}`;
    const caseId = `case_${suffix}`;
    const grantIds = [`grnt_root_${suffix}`, `grnt_mid_${suffix}`, `grnt_leaf_${suffix}`];
    const agentId = `ag_evidence_${suffix}`;
    try {
      await runMigrations(sql);
      const indexes = await sql`SELECT indexname FROM pg_indexes WHERE tablename = 'audit_entries' AND indexname IN ('idx_audit_evidence_case', 'idx_audit_decision_case') ORDER BY indexname`;
      expect(indexes.map((r) => r['indexname'])).toEqual(['idx_audit_decision_case', 'idx_audit_evidence_case']);

      await sql`INSERT INTO developers (id, api_key_hash, name) VALUES (${developerId}, ${'hash_' + suffix}, 'Evidence Test'), (${otherDeveloperId}, ${'hash_o_' + suffix}, 'Other Test')`;
      await sql`INSERT INTO subscriptions (id, developer_id, plan, status) VALUES (${'sub_' + suffix}, ${developerId}, 'enterprise', 'active')`.catch(async () => {
        await sql`INSERT INTO subscriptions (developer_id, plan) VALUES (${developerId}, 'enterprise')`;
      });
      await sql`INSERT INTO agents (id, did, developer_id, name) VALUES (${agentId}, ${'did:grantex:' + agentId}, ${developerId}, 'Underwriter')`;
      for (let depth = 0; depth < grantIds.length; depth++) {
        const details = [{ type: 'urn:grantex:tools:v1', connector: 'acme_kyb', purpose: 'aml.cdd.onboarding', tools: ['verify_business'], caps: { verify_business: { per_case: 3 } } }];
        await sql`INSERT INTO grants (id, agent_id, principal_id, developer_id, scopes, expires_at, purpose, authorization_details, parent_grant_id, delegation_depth, issued_at)
          VALUES (${grantIds[depth]!}, ${agentId}, 'user:underwriting-team', ${developerId}, ${['tool:acme_kyb:read']}, NOW() + INTERVAL '1 day',
                  'aml.cdd.onboarding', ${sql.json(details as never)}, ${depth === 0 ? null : grantIds[depth - 1]!}, ${depth}, ${new Date(Date.parse('2026-09-14T09:00:00.000Z') + depth * 1000)})`;
      }

      // Unrelated evidence for other cases of the same developer, to exercise the index.
      const noise: Json[] = [];
      for (let c = 0; c < 20; c++) noise.push(...caseRecords(grantIds[2]!, `case_noise_${c}`, 99).slice(0, 100));
      for (let c = 0; c < noise.length; c += 100) await appendEvidenceRecords(sql, developerId, `case_noise_${c / 100}`, noise.slice(c, c + 100));

      const records = caseRecords(grantIds[2]!, caseId, 250);
      for (let i = 0; i < records.length; i += 100) {
        const appended = await appendEvidenceRecords(sql, developerId, caseId, records.slice(i, i + 100));
        expect(appended).toHaveLength(Math.min(100, records.length - i));
      }
      await seedDecisions(sql, developerId, caseId);

      // Records are real audit chain entries that verify with the audit hash.
      const [firstRecord] = await sql`SELECT * FROM audit_entries WHERE developer_id = ${developerId} AND metadata->>'case_id' = ${caseId} ORDER BY timestamp, id LIMIT 1`;
      expect(firstRecord!['action']).toBe('evidence.run_context');

      // Another tenant sees nothing.
      await expect(exportCasePackage(sql, { developerId: otherDeveloperId, caseId, issuer: ISSUER, settings, options: {} }))
        .rejects.toMatchObject({ code: 'EVIDENCE_CASE_NOT_FOUND', status: 404 });

      const durations: number[] = [];
      let last: { data: Uint8Array; root: string; anchorHash: string; entryCount: number } | undefined;
      for (let run = 0; run < 20; run++) {
        const started = performance.now();
        last = await exportCasePackage(sql, { developerId, caseId, issuer: ISSUER, settings, options: {} });
        durations.push(performance.now() - started);
      }
      durations.sort((a, b) => a - b);
      const p95 = durations[Math.ceil(durations.length * 0.95) - 1]!;
      console.info(`evidence export: ${last!.entryCount} entries, ${last!.data.length} bytes, p50 ${durations[9]!.toFixed(0)} ms, p95 ${p95.toFixed(0)} ms`);
      expect(p95).toBeLessThan(5000);
      expect(last!.entryCount).toBe(3 + 1 + 250 + 3 + 1 + 3);

      const verified = verifyPackage(last!.data, { expectedRoot: last!.root, expectedAnchorHash: last!.anchorHash, requireAnchor: true });
      expect(verified.ok, verified.message).toBe(true);
      const pkg = JSON.parse(Buffer.from(last!.data).toString('utf8')) as Json;
      expect(pkg['case']['state']).toBe('decided');
      expect(pkg['entries'].slice(0, 3).map((e: Json) => e['data']['grant_id'])).toEqual(grantIds);

      // The root is published in the audit chain: the anchor entry is stored with that hash.
      const [anchorRow] = await sql`SELECT hash, metadata FROM audit_entries WHERE developer_id = ${developerId} AND hash = ${last!.anchorHash}`;
      expect(anchorRow!['metadata']).toMatchObject({ case_id: caseId, package_root: last!.root });

      // Editing a stored evidence record makes export fail closed.
      await sql`UPDATE audit_entries SET metadata = jsonb_set(metadata, '{evidence,data,cost_units}', '0')
        WHERE id = (SELECT id FROM audit_entries WHERE developer_id = ${developerId} AND action = 'evidence.tool_call' AND metadata->>'case_id' = ${caseId} ORDER BY timestamp LIMIT 1)`;
      await expect(exportCasePackage(sql, { developerId, caseId, issuer: ISSUER, settings, options: {} }))
        .rejects.toMatchObject({ code: 'EVIDENCE_CHAIN_VERIFICATION_FAILED', status: 409 });
    } finally {
      await sql`DELETE FROM audit_entries WHERE developer_id IN (${developerId}, ${otherDeveloperId})`.catch(() => undefined);
      await sql`DELETE FROM grants WHERE developer_id = ${developerId}`.catch(() => undefined);
      await sql`DELETE FROM agents WHERE id = ${agentId}`.catch(() => undefined);
      await sql`DELETE FROM subscriptions WHERE developer_id = ${developerId}`.catch(() => undefined);
      await sql`DELETE FROM developers WHERE id IN (${developerId}, ${otherDeveloperId})`.catch(() => undefined);
      await sql.end();
    }
  }, 300_000);
});
