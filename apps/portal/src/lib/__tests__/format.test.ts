import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatDate, formatDateTime, truncateId, timeAgo } from '../format';

describe('formatDate', () => {
  it('formats ISO date string', () => {
    const result = formatDate('2024-06-15T12:00:00Z');
    expect(result).toContain('Jun');
    expect(result).toContain('15');
    expect(result).toContain('2024');
  });
});

describe('formatDateTime', () => {
  it('includes time in output', () => {
    const result = formatDateTime('2024-06-15T14:30:00Z');
    expect(result).toContain('Jun');
    expect(result).toContain('15');
    expect(result).toContain('2024');
  });
});

describe('truncateId', () => {
  it('truncates long IDs', () => {
    expect(truncateId('abcdefghijklmnop')).toBe('abcdefghijkl...');
  });

  it('does not truncate short IDs', () => {
    expect(truncateId('short')).toBe('short');
  });

  it('uses custom length', () => {
    expect(truncateId('abcdefghij', 5)).toBe('abcde...');
  });

  it('returns exact length strings unchanged', () => {
    expect(truncateId('123456789012', 12)).toBe('123456789012');
  });
});

describe('timeAgo', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('returns "just now" for recent times', () => {
    expect(timeAgo(new Date().toISOString())).toBe('just now');
  });

  it('returns minutes ago', () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60000).toISOString();
    expect(timeAgo(fiveMinAgo)).toBe('5m ago');
  });

  it('returns hours ago', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3600000).toISOString();
    expect(timeAgo(twoHoursAgo)).toBe('2h ago');
  });

  it('returns days ago', () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString();
    expect(timeAgo(threeDaysAgo)).toBe('3d ago');
  });
});
