import { useState, useCallback } from 'react';
import { cn } from '../../lib/cn';

interface CopyButtonProps {
  text: string;
  className?: string;
}

export function CopyButton({ text, className }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [text]);

  return (
    <button
      onClick={copy}
      className={cn(
        'inline-flex items-center gap-1 px-2 py-1 text-xs font-mono rounded border transition-colors',
        copied
          ? 'border-gx-accent text-gx-accent'
          : 'border-gx-border text-gx-muted hover:text-gx-text hover:border-gx-muted',
        className,
      )}
    >
      {copied ? 'Copied!' : 'Copy'}
    </button>
  );
}
