import type { HttpResponse, TestResult, TestStatus } from './types.js';

export async function test(
  name: string,
  specRef: string,
  fn: () => Promise<void>,
): Promise<TestResult> {
  const start = Date.now();
  try {
    await fn();
    return { name, status: 'pass', durationMs: Date.now() - start, specRef };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { name, status: 'fail', durationMs: Date.now() - start, specRef, error };
  }
}

export function skip(name: string, specRef: string, reason: string): TestResult {
  return { name, status: 'skip', durationMs: 0, specRef, error: reason };
}

export class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssertionError';
  }
}

export function expectStatus(res: HttpResponse, expected: number): void {
  if (res.status !== expected) {
    throw new AssertionError(
      `Expected status ${expected}, got ${res.status}: ${res.rawText.slice(0, 200)}`,
    );
  }
}

export function expectKeys(body: unknown, keys: string[]): void {
  if (typeof body !== 'object' || body === null) {
    throw new AssertionError(`Expected object, got ${typeof body}`);
  }
  const obj = body as Record<string, unknown>;
  const missing = keys.filter((k) => !(k in obj));
  if (missing.length > 0) {
    throw new AssertionError(`Missing keys: ${missing.join(', ')}`);
  }
}

export function expectString(val: unknown, field: string): void {
  if (typeof val !== 'string' || val.length === 0) {
    throw new AssertionError(`Expected non-empty string for "${field}", got ${JSON.stringify(val)}`);
  }
}

export function expectArray(val: unknown, field: string): void {
  if (!Array.isArray(val)) {
    throw new AssertionError(`Expected array for "${field}", got ${typeof val}`);
  }
}

export function expectBoolean(val: unknown, field: string): void {
  if (typeof val !== 'boolean') {
    throw new AssertionError(`Expected boolean for "${field}", got ${typeof val}`);
  }
}

export function expectIsoDate(val: unknown, field: string): void {
  if (typeof val !== 'string') {
    throw new AssertionError(`Expected ISO date string for "${field}", got ${typeof val}`);
  }
  const d = new Date(val);
  if (isNaN(d.getTime())) {
    throw new AssertionError(`Invalid ISO date for "${field}": ${val}`);
  }
}

export function expectEqual(actual: unknown, expected: unknown, field: string): void {
  if (actual !== expected) {
    throw new AssertionError(
      `Expected "${field}" to be ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

export function expectIncludes(arr: unknown[], value: unknown, field: string): void {
  if (!arr.includes(value)) {
    throw new AssertionError(
      `Expected "${field}" to include ${JSON.stringify(value)}, got ${JSON.stringify(arr)}`,
    );
  }
}
