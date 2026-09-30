/**
 * Alerts on the Board deadline of recorded DPDP breaches.
 *
 * DPDP Rules 2025 r.7(2)(b) give the Data Fiduciary 72 hours from becoming
 * aware of a breach (or the extended period) to send the Board its detailed
 * report. For each breach whose detailed report is not recorded as sent, this
 * worker emits `dpdp.breach.board_report_due` once when the deadline is within
 * DPDP_BREACH_ALERT_LEAD_MINUTES (stage `approaching`) and once when it has
 * passed (stage `overdue`), each with a `grantex.dpdp.breach_deadline_alerted`
 * entry on the developer's audit chain. A deadline moved by an extension is
 * alerted afresh (routes/dpdp-breaches.ts clears the alert times).
 *
 * Runs only with DPDP_BREACH_DEADLINE_ALERTS_ENABLED=true (index.ts). A run
 * takes developers one at a time, each in its own transaction, rows claimed
 * with FOR UPDATE SKIP LOCKED so several instances never alert twice. A
 * failed developer is logged and retried next interval; it never throws into
 * the service. Grantex files nothing with the Board.
 */
import type postgres from 'postgres';
import { config } from '../config.js';
import type { TxSql } from '../db/client.js';
import { appendPlatformAuditEntries, lockAuditChain } from '../lib/audit-chain.js';
import { emitEvent } from '../lib/events.js';
import { logger, type AppLogger } from '../lib/logger.js';
import { BREACH_AUDIT_ACTIONS } from '../routes/dpdp-breaches.js';

type Sql = ReturnType<typeof postgres>;

const ALERT_INTERVAL_MS = 5 * 60_000;
export const ALERT_BATCH_SIZE = 100;
export const ALERT_MAX_DEVELOPERS = 100;

export interface BreachAlertRunResult {
  alerted: number;
  failedDevelopers: number;
}

let timer: NodeJS.Timeout | null = null;

interface Alert { breachId: string; stage: 'approaching' | 'overdue'; dueAt: string }

async function alertForDeveloper(sql: Sql, developerId: string, leadMinutes: number, batchSize: number): Promise<Alert[]> {
  const alerts: Alert[] = [];
  await sql.begin(async (_tx) => {
    const tx = _tx as unknown as TxSql;
    const rows = await tx`
      SELECT id, board_report_due_at, board_report_due_at <= NOW() AS overdue
      FROM dpdp_breaches
      WHERE developer_id = ${developerId}
        AND status IN ('open', 'initial_intimated')
        AND board_detailed_report_sent_at IS NULL
        AND (
          (overdue_alert_sent_at IS NULL AND board_report_due_at <= NOW())
          OR (due_alert_sent_at IS NULL AND board_report_due_at - make_interval(mins => ${leadMinutes}) <= NOW())
        )
      ORDER BY board_report_due_at, id
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    `;
    if (rows.length === 0) return;
    for (const row of rows) {
      const overdue = row['overdue'] === true;
      const id = row['id'] as string;
      // An overdue alert also stands for the approaching one it replaces.
      if (overdue) {
        await tx`UPDATE dpdp_breaches
                 SET overdue_alert_sent_at = NOW(), due_alert_sent_at = COALESCE(due_alert_sent_at, NOW())
                 WHERE id = ${id}`;
      } else {
        await tx`UPDATE dpdp_breaches SET due_alert_sent_at = NOW() WHERE id = ${id}`;
      }
      alerts.push({
        breachId: id,
        stage: overdue ? 'overdue' : 'approaching',
        dueAt: new Date(row['board_report_due_at'] as string).toISOString(),
      });
    }
    const head = await lockAuditChain(tx, developerId);
    await appendPlatformAuditEntries(tx, developerId, head, alerts.map((alert) => ({
      action: BREACH_AUDIT_ACTIONS.deadlineAlerted,
      metadata: { breach_id: alert.breachId, stage: alert.stage, board_report_due_at: alert.dueAt },
    })));
  });
  return alerts;
}

/** One pass over the breaches whose Board deadline needs an alert. */
export async function runBreachDeadlineAlertsOnce(
  sql: Sql,
  log: AppLogger = logger,
  options: { leadMinutes?: number; batchSize?: number; maxDevelopers?: number } = {},
): Promise<BreachAlertRunResult> {
  const leadMinutes = options.leadMinutes ?? config.dpdpBreachAlertLeadMinutes;
  const batchSize = options.batchSize ?? ALERT_BATCH_SIZE;
  const maxDevelopers = options.maxDevelopers ?? ALERT_MAX_DEVELOPERS;
  const result: BreachAlertRunResult = { alerted: 0, failedDevelopers: 0 };

  let developers: string[];
  try {
    const due = await sql<{ developer_id: string }[]>`
      SELECT DISTINCT developer_id FROM dpdp_breaches
      WHERE status IN ('open', 'initial_intimated')
        AND board_detailed_report_sent_at IS NULL
        AND (
          (overdue_alert_sent_at IS NULL AND board_report_due_at <= NOW())
          OR (due_alert_sent_at IS NULL AND board_report_due_at - make_interval(mins => ${leadMinutes}) <= NOW())
        )
      LIMIT ${maxDevelopers}
    `;
    developers = due.map((row) => row.developer_id).sort();
  } catch (err) {
    log.error({ err }, 'DPDP breach deadline alerts could not list due breaches; they run again next interval');
    return result;
  }

  for (const developerId of developers) {
    try {
      const alerts = await alertForDeveloper(sql, developerId, leadMinutes, batchSize);
      result.alerted += alerts.length;
      for (const alert of alerts) {
        emitEvent(developerId, 'dpdp.breach.board_report_due', {
          breachId: alert.breachId,
          stage: alert.stage,
          overdue: alert.stage === 'overdue',
          boardDetailedReportDueAt: alert.dueAt,
        }).catch(() => {});
      }
    } catch (err) {
      result.failedDevelopers += 1;
      log.error({ err, developerId }, 'DPDP breach deadline alerts failed for a developer; they run again next interval');
    }
  }
  if (result.alerted > 0) log.info({ ...result }, 'alerted on DPDP breach Board report deadlines');
  return result;
}

/** Starts the worker when DPDP_BREACH_DEADLINE_ALERTS_ENABLED=true; returns whether it did. */
export function startDpdpBreachDeadlineWorker(
  sql: Sql,
  log: AppLogger = logger,
  intervalMs: number = ALERT_INTERVAL_MS,
): boolean {
  if (!config.dpdpBreachDeadlineAlertsEnabled || timer) return false;
  // Read once here, so a malformed lead time fails the start, not every run.
  const leadMinutes = config.dpdpBreachAlertLeadMinutes;
  timer = setInterval(() => void runBreachDeadlineAlertsOnce(sql, log, { leadMinutes }), intervalMs);
  timer.unref?.();
  return true;
}

export function stopDpdpBreachDeadlineWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
