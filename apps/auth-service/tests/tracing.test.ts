import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unmock tracing so we test the real implementation
vi.unmock('../src/lib/tracing.js');

// Hoist mock objects so they're available in vi.mock factories
const { mockSetAttribute, mockSetStatus, mockEnd, mockStartActiveSpan, mockGetTracer } = vi.hoisted(() => {
  const mockSetAttribute = vi.fn();
  const mockSetStatus = vi.fn();
  const mockEnd = vi.fn();
  const mockSpan = { setAttribute: mockSetAttribute, setStatus: mockSetStatus, end: mockEnd };
  const mockStartActiveSpan = vi.fn((_name: string, fn: (span: typeof mockSpan) => unknown) => fn(mockSpan));
  const mockGetTracer = vi.fn().mockReturnValue({ startActiveSpan: mockStartActiveSpan });
  return { mockSetAttribute, mockSetStatus, mockEnd, mockStartActiveSpan, mockGetTracer };
});

vi.mock('@opentelemetry/api', () => ({
  trace: { getTracer: mockGetTracer },
  SpanStatusCode: { OK: 1, ERROR: 2 },
}));

import { getTracer, withSpan } from '../src/lib/tracing.js';
import {
  GRANTEX_AGENT_ID,
  GRANTEX_GRANT_ID,
  GRANTEX_PRINCIPAL_ID,
  GRANTEX_SCOPES,
  GRANTEX_DEVELOPER_ID,
} from '../src/lib/traceAttributes.js';

beforeEach(() => {
  mockSetAttribute.mockClear();
  mockSetStatus.mockClear();
  mockEnd.mockClear();
  mockStartActiveSpan.mockClear();
});

describe('traceAttributes', () => {
  it('exports correct attribute keys', () => {
    expect(GRANTEX_AGENT_ID).toBe('grantex.agent_id');
    expect(GRANTEX_GRANT_ID).toBe('grantex.grant_id');
    expect(GRANTEX_PRINCIPAL_ID).toBe('grantex.principal_id');
    expect(GRANTEX_SCOPES).toBe('grantex.scopes');
    expect(GRANTEX_DEVELOPER_ID).toBe('grantex.developer_id');
  });
});

describe('getTracer', () => {
  it('returns a tracer with default name', () => {
    getTracer();
    expect(mockGetTracer).toHaveBeenCalledWith('grantex-auth-service');
  });

  it('returns a tracer with custom name', () => {
    getTracer('custom');
    expect(mockGetTracer).toHaveBeenCalledWith('custom');
  });
});

describe('withSpan', () => {
  it('executes the function within a span', async () => {
    const result = await withSpan('test-span', {}, async () => 42);
    expect(result).toBe(42);
  });

  it('sets attributes on the span', async () => {
    await withSpan('test-span', {
      [GRANTEX_AGENT_ID]: 'ag_1',
      [GRANTEX_GRANT_ID]: 'grnt_1',
    }, async () => undefined);

    expect(mockSetAttribute).toHaveBeenCalledWith('grantex.agent_id', 'ag_1');
    expect(mockSetAttribute).toHaveBeenCalledWith('grantex.grant_id', 'grnt_1');
  });

  it('sets OK status on success', async () => {
    await withSpan('test-span', {}, async () => undefined);

    expect(mockSetStatus).toHaveBeenCalledWith({ code: 1 }); // SpanStatusCode.OK
  });

  it('sets ERROR status on failure', async () => {
    await expect(
      withSpan('test-span', {}, async () => {
        throw new Error('test error');
      }),
    ).rejects.toThrow('test error');

    expect(mockSetStatus).toHaveBeenCalledWith({
      code: 2, // SpanStatusCode.ERROR
      message: 'test error',
    });
  });

  it('always ends the span', async () => {
    await withSpan('test-span', {}, async () => undefined);
    expect(mockEnd).toHaveBeenCalledOnce();
  });

  it('ends the span even on error', async () => {
    await withSpan('test-span', {}, async () => {
      throw new Error('fail');
    }).catch(() => {});

    expect(mockEnd).toHaveBeenCalledOnce();
  });

  it('supports array attributes (scopes)', async () => {
    await withSpan('test-span', {
      [GRANTEX_SCOPES]: ['read', 'write'],
    }, async () => undefined);

    expect(mockSetAttribute).toHaveBeenCalledWith('grantex.scopes', ['read', 'write']);
  });
});
