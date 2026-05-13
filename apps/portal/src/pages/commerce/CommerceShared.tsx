import { type ReactNode } from 'react';
import { Badge } from '../../components/ui/Badge';
import { Card } from '../../components/ui/Card';
import { Spinner } from '../../components/ui/Spinner';
import { formatDateTime } from '../../lib/format';
import type { CommercePaymentStatus } from '../../api/commerce';

export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
      <div>
        <h1 className="text-xl font-semibold text-gx-text">{title}</h1>
        <p className="mt-1 max-w-3xl text-sm text-gx-muted">{description}</p>
      </div>
      {action}
    </div>
  );
}

export function BlockerBanner() {
  return (
    <div className="mb-4 rounded-md border border-gx-warning/40 bg-gx-warning/10 p-3 text-sm text-gx-text">
      <div className="font-medium text-gx-warning">Live payments and Plural remain blocked</div>
      <div className="mt-1 text-xs text-gx-muted">
        Sandbox mock flows are available. Real Plural and live payment mode require confirmed provider contracts plus legal, security, and operations approval.
      </div>
    </div>
  );
}

export function LoadingPanel() {
  return (
    <div className="flex items-center justify-center py-20">
      <Spinner className="h-8 w-8" />
    </div>
  );
}

export function ErrorPanel({ message }: { message: string }) {
  return (
    <Card>
      <div role="alert" className="text-sm text-gx-danger">{message}</div>
    </Card>
  );
}

export function IdText({ value }: { value: string | null | undefined }) {
  return (
    <span className="block max-w-[13rem] truncate font-mono text-xs text-gx-muted">
      {value || 'none'}
    </span>
  );
}

export function DateText({ value }: { value: string | null | undefined }) {
  return <span className="text-xs text-gx-muted">{value ? formatDateTime(value) : 'none'}</span>;
}

export function statusVariant(status: string): 'default' | 'success' | 'warning' | 'danger' {
  if (status === 'paid' || status === 'valid' || status === 'healthy') return 'success';
  if (status === 'payment_pending' || status === 'pending' || status === 'degraded') return 'warning';
  if (status === 'failed' || status === 'expired' || status === 'disabled' || status === 'down' || status === 'invalid') return 'danger';
  return 'default';
}

export function PaymentStatusBadge({ status }: { status: CommercePaymentStatus | string }) {
  return <Badge variant={statusVariant(status)}>{status}</Badge>;
}

export function money(amount: string | number | null | undefined, currency: string | null | undefined): string {
  const n = typeof amount === 'number' ? amount : Number.parseInt(String(amount ?? '0'), 10);
  const major = Number.isFinite(n) ? n / 100 : 0;
  return `${currency ?? 'INR'} ${major.toFixed(2)}`;
}
