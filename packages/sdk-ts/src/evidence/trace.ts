/** Tracing a recommendation back to upstream records, from the package alone. */

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface UpstreamRecordTrace {
  call_id: string;
  connector: string;
  tool: string;
  provider: string;
  grant_id: string;
  record_id: string;
  record_type?: string;
  retrieved_at: string;
  cited_by: string[];
}

/**
 * Every upstream record behind a recommendation: follows the recommendation's
 * section citations and those of its policy evaluation to the tool calls that
 * retrieved each record. One item per distinct (call, record), ordered by
 * entry sequence then record position. Call on a verified package; throws for
 * an unknown recommendation.
 */
export function upstreamRecordsFor(document: Json, recommendationId: string): UpstreamRecordTrace[] {
  const calls = new Map<string, [number, Json]>();
  const evaluations = new Map<string, [number, Json]>();
  let recommendation: [number, Json] | undefined;
  for (const entry of document['entries'] as Json[]) {
    const data = entry['data'] as Json;
    if (entry['type'] === 'tool_call') calls.set(data['call_id'], [entry['seq'], data]);
    else if (entry['type'] === 'policy_evaluation') evaluations.set(data['evaluation_id'], [entry['seq'], data]);
    else if (entry['type'] === 'recommendation' && data['recommendation_id'] === recommendationId) {
      recommendation = [entry['seq'], data];
    }
  }
  if (!recommendation) throw new Error(`unknown recommendation ${recommendationId}`);

  const citations: Array<[string, Json]> = [];
  const [recSeq, rec] = recommendation;
  (rec['sections'] as Json[]).forEach((section, s) => {
    (section['evidence'] as Json[]).forEach((ref, e) => {
      citations.push([`entries[${recSeq}].data.sections[${s}].evidence[${e}]`, ref]);
    });
  });
  const [evalSeq, evaluation] = evaluations.get(rec['evaluation_id'])!;
  (evaluation['inputs'] as Json[]).forEach((item, i) => {
    (item['evidence'] as Json[]).forEach((ref, e) => {
      citations.push([`entries[${evalSeq}].data.inputs[${i}].evidence[${e}]`, ref]);
    });
  });

  const found = new Map<string, [number, number, UpstreamRecordTrace]>();
  for (const [path, ref] of citations) {
    const [callSeq, call] = calls.get(ref['call_id'])!;
    (call['upstream_records'] as Json[]).forEach((record, position) => {
      if (record['record_id'] !== ref['record_id']) return;
      const key = `${callSeq}:${position}`;
      let item = found.get(key);
      if (!item) {
        const trace: UpstreamRecordTrace = {
          call_id: call['call_id'],
          connector: call['connector'],
          tool: call['tool'],
          provider: call['provider'],
          grant_id: call['grant_id'],
          record_id: record['record_id'],
          retrieved_at: record['retrieved_at'],
          cited_by: [],
        };
        if ('record_type' in record) trace.record_type = record['record_type'];
        item = [callSeq, position, trace];
        found.set(key, item);
      }
      item[2].cited_by.push(path);
    });
  }
  return [...found.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((item) => item[2]);
}
