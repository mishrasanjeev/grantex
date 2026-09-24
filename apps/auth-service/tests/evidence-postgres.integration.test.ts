/**
 * Evidence records and export against real Postgres (PRD G-5): migrations,
 * idempotent records, write-time reference validation, voids, decisions from
 * the decision-grant store only, late records, tenant isolation, tamper and
 * link detection, plan limits, and the export duration benchmark (p95 under
 * five seconds for a decided case).
 */
import { createHash, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { computeAuditHash } from '../src/lib/hash.js';
import { decisionActionHash } from '../src/lib/evidence/hashing.js';
import { verifyPackage } from '../src/lib/evidence/verify.js';
import { appendEvidenceRecords, exportCasePackage, resetCounterTriggerCache, voidEvidenceRecord } from '../src/lib/evidence-service/service.js';
import { evidenceSettings } from '../src/lib/evidence-service/settings.js';
import { createTestDatabase } from './helpers/database.js';

// A database of its own; see FINDINGS G-24.
const adminDatabaseUrl = process.env['AUDIT_INTEGRATION_DATABASE_URL'];
let databaseUrl = adminDatabaseUrl;
let dropTestDatabase: (() => Promise<void>) | undefined;
const ci = process.env['CI']?.trim().toLowerCase();
if ((ci === 'true' || ci === '1') && !databaseUrl) {
  throw new Error('AUDIT_INTEGRATION_DATABASE_URL must be set in CI; refusing to skip the real-Postgres evidence integration tests');
}
const describePostgres = adminDatabaseUrl ? describe : describe.skip;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const digest = (label: string): string => `sha256:${createHash('sha256').update(label).digest('hex')}`;
const ISSUER = 'https://auth.example.com';
const settings = evidenceSettings({
  EVIDENCE_EXPORT_ENABLED: 'true',
  EVIDENCE_PSEUDONYMISATION_SECRET: 'placeholder-evidence-secret-for-tests-only-0000',
});
const BASE = Date.now() - 60 * 60 * 1000; // an hour ago, so every record is in the past
const at = (ms: number): string => new Date(BASE + ms).toISOString();
const TOOLS = ['resolve_business', 'verify_business', 'ownership', 'screen_person', 'web_presence'];

function toolCall(grantId: string, n: number, extra: Json = {}): Json {
  const tool = TOOLS[n % TOOLS.length]!;
  return {
    type: 'tool_call', at: at(10 + n * 10), agent_id: 'ag_underwriter',
    data: {
      call_id: `call_${n}`, connector: 'acme_kyb', cost_units: 1 + (n % 5), grant_id: grantId, input_hash: digest(`in:${n}`),
      outcome: 'allowed', output_hash: digest(`out:${n}`), provider: 'mock', purpose: 'aml.cdd.onboarding', run_id: 'run_1',
      started_at: at(10 + n * 10), completed_at: at(15 + n * 10), tool,
      upstream_records: [0, 1, 2].map((k) => ({ record_id: `mock:${tool}:${n}-${k}`, record_type: 'record', retrieved_at: at(12 + n * 10) })),
      ...extra,
    },
  };
}

const ref = (n: number, k = 0): Json => ({ call_id: `call_${n}`, field: 'status', provider: 'mock', record_id: `mock:${TOOLS[n % TOOLS.length]}:${n}-${k}`, retrieved_at: at(12 + n * 10) });

function runContext(): Json {
  return {
    type: 'run_context', at: at(0), agent_id: 'ag_underwriter',
    data: {
      agent_id: 'ag_underwriter', run_id: 'run_1', model: { name: 'stub-model', provider: 'model-stub', version: '2026-09-01' },
      prompts: [{ digest: digest('prompt'), id: 'business_underwriter', version: '1.0.0' }],
      policies: [{ digest: digest('policy'), id: 'business_onboarding_uk', version: '1.2.0' }],
      schemas: [{ id: 'underwriting_memo', version: '1.0.0' }],
    },
  };
}

function analysis(calls: number): Json[] {
  const t = 10 + calls * 10;
  const out: Json[] = [];
  for (let e = 0; e < 3; e++) {
    out.push({
      type: 'policy_evaluation', at: at(t + e), agent_id: 'ag_underwriter',
      data: {
        evaluation_id: `eval_${e}`, run_id: 'run_1', policy: { digest: digest('policy'), id: 'business_onboarding_uk', version: '1.2.0' },
        score: 40 + e, tier: 'medium', fired_rules: [{ reason_code: 'ownership_not_reconciled', rule_id: 'ownership_reconciled', tier: 'medium' }],
        inputs: [
          ...Array.from({ length: 20 }, (_, i) => ({ evidence: [ref((i * 7) % calls)], path: `field.${i}`, value: i })),
          { evidence: [], path: 'application.declared_owner_count', unsourced: true, value: 2 },
        ],
      },
    });
  }
  out.push({
    type: 'disposition', at: at(t + 5), agent_id: 'ag_underwriter',
    data: {
      comparisons: [{ evidence: [ref(3)], identifier: 'name', result: 'partial' }, { evidence: [], identifier: 'nationality', result: 'not_available' }],
      confidence_band: 'high', disposition_id: 'disp_1', hit: ref(3), outcome: 'false_positive', rationale_digest: digest('rationale'), run_id: 'run_1',
    },
  });
  out.push({
    type: 'recommendation', at: at(t + 10), agent_id: 'ag_underwriter',
    data: {
      evaluation_ids: ['eval_1', 'eval_2'], memo_digest: digest('memo'), outcome: 'refer', recommendation_id: 'rec_1', run_id: 'run_1',
      sections: ['registry', 'verification', 'ownership', 'screening', 'web_presence', 'activity', 'officers', 'address'].map((section, i) => ({
        evidence: [ref((i * 11) % calls), ref((i * 13) % calls, 1)], section, status: 'complete',
      })),
    },
  });
  return out;
}

async function expectError(promise: Promise<unknown>, code: string, fieldPath?: string): Promise<void> {
  try {
    await promise;
  } catch (err) {
    expect((err as { code?: string }).code).toBe(code);
    if (fieldPath !== undefined) expect((err as { fieldPath?: string }).fieldPath).toBe(fieldPath);
    return;
  }
  throw new Error(`expected ${code}`);
}

async function createDecisionStore(sql: postgres.Sql, schema: string): Promise<void> {
  // The shape the decision-grant work uses; created in a private schema so it never collides with its migration.
  await sql.unsafe(`CREATE SCHEMA ${schema}`);
  await sql.unsafe(`CREATE TABLE ${schema}.decision_requests (id TEXT PRIMARY KEY, developer_id TEXT NOT NULL, approvals_required SMALLINT NOT NULL)`);
  await sql.unsafe(`CREATE TABLE ${schema}.decision_grants (
    jti TEXT PRIMARY KEY, developer_id TEXT NOT NULL, request_id TEXT NOT NULL, approver_sub TEXT NOT NULL, approver_auth TEXT NOT NULL,
    dwell_ms INTEGER NOT NULL, case_id TEXT NOT NULL, action_hash TEXT NOT NULL, approval_position SMALLINT NOT NULL, first_jti TEXT,
    claims JSONB NOT NULL, issued_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL, consumed_at TIMESTAMPTZ)`);
}

beforeAll(async () => {
  if (!adminDatabaseUrl) return;
  const db = await createTestDatabase('evidence');
  databaseUrl = db.url;
  dropTestDatabase = db.drop;
}, 60_000);

afterAll(async () => {
  await dropTestDatabase?.();
}, 60_000);

describePostgres('evidence records and export against real Postgres', () => {
  it('records idempotently, validates references at write time, anchors, isolates tenants, detects tampering and meets the p95 budget', async () => {
    const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
    const schema = `evidence_it_${suffix}`;
    const admin = postgres(databaseUrl!, { max: 2, idle_timeout: 5, connect_timeout: 10, onnotice: () => {} });
    const sql = postgres(databaseUrl!, { max: 4, idle_timeout: 5, connect_timeout: 10, onnotice: () => {}, connection: { search_path: `${schema},public` } });
    const developerId = `dev_evidence_${suffix}`;
    const otherDeveloperId = `dev_evidence_other_${suffix}`;
    const freeDeveloperId = `dev_evidence_free_${suffix}`;
    const caseId = `case_${suffix}`;
    const grantIds = [`grnt_root_${suffix}`, `grnt_mid_${suffix}`, `grnt_leaf_${suffix}`];
    const otherChainGrant = `grnt_other_${suffix}`;
    const agentId = `ag_evidence_${suffix}`;
    try {
      await runMigrations(admin);
      // A repeat start applies nothing now that the ledger exists; it used to
      // re-apply every file, which is what the second call here was for.
      expect((await runMigrations(admin)).applied).toEqual([]);
      resetCounterTriggerCache();
      const [trigger] = await admin`SELECT COUNT(*)::int AS n FROM pg_trigger WHERE tgname = 'audit_entry_counter_trg'`;
      expect(trigger!['n']).toBe(1);

      await admin`INSERT INTO developers (id, api_key_hash, name) VALUES
        (${developerId}, ${'hash_' + suffix}, 'Evidence Test'), (${otherDeveloperId}, ${'hash_o_' + suffix}, 'Other Test'), (${freeDeveloperId}, ${'hash_f_' + suffix}, 'Free Test')`;
      await admin`INSERT INTO subscriptions (id, developer_id, plan, status) VALUES (${'sub_' + suffix}, ${developerId}, 'pro', 'active')`;
      await admin`INSERT INTO agents (id, did, developer_id, name) VALUES (${agentId}, ${'did:grantex:' + agentId}, ${developerId}, 'Underwriter')`;
      const details = [{ type: 'urn:grantex:tools:v1', connector: 'acme_kyb', purpose: 'aml.cdd.onboarding', tools: ['verify_business'], caps: { verify_business: { per_case: 3 } } }];
      for (const [depth, id] of [...grantIds, otherChainGrant].entries()) {
        const parent = id === otherChainGrant ? null : depth === 0 ? null : grantIds[depth - 1]!;
        await admin`INSERT INTO grants (id, agent_id, principal_id, developer_id, scopes, expires_at, purpose, authorization_details, parent_grant_id, delegation_depth, issued_at)
          VALUES (${id}, ${agentId}, 'user:underwriting-team', ${developerId}, ${['tool:acme_kyb:read']}, NOW() + INTERVAL '1 day',
                  'aml.cdd.onboarding', ${admin.json(details as never)}, ${parent}, ${id === otherChainGrant ? 0 : depth}, ${new Date(BASE - 10_000 + depth * 1000)})`;
      }
      const leaf = grantIds[2]!;

      // Unrelated cases of the same developer.
      for (let c = 0; c < 10; c++) {
        await appendEvidenceRecords(sql, developerId, `case_noise_${suffix}_${c}`, [runContext(), ...Array.from({ length: 99 }, (_, n) => toolCall(leaf, n))]);
      }

      // The case: run context, 250 calls, 3 evaluations, a disposition and a cited recommendation.
      const calls = Array.from({ length: 250 }, (_, n) => toolCall(leaf, n));
      const first = await appendEvidenceRecords(sql, developerId, caseId, [runContext(), ...calls.slice(0, 99)]);
      expect(first.every((r) => !r.duplicate)).toBe(true);
      for (let i = 99; i < 250; i += 100) await appendEvidenceRecords(sql, developerId, caseId, calls.slice(i, i + 100));

      // Idempotent retry, conflicting retry.
      const retry = await appendEvidenceRecords(sql, developerId, caseId, [runContext(), ...calls.slice(0, 99)]);
      expect(retry.every((r) => r.duplicate)).toBe(true);
      expect(retry.map((r) => r.audit_entry_id)).toEqual(first.map((r) => r.audit_entry_id));
      await expectError(appendEvidenceRecords(sql, developerId, caseId, [toolCall(leaf, 5, { cost_units: 99 })]), 'EVIDENCE_RECORD_CONFLICT', 'records[0]');

      // References are checked when written; nothing from a refused request is kept.
      const bad = analysis(250);
      bad[0]!['data']['inputs'][0]['evidence'][0]['call_id'] = 'call_unknown';
      await expectError(appendEvidenceRecords(sql, developerId, caseId, bad), 'EVIDENCE_REFERENCE_INVALID', 'records[0].data.inputs[0].evidence[0].call_id');
      await expectError(appendEvidenceRecords(sql, developerId, caseId, [toolCall(otherChainGrant, 900)]), 'EVIDENCE_GRANT_CHAIN_AMBIGUOUS', 'records[0].data.grant_id');
      await expectError(appendEvidenceRecords(sql, developerId, caseId, [toolCall(leaf, 901, {}), { ...toolCall(leaf, 902), at: new Date(Date.now() + 3_600_000).toISOString() }]), 'EVIDENCE_RECORD_INVALID', 'records[1].at');
      const counted = await admin<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM evidence_records WHERE developer_id = ${developerId} AND case_id = ${caseId}`;
      expect(counted[0]?.n).toBe(251);

      // Ordinary clock skew: an evaluation dated before the call it cites is accepted (order is the server's).
      const skewed = analysis(250);
      skewed[0]!['at'] = at(0);
      await appendEvidenceRecords(sql, developerId, caseId, skewed);

      // Void: a void call cannot be cited, voiding twice for the same reason is a no-op.
      await appendEvidenceRecords(sql, developerId, caseId, [toolCall(leaf, 260, { outcome: 'error', output_hash: null, upstream_records: [], completed_at: undefined })].map((r) => {
        delete r['data']['completed_at'];
        return r;
      }));
      const voided = await voidEvidenceRecord(sql, developerId, caseId, { reason_code: 'recorded_in_error', target_id: 'call_260', target_type: 'tool_call' });
      expect((await voidEvidenceRecord(sql, developerId, caseId, { reason_code: 'recorded_in_error', target_id: 'call_260', target_type: 'tool_call' })).audit_entry_id).toBe(voided.audit_entry_id);
      await expectError(voidEvidenceRecord(sql, developerId, caseId, { reason_code: 'other', target_id: 'call_260', target_type: 'tool_call' }), 'EVIDENCE_RECORD_CONFLICT');

      // Before any case decision rows exist, the store is available but the case stays open.
      const undecided = await exportCasePackage(sql, { developerId, caseId, issuer: ISSUER, settings, options: {} });
      expect(undecided.decisionsAvailable).toBe(true);
      expect(JSON.parse(Buffer.from(undecided.data).toString('utf8'))['case']['state']).toBe('open');

      // Four-eyes decisions and their consumption, from the store only.
      await createDecisionStore(admin, schema);
      const action = { action: 'case_decision', case_id: caseId, decision: 'decline', subject: 'gb:00000001' };
      const actionHash = decisionActionHash(action);
      const decidedAt = new Date(Date.now() - 60_000);
      await admin.unsafe(`INSERT INTO ${schema}.decision_requests (id, developer_id, approvals_required) VALUES ($1, $2, 2)`, [`dreq_${suffix}`, developerId]);
      for (const [position, approver] of [[1, 'user:approver-a'], [2, 'user:approver-b']] as const) {
        await admin.unsafe(
          `INSERT INTO ${schema}.decision_grants (jti, developer_id, request_id, approver_sub, approver_auth, dwell_ms, case_id, action_hash, approval_position, first_jti, claims, issued_at, expires_at, consumed_at)
           VALUES ($1, $2, $3, $4, 'sso+webauthn', 61250, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [`dgnt_${position}_${suffix}`, developerId, `dreq_${suffix}`, approver, caseId, actionHash, position, position === 2 ? `dgnt_1_${suffix}` : null,
            JSON.stringify({ iss: ISSUER, action }), new Date(decidedAt.getTime() - 20_000 + position * 1000), new Date(Date.now() + 86_400_000), decidedAt],
        );
      }
      // A tenant cannot forge a decision by writing an audit entry: only the store is read.
      // A record written after consumption is marked late.
      await appendEvidenceRecords(sql, developerId, caseId, [toolCall(leaf, 270)]);

      await expectError(exportCasePackage(sql, { developerId: otherDeveloperId, caseId, issuer: ISSUER, settings, options: {} }), 'EVIDENCE_CASE_NOT_FOUND');

      const durations: number[] = [];
      let last: Awaited<ReturnType<typeof exportCasePackage>> | undefined;
      for (let run = 0; run < 20; run++) {
        const started = performance.now();
        last = await exportCasePackage(sql, { developerId, caseId, issuer: ISSUER, settings, options: {} });
        durations.push(performance.now() - started);
      }
      durations.sort((a, b) => a - b);
      const p95 = durations[Math.ceil(durations.length * 0.95) - 1]!;
      console.info(`evidence export: ${last!.entryCount} entries, ${last!.data.length} bytes, p50 ${durations[9]!.toFixed(0)} ms, p95 ${p95.toFixed(0)} ms`);
      expect(p95).toBeLessThan(5000);
      expect(last!.decisionsAvailable).toBe(true);

      const result = verifyPackage(last!.data, { expectedRoot: last!.root, expectedAnchorHash: last!.anchorHash, requireAnchor: true });
      expect(result.ok, `${result.code} ${result.fieldPath} ${result.message}`).toBe(true);
      expect(result.unsourcedInputs).toBe(3);
      expect(result.lateEntries).toBeGreaterThanOrEqual(1);
      const pkg = JSON.parse(Buffer.from(last!.data).toString('utf8')) as Json;
      expect(pkg['case']['state']).toBe('decided');
      expect(pkg['entries'].slice(0, 3).map((e: Json) => e['data']['grant_id'])).toEqual(grantIds);
      const types = pkg['entries'].map((e: Json) => e['type']);
      expect(types.filter((t: string) => t === 'decision')).toHaveLength(2);
      expect(types.filter((t: string) => t === 'decision_consumption')).toHaveLength(1);
      expect(types).toContain('void');
      expect(Buffer.from(last!.data).toString('utf8').includes('user:approver-a')).toBe(false);

      // The anchor is a platform entry in the audit chain.
      const [anchorRow] = await admin`SELECT principal_id, agent_id, metadata FROM audit_entries WHERE developer_id = ${developerId} AND hash = ${last!.anchorHash}`;
      expect(anchorRow!['principal_id']).toBe('platform');
      expect(anchorRow!['metadata']).toMatchObject({ case_id: caseId, package_root: last!.root, 'grantex:platform': true });

      // Editing a stored record, or re-linking it with a recomputed hash, fails the export closed.
      const [victim] = await admin`SELECT a.* FROM evidence_records r JOIN audit_entries a ON a.id = r.audit_entry_id
        WHERE r.developer_id = ${developerId} AND r.case_id = ${caseId} AND r.record_type = 'tool_call' ORDER BY r.seq LIMIT 1 OFFSET 7`;
      const relinked = { ...victim! };
      const forgedPrev = 'e'.repeat(64);
      const forgedHash = computeAuditHash({
        id: relinked['id'], agentId: relinked['agent_id'], agentDid: relinked['agent_did'], grantId: relinked['grant_id'], principalId: relinked['principal_id'],
        developerId, action: relinked['action'], metadata: relinked['metadata'], timestamp: new Date(relinked['timestamp']).toISOString(), prevHash: forgedPrev, status: relinked['status'],
      });
      await admin`UPDATE audit_entries SET previous_hash = ${forgedPrev}, hash = ${forgedHash} WHERE id = ${relinked['id']}`;
      await expectError(exportCasePackage(sql, { developerId, caseId, issuer: ISSUER, settings, options: {} }), 'EVIDENCE_CHAIN_VERIFICATION_FAILED');
      await admin`UPDATE audit_entries SET previous_hash = ${victim!['previous_hash']}, hash = ${victim!['hash']} WHERE id = ${victim!['id']}`;
      await admin`UPDATE audit_entries SET metadata = jsonb_set(metadata, '{evidence,data,cost_units}', '0') WHERE id = ${victim!['id']}`;
      await expectError(exportCasePackage(sql, { developerId, caseId, issuer: ISSUER, settings, options: {} }), 'EVIDENCE_CHAIN_VERIFICATION_FAILED');

      // Plan limits use the counter kept by the trigger.
      await appendEvidenceRecords(sql, freeDeveloperId, `case_free_${suffix}`, [runContext()]);
      const [counter] = await admin`SELECT entry_count FROM audit_entry_counters WHERE developer_id = ${freeDeveloperId}`;
      expect(Number(counter!['entry_count'])).toBe(1);
      await admin`UPDATE audit_entry_counters SET entry_count = 20000 WHERE developer_id = ${freeDeveloperId}`;
      await expectError(appendEvidenceRecords(sql, freeDeveloperId, `case_free_${suffix}`, [{ ...runContext(), data: { ...runContext()['data'], run_id: 'run_2' } }]), 'PLAN_LIMIT_EXCEEDED');
    } finally {
      await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
      for (const dev of [developerId, otherDeveloperId, freeDeveloperId]) {
        await admin`DELETE FROM evidence_records WHERE developer_id = ${dev}`.catch(() => undefined);
        await admin`DELETE FROM evidence_cases WHERE developer_id = ${dev}`.catch(() => undefined);
        await admin`DELETE FROM audit_entry_counters WHERE developer_id = ${dev}`.catch(() => undefined);
        await admin`DELETE FROM audit_entries WHERE developer_id = ${dev}`.catch(() => undefined);
        await admin`DELETE FROM grants WHERE developer_id = ${dev}`.catch(() => undefined);
      }
      await admin`DELETE FROM agents WHERE id = ${agentId}`.catch(() => undefined);
      await admin`DELETE FROM subscriptions WHERE developer_id = ${developerId}`.catch(() => undefined);
      await admin`DELETE FROM developers WHERE id IN (${developerId}, ${otherDeveloperId}, ${freeDeveloperId})`.catch(() => undefined);
      await sql.end();
      await admin.end();
    }
  }, 300_000);
});
