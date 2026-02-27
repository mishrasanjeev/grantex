import { type InputHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string;
}

export function Input({ label, hint, error, className, id, ...props }: InputProps) {
  return (
    <div>
      {label && (
        <label htmlFor={id} className="block text-sm font-medium text-gx-text mb-1.5">
          {label}
          {hint && <span className="text-gx-muted font-normal"> ({hint})</span>}
        </label>
      )}
      <input
        id={id}
        className={cn(
          'w-full px-3 py-2 bg-gx-bg border rounded-md text-sm text-gx-text placeholder-gx-muted/50 focus:outline-none transition-colors',
          error ? 'border-gx-danger focus:border-gx-danger' : 'border-gx-border focus:border-gx-accent',
          className,
        )}
        {...props}
      />
      {error && <p className="mt-1 text-xs text-gx-danger">{error}</p>}
    </div>
  );
}
