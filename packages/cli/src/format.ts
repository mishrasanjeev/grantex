/**
 * Output formatting for CLI.
 * Supports --json global flag for machine-readable output (AI agent friendly).
 */

/** Whether --json was passed globally. Set by index.ts before commands run. */
let jsonMode = false;

export function setJsonMode(enabled: boolean): void {
  jsonMode = enabled;
}

export function isJsonMode(): boolean {
  return jsonMode;
}

/**
 * Print data as JSON array (if --json) or ASCII table.
 * `rawRows` contains unformatted data for JSON output; `displayRows`/`columns` are for tables.
 */
export function printTable(
  displayRows: Record<string, string>[],
  columns: string[],
  rawRows?: Record<string, unknown>[],
): void {
  if (jsonMode) {
    console.log(JSON.stringify(rawRows ?? displayRows, null, 2));
    return;
  }

  if (displayRows.length === 0) {
    console.log('(no results)');
    return;
  }

  const widths = columns.map((col) =>
    Math.max(col.length, ...displayRows.map((r) => (r[col] ?? '').length)),
  );

  const pad = (s: string, w: number) => s.padEnd(w);
  const divider = widths.map((w) => '-'.repeat(w)).join('  ');

  console.log(columns.map((c, i) => pad(c.toUpperCase(), widths[i] ?? c.length)).join('  '));
  console.log(divider);
  for (const row of displayRows) {
    console.log(columns.map((c, i) => pad(row[c] ?? '', widths[i] ?? 0)).join('  '));
  }
}

/** Format an ISO date string to a short local representation. */
export function shortDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Print a single record as JSON object (if --json) or key-value block. */
export function printRecord(record: Record<string, string>, raw?: Record<string, unknown>): void {
  if (jsonMode) {
    console.log(JSON.stringify(raw ?? record, null, 2));
    return;
  }

  const keyWidth = Math.max(...Object.keys(record).map((k) => k.length));
  for (const [k, v] of Object.entries(record)) {
    console.log(`${k.padEnd(keyWidth)}  ${v}`);
  }
}

/** Build table string without printing (for file writing in compliance). */
export function tableToString(rows: Record<string, string>[], columns: string[]): string {
  if (rows.length === 0) return '(no results)';

  const widths = columns.map((col) =>
    Math.max(col.length, ...rows.map((r) => (r[col] ?? '').length)),
  );
  const pad = (s: string, w: number) => s.padEnd(w);
  const lines: string[] = [];
  lines.push(columns.map((c, i) => pad(c.toUpperCase(), widths[i] ?? c.length)).join('  '));
  lines.push(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) {
    lines.push(columns.map((c, i) => pad(row[c] ?? '', widths[i] ?? 0)).join('  '));
  }
  return lines.join('\n');
}
