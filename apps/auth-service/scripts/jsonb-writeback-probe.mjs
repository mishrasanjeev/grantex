#!/usr/bin/env node
/**
 * Settles one question with a real Postgres: what does audit.ts:101 actually
 * store in the JSONB `metadata` column?
 *
 * The competing claims are (a) postgres.js sends a JS string with type OID 0,
 * Postgres resolves it against the JSONB column and parses it into an object;
 * (b) postgres.js JSON-serializes the already-stringified value again, storing
 * a JSON string. Both predict identical API output once you parse, so only the
 * stored jsonb_typeof discriminates.
 *
 * Reproduces the exact statement shape from routes/audit.ts — same column list,
 * same VALUES ordering, same parameter position — because parameter type
 * inference depends on that context.
 *
 * Uses a transaction-scoped TEMP table that is dropped automatically at
 * commit. It never drops, replaces, or updates an existing table.
 *
 * Usage: node jsonb-writeback-probe.mjs "postgres://user:pw@host:port/db"
 */

import postgres from 'postgres';

const url = process.argv[2];
if (!url) { console.error('usage: jsonb-writeback-probe.mjs <connection-string>'); process.exit(1); }

const sql = postgres(url, { max: 1, idle_timeout: 5, connect_timeout: 10 });

const metadata = { zebra: 1, alpha: { yankee: true, bravo: [3, 2] }, mike: 'x' };

try {
  const results = await sql.begin(async (tx) => {
    // Verbatim columns from migrations 001_initial.sql + 002_spec_compliance.sql.
    // pg_temp shadows any permanent table with the same name for this session.
    await tx`
      CREATE TEMP TABLE audit_entries (
        id            TEXT PRIMARY KEY,
        agent_id      TEXT NOT NULL,
        agent_did     TEXT NOT NULL,
        grant_id      TEXT NOT NULL,
        principal_id  TEXT NOT NULL,
        developer_id  TEXT NOT NULL,
        action        TEXT NOT NULL,
        metadata      JSONB NOT NULL DEFAULT '{}',
        hash          TEXT NOT NULL,
        previous_hash TEXT,
        timestamp     TIMESTAMPTZ DEFAULT NOW(),
        status        TEXT NOT NULL DEFAULT 'success'
      ) ON COMMIT DROP`;

    const variants = [
      ['A: JSON.stringify(metadata)  <- historical audit.ts:101', JSON.stringify(metadata)],
      ['B: metadata (raw object)', metadata],
      ['C: sql.json(metadata)  <- fixed write path', tx.json(metadata)],
    ];

    const rows = [];
    for (const [label, param] of variants) {
      const id = `alog_${rows.length}`;
      // Same column list and ordering as routes/audit.ts.
      await tx`
        INSERT INTO audit_entries (id, agent_id, agent_did, grant_id, principal_id, developer_id, action, metadata, hash, previous_hash, timestamp, status)
        VALUES (
          ${id}, ${'ag_01'}, ${'did:grantex:ag_01'}, ${'grnt_01'}, ${'user_01'},
          ${'dev_TEST'}, ${'tool.run'}, ${param}, ${'deadbeef'},
          ${null}, ${'2026-01-01T00:00:00.000Z'}, ${'success'}
        )`;
      const [row] = await tx`
        SELECT jsonb_typeof(metadata) AS jtype, metadata, metadata::text AS raw
        FROM audit_entries WHERE id = ${id}`;
      rows.push({ label, jtype: row.jtype, driverType: typeof row.metadata, raw: row.raw });
    }
    return rows;
  });

  console.log('\nWhat each write style stores in a JSONB column\n' + '─'.repeat(72));
  for (const r of results) {
    console.log(`\n${r.label}`);
    console.log(`  jsonb_typeof(metadata) : ${r.jtype}`);
    console.log(`  driver read-back type  : ${r.driverType}`);
    console.log(`  stored text            : ${r.raw.length > 90 ? r.raw.slice(0, 90) + '…' : r.raw}`);
  }

  const asWritten = results[0];
  console.log('\n' + '─'.repeat(72));
  console.log(asWritten.jtype === 'object'
    ? 'VERDICT: audit.ts:101 stores a JSONB OBJECT. Double-encoding does not occur.'
    : `VERDICT: audit.ts:101 stores a JSONB ${asWritten.jtype.toUpperCase()} — the value is double-encoded.`);
  console.log('');
} finally {
  await sql.end();
}
