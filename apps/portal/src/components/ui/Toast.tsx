import { useToast, type ToastType } from '../../store/toast';
import { cn } from '../../lib/cn';

const typeStyles: Record<ToastType, string> = {
  success: 'border-gx-accent/50 bg-gx-accent/10',
  error: 'border-gx-danger/50 bg-gx-danger/10',
  info: 'border-gx-accent2/50 bg-gx-accent2/10',
};

export function ToastContainer() {
  const { toasts, dismiss } = useToast();

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={cn(
            'px-4 py-3 rounded-lg border text-sm text-gx-text shadow-lg max-w-sm animate-[slideIn_0.2s_ease-out]',
            typeStyles[toast.type],
          )}
        >
          <div className="flex items-center justify-between gap-3">
            <span>{toast.message}</span>
            <button
              onClick={() => dismiss(toast.id)}
              className="text-gx-muted hover:text-gx-text transition-colors shrink-0"
            >
              &times;
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
