import { type ReactNode } from 'react';
import { cn } from '../../lib/cn';

export type BadgeVariant = 'default' | 'success' | 'warning' | 'danger' | 'info';
type Variant = BadgeVariant;

interface BadgeProps {
  children: ReactNode;
  variant?: Variant;
}

const variants: Record<Variant, string> = {
  default: 'bg-gx-border/50 text-gx-muted',
  success: 'bg-gx-accent/15 text-gx-accent',
  warning: 'bg-gx-warning/15 text-gx-warning',
  danger: 'bg-gx-danger/15 text-gx-danger',
  info: 'bg-gx-accent2/15 text-gx-accent2',
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
