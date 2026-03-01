export interface LogEntry {
  level: 'info' | 'warn' | 'error';
  message: string;
  timestamp: string;
  [key: string]: unknown;
}

export function log(level: LogEntry['level'], message: string, extra?: Record<string, unknown>): void {
  const entry: LogEntry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...extra,
  };
  const output = JSON.stringify(entry);

  if (level === 'error') {
    process.stderr.write(output + '\n');
  } else {
    process.stdout.write(output + '\n');
  }
}
