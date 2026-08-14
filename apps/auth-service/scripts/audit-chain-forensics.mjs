#!/usr/bin/env node
/**
 * Audit-chain forensics — explain WHY a stored audit hash no longer verifies,
 * and distinguish a benign format/encoding artifact from genuine tampering.
 *
 * STRICTLY READ-ONLY. One SELECT inside `SET TRANSACTION READ ONLY`. It never
 * writes, never migrates, and never recomputes-and-stores a hash. Rewriting
 * historical hashes on a tamper-evident log destroys the only property the log
 * exists to provide, so this tool deliberately cannot do it.
 *
 * ── Root cause this tool was built to characterize ───────────────────────────
 * routes/audit.ts:101 passes `${JSON.stringify(metadata)}` into a JSONB column.
 * That double-encodes. postgres.js sets `describeFirst` when a query has
 * parameters (connection.js:238), asks the server to resolve parameter types,
 * then applies that type's serializer (connection.js:959). The jsonb serializer
 * is `JSON.stringify` (types.js:19). So the already-stringified value is
 * stringified a second time and the column holds a JSONB *string*:
 *
 *     jsonb_typeof(metadata) = 'string'
 *     metadata::text         = "{\"amount\":10}"      <- note the quoting
 *
 * Verified empirically against real Postgres 16 — see jsonb-writeback-probe.mjs.
 * `sql.json(metadata)` and passing the raw object both store a proper object.
 *
 * Consequence: `computeAuditHash` receives an object at write time and a STRING
 * at read time, so verifyChain (compliance.ts) fails on the very first entry,
 * for every row ever written, including rows written seconds ago. This is an
 * encoding defect, not evidence of tampering.
 *
 * ── Why the stored string is good news ───────────────────────────────────────
 * Because audit.ts:101 has stored `JSON.stringify(metadata)` since the service's
 * first commit (813ee176) and was never changed, the stored text preserves the
 * ORIGINAL JS insertion order — the exact bytes that went into the hash. Legacy
 * rows are therefore verifiable EXACTLY, with no guessing: splice the stored
 * string back in. No permutation search is needed for string-encoded rows.
 *
 * ── Hash format history (independent of the encoding defect) ────────────────
 *   Era A  813ee176 .. ede8b7ca^   (.. 2026-02-26)
 *          JSON.stringify({ …, metadata, timestamp, previousHash })
 *          Key is `previousHash`. No `status` field at all.
 *   Era B  ede8b7ca .. 903f0aee^   (2026-02-26 .. 2026-08-12)
 *          `prevHash` replaces `previousHash`; `status` appended.
 *          Metadata serialized in JS insertion order.
 *   Era C  903f0aee .. HEAD        (2026-08-12 ..)
 *          Field-by-field concatenation with canonically key-sorted metadata.
 *          Byte-identical to Era B when metadata is empty, single-key, or was
 *          already written in sorted order.
 *
 * Eras A and B hash metadata in insertion order; Era C canonicalizes it. Given
 * the stored string, both are checkable exactly — verbatim for A/B, parse-then-
 * canonicalize for C.
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *   node apps/auth-service/scripts/audit-chain-forensics.mjs \
 *     --url "$DATABASE_URL" --developer dev_abc123 --limit 20
 *
 *   node apps/auth-service/scripts/audit-chain-forensics.mjs --file rows.json
 *
 *   # Privacy-safe whole-database gate (no row/tenant identifiers in output):
 *   node apps/auth-service/scripts/audit-chain-forensics.mjs \
 *     --url "$DATABASE_URL" --limit 0 --summary-only --json --fail-on-findings
 *
 * Cloud SQL private instances need the Auth Proxy first:
 *   cloud-sql-proxy --port 5433 grantex-prod:us-central1:<instance>
 *   ... then --url "postgres://user:pw@127.0.0.1:5433/dbname"
 *
 * Flags:
 *   --url <conn>       Postgres connection string (default: $DATABASE_URL)
 *   --file <path>      Read rows from a JSON array instead of a database
 *   --developer <id>   Restrict to one developer. Chains are per-developer, so
 *                      without this, linkage across tenants is NOT checked.
 *   --limit <n>        Rows to examine, oldest first (default 20, 0 = all)
 *   --budget <n>       Cap on the permutation fallback, used only for rows whose
 *                      metadata is stored as an object (default 200000)
 *   --summary-only     Emit aggregate counts only. Suppresses row IDs, tenant
 *                      IDs, hashes, metadata key names, and metadata values.
 *   --fail-on-findings Exit 2 if any row is unexplained/inconclusive or any
 *                      per-developer previous_hash linkage is broken.
 *   --show-metadata    Print metadata values. Off by default — audit metadata is
 *                      customer data and this output tends to land in logs.
 *   --json             Machine-readable output
 *
 * Exit codes: 0 = ran successfully, 1 = usage or connection error, 2 = findings
 * when --fail-on-findings is set. Without that flag, findings remain exit 0.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// ─── args ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {
    url: process.env['DATABASE_URL'] ?? null,
    file: null,
    developer: null,
    limit: 20,
    budget: 200000,
    summaryOnly: false,
    failOnFindings: false,
    showMetadata: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--url': out.url = argv[++i]; break;
      case '--file': out.file = argv[++i]; break;
      case '--developer': out.developer = argv[++i]; break;
      case '--limit': out.limit = Number(argv[++i]); break;
      case '--budget': out.budget = Number(argv[++i]); break;
      case '--summary-only': out.summaryOnly = true; break;
      case '--fail-on-findings': out.failOnFindings = true; break;
      case '--show-metadata': out.showMetadata = true; break;
      case '--json': out.json = true; break;
      case '--help': case '-h': out.help = true; break;
      default: throw new Error(`unknown flag: ${a}`);
    }
  }
  if (!Number.isSafeInteger(out.limit) || out.limit < 0) throw new Error('--limit must be a non-negative integer');
  if (!Number.isSafeInteger(out.budget) || out.budget < 1) throw new Error('--budget must be a positive integer');
  if (out.summaryOnly && out.showMetadata) throw new Error('--summary-only cannot be combined with --show-metadata');
  return out;
}

// ─── the three historical hash formats ────────────────────────────────────────
// Each takes an already-serialized metadata string, so the caller controls which
// candidate serialization is being tested.

const sha256hex = (input) => createHash('sha256').update(input).digest('hex');
const S = JSON.stringify;

function prefix(f) {
  return '{'
    + `"id":${S(f.id)},`
    + `"agentId":${S(f.agentId)},`
    + `"agentDid":${S(f.agentDid)},`
    + `"grantId":${S(f.grantId)},`
    + `"principalId":${S(f.principalId)},`
    + `"developerId":${S(f.developerId)},`
    + `"action":${S(f.action)},`;
}

/** Era A — `previousHash`, no `status`. */
const hashEraA = (f, metaJson) => sha256hex(prefix(f)
  + `"metadata":${metaJson},"timestamp":${S(f.timestamp)},"previousHash":${S(f.prevHash ?? null)}}`);

/** Era B — `prevHash` + `status`. */
const hashEraB = (f, metaJson) => sha256hex(prefix(f)
  + `"metadata":${metaJson},"timestamp":${S(f.timestamp)},"prevHash":${S(f.prevHash ?? null)},"status":${S(f.status)}}`);

/** Era C — current production format (src/lib/hash.ts). Same shape as B; the
 *  difference lives entirely in which metadata serialization is supplied. */
const hashEraC = hashEraB;

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return S(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${S(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * dist/ is consulted only as a drift check. It is never used for verdicts: if
 * that build predates PR #887 it *is* an Era B implementation, and deferring to
 * it would report legacy rows as verifying — the exact false negative this tool
 * exists to prevent.
 */
async function distDriftCheck() {
  const probe = {
    id: 'alog_probe', agentId: 'ag', agentDid: 'did:grantex:ag', grantId: 'g',
    principalId: 'p', developerId: 'd', action: 'a',
    timestamp: '2026-01-01T00:00:00.000Z', prevHash: null, status: 'success',
  };
  const meta = { zebra: 1, alpha: { yankee: true, bravo: [3, 2] } };
  try {
    const mod = await import('../dist/lib/hash.js');
    if (typeof mod.computeAuditHash !== 'function') throw new Error('no export');
    const distHash = mod.computeAuditHash({ ...probe, metadata: meta });
    return distHash === hashEraC(probe, canonicalJson(meta))
      ? 'dist/lib/hash.js agrees'
      : 'DRIFT: dist/lib/hash.js is stale (pre-#887). Not used; rebuild to clear.';
  } catch {
    return 'dist/ absent — drift check skipped';
  }
}

// ─── metadata: encoding + candidate serializations ────────────────────────────

/**
 * Rows may hold metadata as a JSONB string (every row written by audit.ts:101)
 * or as a proper object (rows written via sql.json, i.e. after the fix). Both
 * must be handled, and the string form must be PARSED before canonical hashing —
 * treating it as an opaque string is what produces false "tampered" verdicts.
 */
function classifyMetadata(raw) {
  if (typeof raw === 'string') {
    try {
      return { encoding: 'string', parsed: JSON.parse(raw), storedText: raw, parseError: false };
    } catch {
      // JSON.parse error messages include a snippet of the input on current
      // Node versions. Store only a boolean so default output cannot leak data.
      return { encoding: 'string', parsed: null, storedText: raw, parseError: true };
    }
  }
  if (raw === null || raw === undefined) return { encoding: 'object', parsed: {}, storedText: null, parseError: false };
  if (typeof raw === 'object') return { encoding: Array.isArray(raw) ? 'array' : 'object', parsed: raw, storedText: null, parseError: false };
  return { encoding: typeof raw, parsed: raw, storedText: null, parseError: false };
}

const ORDERINGS = {
  'as-stored order': null,
  'lexicographic': (a, b) => (a < b ? -1 : a > b ? 1 : 0),
  'reverse-lexicographic': (a, b) => (a < b ? 1 : a > b ? -1 : 0),
  'length-then-bytes': (a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0),
};

function serializeWithOrder(value, cmp) {
  if (value === null || typeof value !== 'object') return S(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => serializeWithOrder(v, cmp)).join(',')}]`;
  let keys = Object.keys(value).filter((k) => value[k] !== undefined);
  if (cmp) keys = keys.slice().sort(cmp);
  return `{${keys.map((k) => `${S(k)}:${serializeWithOrder(value[k], cmp)}`).join(',')}}`;
}

/**
 * Ordered candidate serializations, best-evidence first.
 *
 * For a string-encoded row the FIRST candidate is the stored text verbatim.
 * That is not a guess: audit.ts:101 wrote exactly `JSON.stringify(metadata)`,
 * the same call whose output Eras A and B embedded in the hash, so the bytes
 * are identical and the match is exact.
 */
function metadataCandidates(meta) {
  const out = [];
  const seen = new Set();
  const add = (label, json) => {
    if (json === null || seen.has(json)) return;
    seen.add(json);
    out.push({ label, json });
  };
  if (meta.encoding === 'string' && meta.storedText !== null) {
    add('stored string verbatim (exact — original insertion order)', meta.storedText);
  }
  if (meta.parsed !== null && typeof meta.parsed === 'object') {
    add('parsed + canonicalized', canonicalJson(meta.parsed));
    for (const [name, cmp] of Object.entries(ORDERINGS)) add(`parsed, ${name}`, serializeWithOrder(meta.parsed, cmp));
  } else if (meta.parsed !== null) {
    add('scalar', S(meta.parsed));
  }
  // Only meaningful if metadata was somehow stored as a raw string that is not
  // valid JSON; kept so such a row still gets an exact check rather than a guess.
  if (meta.encoding === 'string' && meta.parseError) add('stored string as opaque scalar', S(meta.storedText));
  return out;
}

// ─── bounded permutation fallback (object-encoded rows only) ─────────────────

class BudgetExceeded extends Error {}
const makeBudget = (cap) => { let n = 0; return { spend() { if (++n > cap) throw new BudgetExceeded(); }, used: () => n }; };

function* permute(arr) {
  if (arr.length <= 1) { yield arr.slice(); return; }
  for (let i = 0; i < arr.length; i++) {
    for (const p of permute(arr.slice(0, i).concat(arr.slice(i + 1)))) yield [arr[i], ...p];
  }
}

function* crossProduct(lists) {
  if (lists.length === 0) { yield []; return; }
  const [first, ...rest] = lists;
  for (const item of first) for (const combo of crossProduct(rest)) yield [item, ...combo];
}

function* serializations(value, budget) {
  if (value === null || typeof value !== 'object') { yield S(value) ?? 'null'; return; }
  if (Array.isArray(value)) {
    const lists = value.map((v) => Array.from(serializations(v, budget)));
    for (const combo of crossProduct(lists)) { budget.spend(); yield `[${combo.join(',')}]`; }
    return;
  }
  const keys = Object.keys(value).filter((k) => value[k] !== undefined);
  if (keys.length === 0) { yield '{}'; return; }
  const perKey = new Map(keys.map((k) => [k, Array.from(serializations(value[k], budget))]));
  for (const perm of permute(keys)) {
    const lists = perm.map((k) => perKey.get(k).map((s) => `${S(k)}:${s}`));
    for (const combo of crossProduct(lists)) { budget.spend(); yield `{${combo.join(',')}}`; }
  }
}

// ─── timestamp candidates ─────────────────────────────────────────────────────

function timestampCandidates(row) {
  const raw = row.ts_raw ?? null;
  const value = row.timestamp;
  const date = value instanceof Date ? value : new Date(String(value));
  const out = new Set();
  if (!Number.isNaN(date.getTime())) {
    const iso = date.toISOString();
    out.add(iso);
    if (iso.endsWith('.000Z')) out.add(iso.replace('.000Z', 'Z'));
  }
  if (typeof value === 'string') out.add(value);
  if (raw) out.add(raw);
  return { candidates: [...out], subMillisecond: typeof raw === 'string' && /\.\d{4,}/.test(raw) };
}

// ─── row loading ──────────────────────────────────────────────────────────────

async function loadFromDatabase(opts) {
  let postgres;
  try { ({ default: postgres } = await import('postgres')); }
  catch { throw new Error('cannot resolve the `postgres` package — run with apps/auth-service dependencies installed'); }
  const sql = postgres(opts.url, { max: 1, idle_timeout: 5, connect_timeout: 10 });
  try {
    return await sql.begin(async (tx) => {
      // Belt and braces: even a bug in this script cannot write to production.
      await tx`SET TRANSACTION READ ONLY`;
      const dev = opts.developer;
      const lim = opts.limit === 0 ? 2147483647 : opts.limit;
      return await tx`
        SELECT id, agent_id, agent_did, grant_id, principal_id, developer_id,
               action, metadata, hash, previous_hash, timestamp, status,
               timestamp::text        AS ts_raw,
               jsonb_typeof(metadata) AS meta_type
        FROM audit_entries
        WHERE (${dev}::text IS NULL OR developer_id = ${dev ?? ''})
        -- Mirrors the export endpoint's chain order exactly (compliance.ts:375).
        ORDER BY timestamp ASC, id ASC
        LIMIT ${lim}
      `;
    });
  } finally {
    await sql.end();
  }
}

/**
 * File mode applies the same developer filter, ordering and limit as the SQL
 * path, so a dump and a live query produce the same analysis for the same input.
 */
function loadFromFile(path, opts) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error('--file must contain a JSON array of audit_entries rows');
  let rows = parsed;
  if (opts.developer) rows = rows.filter((r) => r.developer_id === opts.developer);
  rows = rows.slice().sort((a, b) => {
    const av = a.timestamp instanceof Date ? a.timestamp.getTime() : Date.parse(String(a.timestamp));
    const bv = b.timestamp instanceof Date ? b.timestamp.getTime() : Date.parse(String(b.timestamp));
    const byTime = Number.isFinite(av) && Number.isFinite(bv)
      ? av - bv
      : String(a.ts_raw ?? a.timestamp).localeCompare(String(b.ts_raw ?? b.timestamp));
    return byTime || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
  return opts.limit === 0 ? rows : rows.slice(0, opts.limit);
}

const toFields = (row, timestamp) => ({
  id: row.id,
  agentId: row.agent_id,
  agentDid: row.agent_did,
  grantId: row.grant_id,
  principalId: row.principal_id,
  developerId: row.developer_id,
  action: row.action,
  timestamp,
  prevHash: row.previous_hash ?? null,
  status: row.status ?? 'success',
});

// ─── analysis ─────────────────────────────────────────────────────────────────

/**
 * Era B and Era C share one hash function — the ONLY difference between them is
 * whether metadata went in as insertion-order or canonically sorted bytes. So
 * the era cannot be read off which function matched; it must be derived from
 * which candidate serialization matched. When the two coincide (empty,
 * single-key, or already-sorted metadata) the row is genuinely ambiguous and is
 * reported as such rather than guessed.
 */
function deriveBCEra(matchedJson, meta) {
  const canonical = meta.parsed !== null && typeof meta.parsed === 'object' ? canonicalJson(meta.parsed) : null;
  if (matchedJson === canonical) {
    // A JSONB object has already lost its original insertion order, so a
    // canonical-byte match could have been written by either B or C. A legacy
    // string is the only representation that preserves enough evidence to
    // distinguish them when its bytes differ from canonical.
    if (meta.encoding !== 'string') return 'B/C';
    return matchedJson === meta.storedText ? 'B/C' : 'C';
  }
  return 'B';
}

function analyzeRow(row, budgetCap) {
  const { candidates: timestamps, subMillisecond } = timestampCandidates(row);
  const meta = classifyMetadata(row.metadata);
  const metaCandidates = metadataCandidates(meta);

  const result = {
    id: row.id,
    developerId: row.developer_id,
    timestamp: row.ts_raw ?? String(row.timestamp),
    metaEncoding: row.meta_type ?? meta.encoding,
    metaKeys: meta.parsed && typeof meta.parsed === 'object' && !Array.isArray(meta.parsed) ? Object.keys(meta.parsed) : [],
    metadata: meta.parsed,
    metaParseError: meta.parseError ? 'invalid_json' : null,
    storedHash: row.hash,
    previousHash: row.previous_hash ?? null,
    subMillisecond,
    era: null,
    via: null,
    timestampUsed: null,
    truncated: false,
  };

  // Exact candidates first — for string-encoded rows these are not guesses.
  // Era A is a distinct field layout (previousHash, no status) so it is tested
  // on its own; B and C share a layout and are separated by deriveBCEra.
  for (const ts of timestamps) {
    const fields = toFields(row, ts);
    for (const cand of metaCandidates) {
      if (hashEraA(fields, cand.json) === row.hash) {
        return { ...result, era: 'A', via: cand.label, timestampUsed: ts };
      }
    }
    for (const cand of metaCandidates) {
      if (hashEraB(fields, cand.json) === row.hash) {
        return { ...result, era: deriveBCEra(cand.json, meta), via: cand.label, timestampUsed: ts };
      }
    }
  }

  // Fallback: only object-encoded rows can have lost their original key order,
  // so only they justify a search. String-encoded rows are already exact above.
  if (meta.encoding !== 'string' && meta.parsed && typeof meta.parsed === 'object') {
    for (const ts of timestamps) {
      const fields = toFields(row, ts);
      for (const [era, fn] of [['A', hashEraA], ['BC', hashEraB]]) {
        const budget = makeBudget(budgetCap);
        try {
          for (const metaJson of serializations(meta.parsed, budget)) {
            if (fn(fields, metaJson) === row.hash) {
              return {
                ...result,
                era: era === 'A' ? 'A' : deriveBCEra(metaJson, meta),
                via: 'recovered by permutation search',
                timestampUsed: ts,
              };
            }
          }
        } catch (err) {
          if (err instanceof BudgetExceeded) { result.truncated = true; continue; }
          throw err;
        }
      }
    }
  }

  return result; // era stays null
}

/** Chains are per-developer. Verifying across tenants invents false breaks. */
function linkageByDeveloper(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.developer_id)) groups.set(row.developer_id, []);
    groups.get(row.developer_id).push(row);
  }
  const out = [];
  for (const [dev, list] of groups) {
    let prev = null, broken = null;
    for (const row of list) {
      const entryPrev = row.previous_hash ?? null;
      if (prev !== null && entryPrev !== prev) { broken = row.id; break; }
      prev = row.hash;
    }
    out.push({ developerId: dev, rows: list.length, broken });
  }
  return out;
}

// ─── report ───────────────────────────────────────────────────────────────────

const ERA_LABEL = {
  A: 'Era A  (pre-2026-02-26: previousHash, no status)',
  B: 'Era B  (2026-02-26..2026-08-12: prevHash + status, insertion-order metadata)',
  C: 'Era C  (current: canonical metadata)',
  'B/C': 'Era B or C (indistinguishable — insertion order already equals canonical)',
};

function summarize(rows, results) {
  const encodingCounts = {};
  const formats = { A: 0, B: 0, C: 0, 'B/C': 0 };
  let explained = 0;
  let unexplained = 0;
  let inconclusive = 0;
  let invalidJsonStrings = 0;
  let subMillisecondTimestamps = 0;

  for (const result of results) {
    encodingCounts[result.metaEncoding] = (encodingCounts[result.metaEncoding] ?? 0) + 1;
    if (result.metaParseError) invalidJsonStrings += 1;
    if (result.subMillisecond) subMillisecondTimestamps += 1;
    if (result.era) {
      explained += 1;
      formats[result.era] += 1;
    } else if (result.truncated) {
      inconclusive += 1;
    } else {
      unexplained += 1;
    }
  }

  const metadataEncoding = Object.fromEntries(
    Object.entries(encodingCounts).sort(([left], [right]) => left.localeCompare(right)),
  );
  const linkage = linkageByDeveloper(rows);
  const brokenDevelopers = linkage.filter((group) => group.broken).length;

  return {
    rowsExamined: results.length,
    developersExamined: linkage.length,
    storage: {
      metadataEncoding,
      invalidJsonStrings,
    },
    verification: {
      explained,
      unexplained,
      inconclusive,
      formats,
      subMillisecondTimestamps,
    },
    linkage: {
      intactDevelopers: linkage.length - brokenDevelopers,
      brokenDevelopers,
    },
    hasFindings: unexplained > 0
      || inconclusive > 0
      || invalidJsonStrings > 0
      || brokenDevelopers > 0,
  };
}

function reportSummary(summary, drift, opts) {
  const line = '─'.repeat(78);
  console.log(`\n${line}\nAUDIT CHAIN FORENSICS — SUMMARY ONLY\n${line}`);
  console.log(`Scope          : ${opts.developer ? 'single developer' : 'all developers'}`);
  console.log(`Rows examined  : ${summary.rowsExamined}`);
  console.log(`Developers     : ${summary.developersExamined}`);
  console.log(`Era C source   : inline transcription of src/lib/hash.ts — ${drift}`);
  console.log('\nMetadata encoding:');
  for (const [encoding, count] of Object.entries(summary.storage.metadataEncoding)) {
    console.log(`  ${String(encoding).padEnd(12)} ${count}`);
  }
  console.log(`  invalid JSON ${summary.storage.invalidJsonStrings}`);
  console.log('\nHash verification:');
  console.log(`  explained    ${summary.verification.explained}`);
  console.log(`  unexplained  ${summary.verification.unexplained}`);
  console.log(`  inconclusive ${summary.verification.inconclusive}`);
  for (const format of ['A', 'B', 'C', 'B/C']) {
    console.log(`  Era ${format.padEnd(3)}      ${summary.verification.formats[format]}`);
  }
  console.log(`  sub-ms time  ${summary.verification.subMillisecondTimestamps}`);
  console.log('\nLinkage:');
  console.log(`  intact       ${summary.linkage.intactDevelopers}`);
  console.log(`  broken       ${summary.linkage.brokenDevelopers}`);
  console.log(`\nResult         : ${summary.hasFindings ? 'FINDINGS REQUIRE REVIEW' : 'CLEAN'}\n`);
}

function report(rows, results, drift, opts) {
  const line = '─'.repeat(78);
  console.log(`\n${line}\nAUDIT CHAIN FORENSICS\n${line}`);
  console.log(`Rows examined : ${results.length}${opts.developer ? `  (developer ${opts.developer})` : '  (ALL developers)'}`);
  console.log(`Era C source  : inline transcription of src/lib/hash.ts — ${drift}`);

  // ── 1. storage encoding ──
  const encCounts = results.reduce((a, r) => { a[r.metaEncoding] = (a[r.metaEncoding] ?? 0) + 1; return a; }, {});
  console.log(`\n${line}\n1. How is metadata stored?  (the audit.ts:101 double-encoding defect)\n${line}`);
  for (const [t, n] of Object.entries(encCounts)) console.log(`  jsonb_typeof = ${String(t).padEnd(8)} ${n} row(s)`);
  const strings = encCounts['string'] ?? 0;
  if (strings > 0) {
    console.log(`\n  => CONFIRMED: ${strings} row(s) hold a double-encoded JSON STRING.`);
    console.log('     audit.ts:101 passes JSON.stringify(metadata) into a JSONB parameter;');
    console.log('     postgres.js then applies the jsonb serializer (JSON.stringify) again.');
    console.log('     computeAuditHash sees an object on write and a string on read, so');
    console.log('     verifyChain fails on the first entry for EVERY row ever written.');
    console.log('     Fix the write path with sql.json(metadata) and decode on read.');
  } else {
    console.log('\n  => No double-encoded rows in this sample; metadata is stored as JSONB objects.');
  }
  const badParse = results.filter((r) => r.metaParseError);
  if (badParse.length) {
    console.log(`\n  !! ${badParse.length} row(s) hold a string that is not valid JSON:`);
    for (const r of badParse.slice(0, 5)) console.log(`     - ${r.id}`);
  }

  // ── 2. era attribution ──
  const eraCounts = results.reduce((a, r) => { const k = r.era ?? 'unmatched'; a[k] = (a[k] ?? 0) + 1; return a; }, {});
  console.log(`\n${line}\n2. Which hash format wrote each row?\n${line}`);
  for (const era of ['A', 'B', 'C', 'B/C']) if (eraCounts[era]) console.log(`  ${String(eraCounts[era]).padStart(4)}  ${ERA_LABEL[era]}`);
  if (eraCounts['unmatched']) console.log(`  ${String(eraCounts['unmatched']).padStart(4)}  UNMATCHED — no historical format reproduces the stored hash`);
  console.log('\n  Note: Eras B and C share a field layout and differ only in metadata byte');
  console.log('  order, so rows whose insertion order already equals canonical order cannot');
  console.log('  be attributed to one or the other and are reported as "B/C".');

  // ── 3. per-row ──
  console.log(`\n${line}\n3. Per-row detail (oldest first)\n${line}`);
  for (const r of results) {
    const verdict = r.era
      ? `EXPLAINED — Era ${r.era}`
      : r.truncated ? 'INCONCLUSIVE (search budget exhausted)' : 'UNEXPLAINED';
    console.log(`\n  ${r.id}   ${r.timestamp}   [${r.developerId}]`);
    console.log(`    verdict     : ${verdict}`);
    console.log(`    metadata    : ${r.metaEncoding}${r.metaKeys.length ? ` — ${r.metaKeys.length} key(s): ${r.metaKeys.join(', ')}` : ' — empty'}`);
    if (r.era) console.log(`    matched via : ${r.via}`);
    if (r.subMillisecond) {
      console.log('    NOTE        : sub-millisecond timestamp (column DEFAULT NOW()); a JS Date');
      console.log('                  cannot represent it, so the hashed string is unrecoverable.');
    }
    if (opts.showMetadata) console.log(`    value       : ${S(r.metadata)}`);
  }

  // ── 4. linkage ──
  console.log(`\n${line}\n4. Linkage (previous_hash chaining, per developer)\n${line}`);
  if (!opts.developer) {
    console.log('  Chains are per-developer; each is checked separately below. Pass --developer');
    console.log('  to scope the whole report to the tenant whose export failed.\n');
  }
  const linkage = linkageByDeveloper(rows);
  for (const g of linkage) {
    console.log(g.broken
      ? `  ${g.developerId}: BROKEN at ${g.broken} (${g.rows} row(s)) — not explained by a format change.`
      : `  ${g.developerId}: INTACT (${g.rows} row(s))`);
  }
  const anyLinkBreak = linkage.some((g) => g.broken);

  // ── 5. conclusion ──
  console.log(`\n${line}\n5. Conclusion\n${line}`);
  const unexplained = results.filter((r) => r.era === null && !r.truncated);
  const inconclusive = results.filter((r) => r.truncated);

  if (unexplained.length) {
    console.log(`  ${unexplained.length} row(s) match NO historical format under any candidate`);
    console.log('  serialization. That is not explained by the encoding defect or the format');
    console.log('  history, and warrants investigation:');
    for (const r of unexplained.slice(0, 10)) console.log(`    - ${r.id}  ${r.timestamp}  [${r.developerId}]`);
  } else if (inconclusive.length) {
    console.log(`  ${inconclusive.length} row(s) exhausted the search budget and are INCONCLUSIVE,`);
    console.log('  not negative. Re-run with a larger --budget before drawing any conclusion.');
  } else if (strings > 0) {
    console.log('  Every row is explained. The verification failure is the audit.ts:101');
    console.log('  double-encoding defect, not tampering.');
    console.log('');
    console.log('  Because the stored string preserves the original insertion order, these');
    console.log('  hashes remain checkable EXACTLY. The remediation is therefore:');
    console.log('    1. Write new metadata with sql.json(metadata).');
    console.log('    2. Decode string-encoded metadata on read and in verifyChain.');
    console.log('    3. Verify mixed chains era-aware (A/B verbatim, C parse-then-canonical).');
    console.log('');
    console.log('  Do NOT migrate stored metadata from string to object. Converting it lets');
    console.log('  Postgres normalize key order, destroying the insertion order that Era A/B');
    console.log('  hashes are taken over, and permanently breaking rows that verify today.');
  } else {
    console.log('  Every row examined verifies under a known format with no encoding defect');
    console.log('  present. The production failure is not reproduced by this sample — widen');
    console.log('  --limit, or confirm the export ran against this same developer_id.');
  }
  if (anyLinkBreak) {
    console.log('\n  Linkage is broken for at least one developer. Linkage is independent of');
    console.log('  content hashing and is NOT affected by the encoding defect — treat it as a');
    console.log('  genuine integrity finding (tampering or row deletion) until shown otherwise.');
  }
  console.log('');
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); }
  catch (err) {
    console.error(`error: ${err.message}\n`);
    console.error('usage: audit-chain-forensics.mjs [--url <conn> | --file <path>] [--developer <id>] [--limit <n>] [--summary-only] [--fail-on-findings] [--json]');
    process.exit(1);
  }
  if (opts.help) {
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n/, ''));
    return;
  }

  let rows;
  try {
    if (opts.file) rows = loadFromFile(opts.file, opts);
    else if (opts.url) rows = await loadFromDatabase(opts);
    else throw new Error('no data source — pass --url, --file, or set DATABASE_URL');
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }

  if (rows.length === 0) { console.log('No audit entries matched. Nothing to analyze.'); return; }

  const drift = await distDriftCheck();
  const results = rows.map((row) => analyzeRow(row, opts.budget));
  const summary = summarize(rows, results);

  if (opts.summaryOnly) {
    if (opts.json) {
      console.log(JSON.stringify({
        eraCSource: `inline (${drift})`,
        scope: opts.developer ? 'single-developer' : 'all-developers',
        summary,
      }, null, 2));
    } else {
      reportSummary(summary, drift, opts);
    }
    if (opts.failOnFindings && summary.hasFindings) process.exitCode = 2;
    return;
  }

  if (opts.json) {
    // Metadata values are customer data; withheld unless explicitly requested,
    // since this output is the kind that gets piped to a file.
    const emitted = opts.showMetadata ? results : results.map(({ metadata, ...rest }) => rest);
    console.log(JSON.stringify({
      eraCSource: `inline (${drift})`,
      rows: emitted,
      linkage: linkageByDeveloper(rows),
    }, null, 2));
  } else {
    report(rows, results, drift, opts);
  }
  if (opts.failOnFindings && summary.hasFindings) process.exitCode = 2;
}

await main();
