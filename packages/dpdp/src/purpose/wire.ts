/**
 * Mapping between the local purpose model and the wire shape `{ code, description }`.
 */

import type { ConsentPurpose, PurposeInput, WirePurpose } from '../types.js';

/** True for a wire purpose `{ code, description }`; false for the local `ConsentPurpose` model. */
export function isWirePurpose(p: PurposeInput): p is WirePurpose {
  return 'code' in p;
}

/**
 * The wire shape of a purpose: `{ code, description }`. A local `ConsentPurpose`
 * maps `purposeId` to `code`; its other fields are local-only and dropped.
 */
export function toWirePurpose(p: PurposeInput): WirePurpose {
  if (isWirePurpose(p)) return { code: p.code, description: p.description };
  return { code: (p as ConsentPurpose).purposeId, description: p.description };
}

/** Names of the fields the server requires that `p` is missing (`code`/`purposeId`, `description`). */
export function missingWireFields(p: PurposeInput): string[] {
  const missing: string[] = [];
  if (isWirePurpose(p)) {
    if (!p.code) missing.push('code');
  } else if (!p.purposeId) {
    missing.push('purposeId');
  }
  if (!p.description) missing.push('description');
  return missing;
}

/** A label for messages: the purpose's code or id. */
export function purposeLabel(p: PurposeInput): string {
  return (isWirePurpose(p) ? p.code : p.purposeId) || '?';
}
