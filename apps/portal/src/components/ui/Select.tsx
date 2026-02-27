import { type SelectHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  options: { value: string; label: string }[];
}

export function Select({ label, options, className, id, ...props }: SelectProps) {
  return (
    <div>
      {label && (
        <label htmlFor={id} className="block text-sm font-medium text-gx-text mb-1.5">
          {label}
        </label>
      )}
      <select
        id={id}
        className={cn(
          'w-full px-3 py-2 bg-gx-bg border border-gx-border rounded-md text-sm text-gx-text focus:outline-none focus:border-gx-accent transition-colors',
          className,
        )}
        {...props}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}
