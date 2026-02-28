import { describe, it, expect } from 'vitest';
import {
  test as testHelper,
  expectStatus,
  expectKeys,
  expectString,
  expectArray,
  expectBoolean,
  expectIsoDate,
  expectEqual,
  expectIncludes,
  skip,
  AssertionError,
} from '../src/helpers.js';
import type { HttpResponse } from '../src/types.js';

function mockResponse<T>(status: number, body: T): HttpResponse<T> {
  return { status, body, rawText: JSON.stringify(body), durationMs: 10 };
}

describe('test()', () => {
  it('returns pass on success', async () => {
    const result = await testHelper('my test', '§1', async () => {
      // no-op
    });
    expect(result.name).toBe('my test');
    expect(result.status).toBe('pass');
    expect(result.specRef).toBe('§1');
    expect(result.error).toBeUndefined();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns fail on thrown error', async () => {
    const result = await testHelper('fail test', '§2', async () => {
      throw new Error('something broke');
    });
    expect(result.status).toBe('fail');
    expect(result.error).toBe('something broke');
  });

  it('returns fail on non-Error throw', async () => {
    const result = await testHelper('fail test', '§2', async () => {
      throw 'string error';
    });
    expect(result.status).toBe('fail');
    expect(result.error).toBe('string error');
  });
});

describe('skip()', () => {
  it('returns skip result', () => {
    const result = skip('skipped test', '§3', 'not applicable');
    expect(result.status).toBe('skip');
    expect(result.error).toBe('not applicable');
    expect(result.durationMs).toBe(0);
  });
});

describe('expectStatus()', () => {
  it('passes on matching status', () => {
    const res = mockResponse(200, {});
    expect(() => expectStatus(res, 200)).not.toThrow();
  });

  it('throws on mismatched status', () => {
    const res = mockResponse(404, { message: 'not found' });
    expect(() => expectStatus(res, 200)).toThrow(AssertionError);
    expect(() => expectStatus(res, 200)).toThrow('Expected status 200, got 404');
  });
});

describe('expectKeys()', () => {
  it('passes when all keys present', () => {
    expect(() => expectKeys({ a: 1, b: 2, c: 3 }, ['a', 'b'])).not.toThrow();
  });

  it('throws on missing keys', () => {
    expect(() => expectKeys({ a: 1 }, ['a', 'b', 'c'])).toThrow('Missing keys: b, c');
  });

  it('throws on non-object', () => {
    expect(() => expectKeys('string', ['a'])).toThrow('Expected object');
    expect(() => expectKeys(null, ['a'])).toThrow('Expected object');
  });
});

describe('expectString()', () => {
  it('passes on non-empty string', () => {
    expect(() => expectString('hello', 'field')).not.toThrow();
  });

  it('throws on empty string', () => {
    expect(() => expectString('', 'field')).toThrow('non-empty string');
  });

  it('throws on non-string', () => {
    expect(() => expectString(42, 'field')).toThrow('non-empty string');
  });
});

describe('expectArray()', () => {
  it('passes on array', () => {
    expect(() => expectArray([1, 2], 'field')).not.toThrow();
  });

  it('throws on non-array', () => {
    expect(() => expectArray('not-array', 'field')).toThrow('Expected array');
  });
});

describe('expectBoolean()', () => {
  it('passes on boolean', () => {
    expect(() => expectBoolean(true, 'field')).not.toThrow();
    expect(() => expectBoolean(false, 'field')).not.toThrow();
  });

  it('throws on non-boolean', () => {
    expect(() => expectBoolean(1, 'field')).toThrow('Expected boolean');
  });
});

describe('expectIsoDate()', () => {
  it('passes on valid ISO date', () => {
    expect(() => expectIsoDate('2026-02-28T00:00:00.000Z', 'field')).not.toThrow();
  });

  it('throws on invalid date', () => {
    expect(() => expectIsoDate('not-a-date', 'field')).toThrow('Invalid ISO date');
  });

  it('throws on non-string', () => {
    expect(() => expectIsoDate(42, 'field')).toThrow('Expected ISO date string');
  });
});

describe('expectEqual()', () => {
  it('passes on equal values', () => {
    expect(() => expectEqual(42, 42, 'field')).not.toThrow();
    expect(() => expectEqual('abc', 'abc', 'field')).not.toThrow();
  });

  it('throws on unequal values', () => {
    expect(() => expectEqual(42, 43, 'field')).toThrow('Expected "field" to be 43');
  });
});

describe('expectIncludes()', () => {
  it('passes when value is included', () => {
    expect(() => expectIncludes([1, 2, 3], 2, 'field')).not.toThrow();
  });

  it('throws when value is not included', () => {
    expect(() => expectIncludes([1, 2, 3], 4, 'field')).toThrow('to include 4');
  });
});
