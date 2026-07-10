import { useId, type InputHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string;
}

export function Input({ label, hint, error, className, id, ...props }: InputProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const errorId = `${inputId}-error`;
  const describedBy = error
    ? [props['aria-describedby'], errorId].filter(Boolean).join(' ')
    : props['aria-describedby'];

  return (
    <div>
      {label && (
        <label htmlFor={inputId} className="block text-sm font-medium text-gx-text mb-1.5">
          {label}
          {hint && <span className="text-gx-muted font-normal"> ({hint})</span>}
        </label>
      )}
      <input
        {...props}
        id={inputId}
        aria-describedby={describedBy || undefined}
        aria-invalid={error ? true : props['aria-invalid']}
        className={cn(
          'w-full px-3 py-2 bg-gx-bg border rounded-md text-sm text-gx-text placeholder-gx-muted/50 focus:outline-none transition-colors',
          error ? 'border-gx-danger focus:border-gx-danger' : 'border-gx-border focus:border-gx-accent',
          className,
        )}
      />
      {error && <p id={errorId} className="mt-1 text-xs text-gx-danger">{error}</p>}
    </div>
  );
}
