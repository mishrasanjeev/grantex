import { describe, it, expect, vi, afterEach } from 'vitest';
import { printTable, printRecord, shortDate } from '../src/format.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('printTable', () => {
  it('prints "(no results)" when rows array is empty', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    printTable([], ['ID', 'NAME']);
    expect(spy).toHaveBeenCalledWith('(no results)');
  });

  it('prints header and one data row', () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => {
      lines.push(args.join(' '));
    });

    printTable([{ ID: 'ag_1', NAME: 'my-agent' }], ['ID', 'NAME']);

    // First line is the header (uppercased already)
    expect(lines[0]).toContain('ID');
    expect(lines[0]).toContain('NAME');
    // Third line is the data row
    expect(lines[2]).toContain('ag_1');
    expect(lines[2]).toContain('my-agent');
  });

  it('pads columns to align widths', () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => {
      lines.push(args.join(' '));
    });

    printTable(
      [
        { ID: 'short', VAL: 'x' },
        { ID: 'a-much-longer-id', VAL: 'y' },
      ],
      ['ID', 'VAL'],
    );

    // All lines should have the same length (padded to the widest value)
    const [header, , row1, row2] = lines;
    expect(header?.length).toBe(row1?.length);
    expect(row1?.length).toBe(row2?.length);
  });
});

describe('printRecord', () => {
  it('prints each key-value pair', () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => {
      lines.push(args.join(' '));
    });

    printRecord({ id: 'ag_01', name: 'test-agent' });

    expect(lines.some((l) => l.includes('ag_01'))).toBe(true);
    expect(lines.some((l) => l.includes('test-agent'))).toBe(true);
  });
});

describe('shortDate', () => {
  it('returns a non-empty string for a valid ISO date', () => {
    const result = shortDate('2024-06-15T10:30:00.000Z');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('includes the year from the ISO date', () => {
    const result = shortDate('2024-06-15T10:30:00.000Z');
    expect(result).toContain('2024');
  });
});
