/**
 * Why an event bridge delivery was rejected. A fixed, low-cardinality set:
 * each value is a metric label and the `err` code in the 401 response.
 */
export const EVENT_VERIFICATION_REASONS = [
  // Source lookup
  'source_unknown',
  'source_disabled',
  'unsupported_media_type',
  // Security Event Tokens (RFC 8417)
  'malformed',
  'unsupported_typ',
  'unsupported_alg',
  'key_unavailable',
  'signature_invalid',
  'issuer_mismatch',
  'audience_mismatch',
  'iat_missing',
  'iat_in_future',
  'stale',
  'expired',
  'jti_missing',
  'events_missing',
  // Generic signed webhooks
  'timestamp_missing',
  'timestamp_invalid',
  'timestamp_out_of_window',
  'signature_missing',
  'secret_unavailable',
  // Replay store
  'event_id_reused',
] as const;

export type EventVerificationReason = (typeof EVENT_VERIFICATION_REASONS)[number];

export class EventVerificationError extends Error {
  readonly reason: EventVerificationReason;

  constructor(reason: EventVerificationReason, message: string) {
    super(message);
    this.name = 'EventVerificationError';
    this.reason = reason;
  }
}
