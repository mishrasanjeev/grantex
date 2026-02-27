import { type ReactNode } from 'react';
import { cn } from '../../lib/cn';

interface CardProps {
  children: ReactNode;
  className?: string;
}

export function Card({ children, className }: CardProps) {
  return (
    <div className={cn('bg-gx-surface border border-gx-border rounded-lg p-6', className)}>
      {children}
    </div>
  );
}
