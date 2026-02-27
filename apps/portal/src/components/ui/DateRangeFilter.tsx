import { cn } from '../../lib/cn';

const presets = [
  { label: '24h', days: 1 },
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: 'All', days: 0 },
] as const;

interface DateRangeFilterProps {
  activeDays: number;
  onChange: (days: number) => void;
  className?: string;
}

export function DateRangeFilter({ activeDays, onChange, className }: DateRangeFilterProps) {
  return (
    <div className={cn('flex items-center gap-1', className)}>
      {presets.map((p) => (
        <button
          key={p.label}
          onClick={() => onChange(p.days)}
          className={cn(
            'px-2.5 py-1 rounded text-xs font-medium transition-colors',
            activeDays === p.days
              ? 'bg-gx-accent/15 text-gx-accent'
              : 'text-gx-muted hover:text-gx-text hover:bg-gx-bg',
          )}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}

export function filterByDays<T>(items: T[], days: number, getTime: (item: T) => string): T[] {
  if (days === 0) return items;
  const cutoff = Date.now() - days * 86_400_000;
  return items.filter((item) => new Date(getTime(item)).getTime() >= cutoff);
}
