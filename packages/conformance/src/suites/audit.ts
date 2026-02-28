import type { SuiteDefinition, SuiteContext, TestResult } from '../types.js';
import { test, expectStatus, expectKeys, expectString, expectArray, expectEqual } from '../helpers.js';

export const auditSuite: SuiteDefinition = {
  name: 'audit',
  description: 'Audit logging with hash chain integrity',
  optional: false,
  run: async (ctx: SuiteContext): Promise<TestResult[]> => {
    const results: TestResult[] = [];

    // Get a flow for audit entry data
    const flow = await ctx.flow.executeFullFlow({
      agentName: `conformance-audit-${Date.now()}`,
      scopes: ['read'],
    });

    let entry1Id = '';
    let entry1Hash = '';
    let entry2Id = '';
    let entry2Hash = '';
    let entry2PrevHash = '';

    results.push(
      await test(
        'POST /v1/audit/log creates entry with entryId, hash, prevHash (201)',
        '§8',
        async () => {
          const res = await ctx.http.post<{
            entryId: string;
            hash: string;
            prevHash: string | null;
          }>('/v1/audit/log', {
            agentId: flow.agentId,
            agentDid: flow.agentDid,
            grantId: flow.grantId,
            principalId: flow.principalId,
            action: 'conformance.test.1',
          });
          expectStatus(res, 201);
          expectKeys(res.body, ['entryId', 'hash', 'prevHash']);
          expectString(res.body.entryId, 'entryId');
          expectString(res.body.hash, 'hash');
          entry1Id = res.body.entryId;
          entry1Hash = res.body.hash;
        },
      ),
    );

    results.push(
      await test(
        'Hash chain integrity: entry2.prevHash === entry1.hash',
        '§8',
        async () => {
          const res = await ctx.http.post<{
            entryId: string;
            hash: string;
            prevHash: string | null;
          }>('/v1/audit/log', {
            agentId: flow.agentId,
            agentDid: flow.agentDid,
            grantId: flow.grantId,
            principalId: flow.principalId,
            action: 'conformance.test.2',
          });
          expectStatus(res, 201);
          entry2Id = res.body.entryId;
          entry2Hash = res.body.hash;
          entry2PrevHash = res.body.prevHash as string;

          // The prevHash of entry2 should equal the hash of entry1
          // Note: prevHash chains per-developer, so this only holds if no other
          // entries were created between entry1 and entry2
          if (entry1Hash && entry2PrevHash) {
            expectEqual(entry2PrevHash, entry1Hash, 'prevHash chain');
          }
        },
      ),
    );

    results.push(
      await test('GET /v1/audit/entries returns entries list', '§8', async () => {
        const res = await ctx.http.get<{ entries: unknown[] }>('/v1/audit/entries');
        expectStatus(res, 200);
        expectKeys(res.body, ['entries']);
        expectArray(res.body.entries, 'entries');
      }),
    );

    results.push(
      await test('GET /v1/audit/:id returns single entry', '§8', async () => {
        if (!entry1Id) throw new Error('No audit entry created');
        const res = await ctx.http.get<{
          entryId: string;
          hash: string;
          action: string;
        }>(`/v1/audit/${entry1Id}`);
        expectStatus(res, 200);
        expectKeys(res.body, ['entryId', 'hash', 'action']);
        expectEqual(res.body.entryId, entry1Id, 'entryId');
      }),
    );

    results.push(
      await test('Audit hash is a valid SHA-256 hex string', '§8', async () => {
        if (!entry1Hash) throw new Error('No hash from previous test');
        // SHA-256 hex string is 64 characters
        if (!/^[a-f0-9]{64}$/i.test(entry1Hash)) {
          throw new Error(`Expected SHA-256 hex hash, got: ${entry1Hash}`);
        }
      }),
    );

    return results;
  },
};
