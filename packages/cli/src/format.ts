/**
 * Minimal table formatter for CLI output.
 * Prints a header row + divider + data rows, padded to column widths.
 */
export function printTable(rows: Record<string, string>[], columns: string[]): void {
  if (rows.length === 0) {
    console.log('(no results)');
    return;
  }

  const widths = columns.map((col) =>
    Math.max(col.length, ...rows.map((r) => (r[col] ?? '').length)),
  );

  const pad = (s: string, w: number) => s.padEnd(w);
  const divider = widths.map((w) => '-'.repeat(w)).join('  ');

  console.log(columns.map((c, i) => pad(c.toUpperCase(), widths[i] ?? c.length)).join('  '));
  console.log(divider);
  for (const row of rows) {
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

/** Print a labelled key-value block (for single-record views). */
export function printRecord(record: Record<string, string>): void {
  const keyWidth = Math.max(...Object.keys(record).map((k) => k.length));
  for (const [k, v] of Object.entries(record)) {
    console.log(`${k.padEnd(keyWidth)}  ${v}`);
  }
}
