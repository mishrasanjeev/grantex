// SPDX-License-Identifier: Apache-2.0
/**
 * Runs status-list reconciliation with cascade
 * (lib/registry/status-reconciliation.ts) on a timer, while
 * REGISTRY_STATUS_RECONCILIATION_ENABLED=true. It takes over from
 * workers/registryIssuerStatusRecheck.ts, which index.ts starts only while
 * the flag is off.
 *
 * Each instance starts after a random delay of up to one minimum interval,
 * so the instances of one deploy do not all reach the database together,
 * then runs every reconciliationTickMs (a quarter of the minimum interval).
 * Only the instance holding the advisory lock does the work; the others
 * skip the run. A run does not start while this instance's previous one is
 * still going.
 */
import type postgres from 'postgres';
import { logger, type AppLogger } from '../lib/logger.js';
import {
  reconcileRegistryStatusOnce,
  reconciliationStartDelayMs,
  reconciliationTickMs,
  statusPollMinIntervalMs,
} from '../lib/registry/status-reconciliation.js';

type Sql = ReturnType<typeof postgres>;

export interface ReconciliationWorkerOptions {
  /** REGISTRY_STATUS_POLL_MIN_INTERVAL_MS by default. */
  minIntervalMs?: number;
  /** A random delay below one minimum interval by default. */
  startDelayMs?: number;
  random?: () => number;
}

let firstRun: NodeJS.Timeout | null = null;
let timer: NodeJS.Timeout | null = null;
let running = false;

export function startRegistryStatusReconciliationWorker(
  sql: Sql,
  log: AppLogger = logger,
  options: ReconciliationWorkerOptions = {},
): void {
  if (firstRun || timer) return;
  const minIntervalMs = options.minIntervalMs ?? statusPollMinIntervalMs();
  const tickMs = reconciliationTickMs(minIntervalMs);
  const run = () => {
    if (running) return;
    running = true;
    void reconcileRegistryStatusOnce(sql, log, { minIntervalMs }).finally(() => {
      running = false;
    });
  };
  const delay = options.startDelayMs ?? reconciliationStartDelayMs(minIntervalMs, options.random);
  firstRun = setTimeout(() => {
    firstRun = null;
    run();
    timer = setInterval(run, tickMs);
    timer.unref?.();
  }, delay);
  firstRun.unref?.();
}

export function stopRegistryStatusReconciliationWorker(): void {
  if (firstRun) clearTimeout(firstRun);
  if (timer) clearInterval(timer);
  firstRun = null;
  timer = null;
}
