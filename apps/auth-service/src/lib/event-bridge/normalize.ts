/**
 * The shape every verified delivery is reduced to before mapping rules see it.
 * SETs contribute one event per member of their `events` claim; a generic
 * webhook contributes exactly one.
 */
export type EventSourceKind = 'ssf' | 'webhook';

export interface NormalizedEvent {
  sourceId: string;
  sourceKind: EventSourceKind;
  developerId: string;
  /** Replay-store key: the SET `jti` or the webhook `id`. */
  eventId: string;
  /** Event type: the SET event URI or the webhook `type`. */
  type: string;
  /** Subject identifiers the transmitter asserts (SSF `sub_id`, webhook `subject`). */
  subject: Record<string, unknown>;
  /** The event payload (SET event member, webhook `data`). */
  data: Record<string, unknown>;
  /** When the transmitter says the event happened, if it says. */
  occurredAt: string | null;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const MAX_EVENT_ID_LENGTH = 256;
export const MAX_EVENT_TYPE_LENGTH = 512;
export const MAX_EVENTS_PER_SET = 20;
