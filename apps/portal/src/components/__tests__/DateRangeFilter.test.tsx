import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DateRangeFilter, filterByDays } from '../ui/DateRangeFilter';

describe('DateRangeFilter', () => {
  it('renders all preset buttons', () => {
    render(<DateRangeFilter activeDays={7} onChange={vi.fn()} />);
    expect(screen.getByText('24h')).toBeInTheDocument();
    expect(screen.getByText('7d')).toBeInTheDocument();
    expect(screen.getByText('30d')).toBeInTheDocument();
    expect(screen.getByText('90d')).toBeInTheDocument();
    expect(screen.getByText('All')).toBeInTheDocument();
  });

  it('highlights the active preset', () => {
    render(<DateRangeFilter activeDays={7} onChange={vi.fn()} />);
    expect(screen.getByText('7d').className).toContain('text-gx-accent');
  });

  it('calls onChange with correct days on click', () => {
    const onChange = vi.fn();
    render(<DateRangeFilter activeDays={7} onChange={onChange} />);
    fireEvent.click(screen.getByText('30d'));
    expect(onChange).toHaveBeenCalledWith(30);
  });

  it('calls onChange with 0 for All', () => {
    const onChange = vi.fn();
    render(<DateRangeFilter activeDays={7} onChange={onChange} />);
    fireEvent.click(screen.getByText('All'));
    expect(onChange).toHaveBeenCalledWith(0);
  });
});

describe('filterByDays', () => {
  const items = [
    { ts: new Date(Date.now() - 1000).toISOString() },        // just now
    { ts: new Date(Date.now() - 2 * 86400000).toISOString() }, // 2 days ago
    { ts: new Date(Date.now() - 10 * 86400000).toISOString() }, // 10 days ago
  ];

  it('returns all items when days=0', () => {
    expect(filterByDays(items, 0, i => i.ts)).toHaveLength(3);
  });

  it('filters items within 1 day', () => {
    expect(filterByDays(items, 1, i => i.ts)).toHaveLength(1);
  });

  it('filters items within 7 days', () => {
    expect(filterByDays(items, 7, i => i.ts)).toHaveLength(2);
  });

  it('filters items within 30 days', () => {
    expect(filterByDays(items, 30, i => i.ts)).toHaveLength(3);
  });
});
