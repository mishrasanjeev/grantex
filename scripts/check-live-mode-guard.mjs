#!/usr/bin/env node
/**
 * P0-23 — hard gate for the central Commerce live-mode guard.
 *
 * Verifies two invariants and exits 1 on any violation, so that the
 * release-preflight job (and any future CI integration) fails the
 * pipeline when a payment-touching route forgets to call the guard:
 *
 *   1. apps/auth-service/src/lib/commerce/live-mode-guard.ts exists
 *      and exports ensureCommerceLiveMode.
 *   2. Every file in PAYMENT_TOUCHING_ROUTES below
 *      - imports from '../lib/commerce/live-mode-guard.js', and
 *      - actually calls ensureCommerceLiveMode(...).
 *
 * Read-only / admin / setup routes are deliberately NOT in the inventory
 * to avoid false positives. Adding a new payment-touching route requires
 * a one-line addition here AND to
 * apps/auth-service/tests/commerce-live-mode-guard.test.ts — the test
 * mirrors this list so an in-package regression is caught even when the
 * release pipeline does not run.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = process.cwd();
const here = dirname(fileURLToPath(import.meta.url));

const GUARD_PATH = join(
  repoRoot,
  'apps',
  'auth-service',
  'src',
  'lib',
  'commerce',
  'live-mode-guard.ts',
);

// Files that handle inbound requests which can create or advance live
// payment-provider state. Read-only/admin/setup routes are excluded.
const PAYMENT_TOUCHING_ROUTES = [
  'apps/auth-service/src/routes/commerce-cart-payment.ts',
  'apps/auth-service/src/routes/commerce-provider-credentials.ts',
  'apps/auth-service/src/routes/commerce-provider-webhooks.ts',
];

const REQUIRED_IMPORT_RE = /from\s+['"]\.\.\/lib\/commerce\/live-mode-guard\.js['"]/;
const REQUIRED_CALL_RE = /ensureCommerceLiveMode\s*\(/;

let failed = false;
function fail(msg) {
  failed = true;
  console.error(`[live-mode-guard] ${msg}`);
}

// 1. Guard module must exist and export the expected symbol.
if (!existsSync(GUARD_PATH)) {
  fail(`expected guard module at ${GUARD_PATH} — module is missing.`);
} else {
  const guardSrc = readFileSync(GUARD_PATH, 'utf-8');
  if (!/export\s+function\s+ensureCommerceLiveMode\b/.test(guardSrc)) {
    fail(`${GUARD_PATH} does not export ensureCommerceLiveMode.`);
  } else {
    console.log(`[live-mode-guard] guard module OK: ${GUARD_PATH}`);
  }
}

// 2. Every payment-touching route must import the guard AND call it.
for (const rel of PAYMENT_TOUCHING_ROUTES) {
  const abs = join(repoRoot, rel);
  if (!existsSync(abs)) {
    fail(`inventory references ${rel} but the file does not exist; ` +
      `either remove the entry from PAYMENT_TOUCHING_ROUTES or restore the file.`);
    continue;
  }
  const src = readFileSync(abs, 'utf-8');
  const hasImport = REQUIRED_IMPORT_RE.test(src);
  const hasCall = REQUIRED_CALL_RE.test(src);
  if (!hasImport) {
    fail(`${rel} does not import ensureCommerceLiveMode from ` +
      `'../lib/commerce/live-mode-guard.js'.`);
  }
  if (!hasCall) {
    fail(`${rel} does not call ensureCommerceLiveMode(...). ` +
      `Every handler that can create or advance live payment-provider state ` +
      `must call the central guard before any side effect.`);
  }
  if (hasImport && hasCall) {
    console.log(`[live-mode-guard] ${rel} OK`);
  }
}

if (failed) {
  console.error('');
  console.error('[live-mode-guard] FAIL — release blocked until the gaps above are closed.');
  console.error(
    '[live-mode-guard] Reference: docs/reports/' +
      'enterprise-readiness-brutal-review-2026-05-24.md item P0-23.',
  );
  process.exit(1);
}
console.log('[live-mode-guard] PASS — all payment-touching routes reference the central guard.');
// Touch `here` so a no-op import does not get pruned by linters.
void here;
