// SPDX-License-Identifier: Apache-2.0
//
// The issuer's own passport status lists, in memory: numbered lists of
// 131,072 entries each, with indices drawn at random. The published lists
// (Token Status List and Bitstring Status List) are both built from this
// store, never one from the other.

import { randomInt } from 'node:crypto';
import { MockIssuerError } from './errors.ts';
import { BITSTRING_MIN_ENTRIES, TOKEN_STATUS, type StatusEntry } from './status-list-codec.ts';

/**
 * Entries per list: the Bitstring Status List v1.0 section 3.2 minimum, a
 * multiple of 8 so both byte arrays end on a byte boundary.
 */
export const STATUS_LIST_CAPACITY = BITSTRING_MIN_ENTRIES;

/**
 * New entries are drawn from a list until it is three quarters allocated;
 * past that a random draw lands on a used index too often and the next list
 * takes over. At the ceiling a draw succeeds with probability 1/4, so 64
 * attempts all fail with probability below 1e-7. The registry's acceptance
 * lists use the same rule.
 */
const ALLOCATION_ATTEMPTS = 64;

export interface StatusSlot {
  /** The list number, 1 for the first list: the list is published at /status/<list>. */
  list: number;
  idx: number;
}

export interface SerializedStatusList {
  list: number;
  capacity: number;
  /** Every allocated entry as [idx, status]. */
  entries: Array<[number, number]>;
}

interface StatusList {
  capacity: number;
  entries: Map<number, number>;
}

function checkCapacity(capacity: number): number {
  if (!Number.isInteger(capacity) || capacity < STATUS_LIST_CAPACITY || capacity % 8 !== 0) {
    throw new MockIssuerError(
      'invalid_request',
      `a status list holds a multiple of 8 and at least ${STATUS_LIST_CAPACITY} entries, not ${capacity}`,
    );
  }
  return capacity;
}

function checkStatus(status: number): void {
  if (status !== TOKEN_STATUS.VALID && status !== TOKEN_STATUS.INVALID && status !== TOKEN_STATUS.SUSPENDED) {
    throw new MockIssuerError('invalid_request', `unknown status ${status}`);
  }
}

export class PassportStatusStore {
  readonly capacity: number;
  readonly #lists = new Map<number, StatusList>();

  constructor(options: { capacity?: number; lists?: readonly SerializedStatusList[] } = {}) {
    this.capacity = checkCapacity(options.capacity ?? STATUS_LIST_CAPACITY);
    for (const serialized of options.lists ?? []) {
      const capacity = checkCapacity(serialized.capacity);
      if (!Number.isInteger(serialized.list) || serialized.list < 1 || this.#lists.has(serialized.list)) {
        throw new MockIssuerError('state_unreadable', `status list number ${serialized.list} is not valid`);
      }
      const entries = new Map<number, number>();
      for (const [idx, status] of serialized.entries) {
        // A stored entry the store would never have written: refuse the state
        // rather than publish a list that says something nobody decided.
        if (!Number.isInteger(idx) || idx < 0 || idx >= capacity || entries.has(idx)) {
          throw new MockIssuerError('state_unreadable', `status list ${serialized.list} has an invalid entry`);
        }
        checkStatus(status);
        entries.set(idx, status);
      }
      this.#lists.set(serialized.list, { capacity, entries });
    }
  }

  /** The list numbers in use, ascending. */
  listNumbers(): number[] {
    return [...this.#lists.keys()].sort((a, b) => a - b);
  }

  hasList(list: number): boolean {
    return this.#lists.has(list);
  }

  /**
   * Allocate a new VALID entry. The index is drawn with crypto.randomInt
   * (Bitstring Status List v1.0 section 2.1: indexes SHOULD be assigned
   * randomly, so the index says nothing about when or how many; section 6.5
   * gives the privacy reasoning); a draw
   * that lands on a used index draws again.
   */
  allocate(): StatusSlot {
    let number = this.listNumbers().at(-1);
    let list = number === undefined ? undefined : this.#lists.get(number);
    if (number === undefined || list === undefined || list.entries.size * 4 >= list.capacity * 3) {
      number = (number ?? 0) + 1;
      list = { capacity: this.capacity, entries: new Map() };
      this.#lists.set(number, list);
    }
    for (let attempt = 0; attempt < ALLOCATION_ATTEMPTS; attempt += 1) {
      const idx = randomInt(list.capacity);
      if (!list.entries.has(idx)) {
        list.entries.set(idx, TOKEN_STATUS.VALID);
        return { list: number, idx };
      }
    }
    throw new MockIssuerError('allocation_exhausted', `no free index in list ${number} after ${ALLOCATION_ATTEMPTS} draws`);
  }

  /** Give back an entry allocated for an issuance that then failed. */
  release(slot: StatusSlot): void {
    this.#lists.get(slot.list)?.entries.delete(slot.idx);
  }

  /** The status of an allocated entry. Throws for an entry never allocated. */
  get(slot: StatusSlot): number {
    const status = this.#lists.get(slot.list)?.entries.get(slot.idx);
    if (status === undefined) {
      throw new MockIssuerError('attestation_not_registered', `entry ${slot.idx} of list ${slot.list} was never allocated`);
    }
    return status;
  }

  set(slot: StatusSlot, status: number): void {
    checkStatus(status);
    this.get(slot);
    this.#lists.get(slot.list)!.entries.set(slot.idx, status);
  }

  /** Capacity and every entry that is not VALID, to encode a published list. */
  snapshot(list: number): { capacity: number; entries: StatusEntry[] } {
    const stored = this.#lists.get(list);
    if (stored === undefined) throw new MockIssuerError('status_list_not_found', `status list ${list} does not exist`);
    const entries: StatusEntry[] = [];
    for (const [idx, status] of stored.entries) if (status !== TOKEN_STATUS.VALID) entries.push({ idx, status });
    return { capacity: stored.capacity, entries };
  }

  toJSON(): SerializedStatusList[] {
    return this.listNumbers().map((list) => {
      const stored = this.#lists.get(list)!;
      return { list, capacity: stored.capacity, entries: [...stored.entries] };
    });
  }
}
