import { cn } from '../../lib/cn';

interface ScopePillsProps {
  scopes: string[];
  className?: string;
}

export function ScopePills({ scopes, className }: ScopePillsProps) {
  return (
    <div className={cn('flex flex-wrap gap-1.5', className)}>
      {scopes.map((scope) => (
        <span
          key={scope}
          className="inline-flex items-center px-2 py-0.5 rounded text-xs font-mono bg-gx-accent2/10 text-gx-accent2"
        >
          {scope}
        </span>
      ))}
    </div>
  );
}
