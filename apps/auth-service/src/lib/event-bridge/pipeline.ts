/**
 * What happens to a delivery once its signature and claims have verified:
 * claim the receipt (replay store), act on the events, finalise the receipt.
 */
import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import type { AppLogger } from '../logger.js';
import { EventVerificationError } from './errors.js';
import { eventBridgeEventsDuplicateTotal, eventBridgeEventsUnmappedTotal } from './metrics.js';
import type { EventSourceKind, NormalizedEvent } from './normalize.js';
import { claimReceipt, finaliseReceipt, type EventProcessor, type ProcessOutcome } from './receipts.js';

type Sql = ReturnType<typeof postgres>;

/** The default processor: nothing is mapped, so every verified event is logged, counted and ignored. */
export function unmappedProcessor(log: AppLogger): EventProcessor {
  return async (events: NormalizedEvent[]): Promise<ProcessOutcome> => {
    for (const event of events) {
      log.info(
        { event_bridge: 'unmapped', sourceId: event.sourceId, eventId: event.eventId, eventType: event.type },
        'event bridge event matched no mapping rule and was ignored',
      );
    }
    return { status: 'unmapped', result: { events: events.map((event) => ({ type: event.type, outcome: 'unmapped' })) } };
  };
}

export interface HandleVerifiedInput {
  sourceKind: EventSourceKind;
  sourceId: string;
  developerId: string;
  eventId: string;
  body: Buffer | string;
  events: NormalizedEvent[];
}

export type HandleVerifiedResult =
  | { status: 'duplicate' }
  | ProcessOutcome;

export async function handleVerifiedDelivery(
  sql: Sql,
  input: HandleVerifiedInput,
  processor: EventProcessor,
): Promise<HandleVerifiedResult> {
  const bodySha256 = createHash('sha256').update(input.body).digest('hex');
  const claim = await claimReceipt(sql, {
    sourceId: input.sourceId,
    eventId: input.eventId,
    developerId: input.developerId,
    bodySha256,
    eventTypes: [...new Set(input.events.map((event) => event.type))],
  });
  if (claim === 'conflict') {
    throw new EventVerificationError('event_id_reused', 'event id was already used for a different payload');
  }
  if (claim === 'duplicate') {
    eventBridgeEventsDuplicateTotal.inc({ source_type: input.sourceKind });
    return { status: 'duplicate' };
  }

  let outcome: ProcessOutcome;
  try {
    outcome = await processor(input.events);
  } catch (err) {
    // Leave a failed receipt so a retransmission is processed again; the
    // error propagates and the sender sees a 5xx.
    await finaliseReceipt(sql, input.sourceId, input.eventId, 'failed', {
      error: err instanceof Error ? err.name : 'Error',
    }).catch(() => { /* the original error is the one to report */ });
    throw err;
  }
  await finaliseReceipt(sql, input.sourceId, input.eventId, outcome.status, outcome.result);
  if (outcome.status === 'unmapped') {
    eventBridgeEventsUnmappedTotal.inc({ source_type: input.sourceKind });
  }
  return outcome;
}
