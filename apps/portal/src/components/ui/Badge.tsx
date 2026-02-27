import { type ReactNode } from 'react';
import { cn } from '../../lib/cn';

type Variant = 'default' | 'success' | 'warning' | 'danger';

interface BadgeProps {
  children: ReactNode;
  variant?: Variant;
}

const variants: Record<Variant, string> = {
  default: 'bg-gx-border/50 text-gx-muted',
  success: 'bg-gx-accent/15 text-gx-accent',
  warning: 'bg-gx-warning/15 text-gx-warning',
  danger: 'bg-gx-danger/15 text-gx-danger',
};

export function Badge({ children, variant = 'default' }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center px-2 py-0.5 rounded text-xs font-medium font-mono',
        variants[variant],
      )}
    >
      {children}
    </span>
  );
}
