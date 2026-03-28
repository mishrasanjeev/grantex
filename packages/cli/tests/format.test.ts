import { describe, it, expect, vi, afterEach } from 'vitest';
import { printTable, printRecord, shortDate, tableToString, setJsonMode, isJsonMode } from '../src/format.js';

afterEach(() => {
  vi.restoreAllMocks();
  setJsonMode(false);
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

  it('outputs JSON when jsonMode is true', () => {
    setJsonMode(true);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const displayRows = [{ ID: 'ag_1', NAME: 'Bot' }];
    const rawRows = [{ id: 'ag_1', name: 'Bot', extra: 42 }];
    printTable(displayRows, ['ID', 'NAME'], rawRows);
    const output = spy.mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(parsed[0].id).toBe('ag_1');
    expect(parsed[0].extra).toBe(42);
  });

  it('outputs displayRows as JSON when rawRows not provided in json mode', () => {
    setJsonMode(true);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const displayRows = [{ ID: 'ag_1', NAME: 'Bot' }];
    printTable(displayRows, ['ID', 'NAME']);
    const output = spy.mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(parsed[0].ID).toBe('ag_1');
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

  it('outputs JSON when jsonMode is true', () => {
    setJsonMode(true);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    printRecord({ id: 'ag_01', name: 'test-agent' });
    const output = spy.mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(parsed.id).toBe('ag_01');
  });

  it('outputs raw record as JSON when provided in json mode', () => {
    setJsonMode(true);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    printRecord({ id: 'ag_01' }, { id: 'ag_01', extra: true });
    const output = spy.mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(parsed.extra).toBe(true);
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

describe('tableToString', () => {
  it('returns "(no results)" for empty rows', () => {
    const result = tableToString([], ['ID', 'NAME']);
    expect(result).toBe('(no results)');
  });

  it('returns formatted table string with header, divider, and data', () => {
    const rows = [
      { ID: 'ag_1', NAME: 'Bot' },
      { ID: 'ag_2', NAME: 'Agent' },
    ];
    const result = tableToString(rows, ['ID', 'NAME']);
    const lines = result.split('\n');

    // Header line
    expect(lines[0]).toContain('ID');
    expect(lines[0]).toContain('NAME');
    // Divider line
    expect(lines[1]).toMatch(/^-+\s+-+$/);
    // Data rows
    expect(lines[2]).toContain('ag_1');
    expect(lines[2]).toContain('Bot');
    expect(lines[3]).toContain('ag_2');
    expect(lines[3]).toContain('Agent');
  });

  it('pads columns to the widest value', () => {
    const rows = [
      { ID: 'short', VAL: 'x' },
      { ID: 'a-much-longer-id', VAL: 'y' },
    ];
    const result = tableToString(rows, ['ID', 'VAL']);
    const lines = result.split('\n');

    // All lines should have the same length
    expect(lines[0]?.length).toBe(lines[2]?.length);
    expect(lines[2]?.length).toBe(lines[3]?.length);
  });
});

describe('setJsonMode / isJsonMode', () => {
  it('defaults to false', () => {
    setJsonMode(false);
    expect(isJsonMode()).toBe(false);
  });

  it('can be set to true', () => {
    setJsonMode(true);
    expect(isJsonMode()).toBe(true);
  });

  it('can be toggled back to false', () => {
    setJsonMode(true);
    expect(isJsonMode()).toBe(true);
    setJsonMode(false);
    expect(isJsonMode()).toBe(false);
  });
});
