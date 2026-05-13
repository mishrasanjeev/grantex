export type CommercePaymentStatus =
  | 'created'
  | 'authorized'
  | 'checkout_created'
  | 'payment_pending'
  | 'paid'
  | 'failed'
  | 'cancelled'
  | 'expired';

const ALLOWED_TRANSITIONS: Record<CommercePaymentStatus, CommercePaymentStatus[]> = {
  created: ['authorized', 'cancelled'],
  authorized: ['checkout_created', 'cancelled'],
  checkout_created: ['payment_pending', 'cancelled'],
  payment_pending: ['paid', 'failed', 'expired', 'cancelled'],
  paid: [],
  failed: [],
  cancelled: [],
  expired: [],
};

export function canTransitionPaymentStatus(
  from: CommercePaymentStatus,
  to: CommercePaymentStatus,
): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function assertPaymentStatusTransition(
  from: CommercePaymentStatus,
  to: CommercePaymentStatus,
): void {
  if (!canTransitionPaymentStatus(from, to)) {
    throw new Error(`Invalid payment status transition: ${from} -> ${to}`);
  }
}

export function allowedPaymentStatusTransitions(
  from: CommercePaymentStatus,
): CommercePaymentStatus[] {
  return [...ALLOWED_TRANSITIONS[from]];
}

