/**
 * The DPDP breach register: personal data breaches a Data Fiduciary records
 * (DPDP Act 2023 s.8(6); DPDP Rules 2025 r.7).
 *
 * r.7 asks the fiduciary to intimate each affected Data Principal and the
 * Board "without delay", and to give the Board a detailed report within 72
 * hours of becoming aware of the breach (extendable on written request).
 * Grantex does neither on the fiduciary's behalf: it keeps the register,
 * computes the deadlines, records what the fiduciary says it sent, and emits
 * dpdp.breach.recorded, dpdp.breach.principal_intimation_due and (from
 * workers/dpdpBreachDeadlines.ts) dpdp.breach.board_report_due.
 *
 * Every change appends a platform entry to the developer's audit chain in
 * the same transaction. Audit metadata and events carry ids and counts, never
 * the affected principals' ids or the breach text.
 */
import type { FastifyInstance } from 'fastify';
import { getSql, type TxSql } from '../db/client.js';
import { newBreachId, newBreachIntimationId } from '../lib/ids.js';
import { emitEvent } from '../lib/events.js';
import {
  InputError,
  MAX_CODE,
  MAX_ID,
  MAX_LONG_TEXT,
  MAX_SHORT_TEXT,
  appendDpdpAudit,
  iso,
  isPlainObject,
  nextCursor,
  optionalString,
  parseOr400,
  parsePage,
  requireBody,
  requireDate,
  requireString,
  sendError,
} from './dpdp.js';

/** DPDP Rules 2025 r.7(2)(b): the detailed report is due within 72 hours of awareness. */
export const BOARD_REPORT_HOURS = 72;
const HOUR_MS = 3_600_000;
/** Clock skew tolerated on times the caller says are in the past. */
const FUTURE_SKEW_MS = 5 * 60_000;
const MAX_PRINCIPALS = 10_000;
/** Intimations listed on a breach read; the counts cover all of them. */
const INTIMATIONS_SHOWN = 200;

export const BREACH_STATUSES = ['open', 'initial_intimated', 'reported', 'closed'] as const;
type BreachStatus = (typeof BREACH_STATUSES)[number];
/** Each status is reached from exactly one other: open -> initial_intimated -> reported -> closed. */
const BREACH_TRANSITIONS: Record<Exclude<BreachStatus, 'open'>, BreachStatus> = {
  initial_intimated: 'open',
  reported: 'initial_intimated',
  closed: 'reported',
};

/**
 * What an intimation to a Data Principal may carry (DPDP Rules 2025
 * r.7(1)(a)-(e)): the description of the breach (nature, extent, timing and
 * location), its likely consequences for the principal, the mitigation
 * measures, the safety measures the principal can take, and business contact
 * information of a person able to respond on the fiduciary's behalf.
 */
export const INTIMATION_CONTENT = ['description', 'likely_consequences', 'mitigation', 'safety_measures', 'contact'] as const;
type IntimationContent = (typeof INTIMATION_CONTENT)[number];

const REPORT_FIELDS = {
  updatedDetails: 'report_updated_details',
  factsCircumstancesReasons: 'report_facts_circumstances_reasons',
  mitigation: 'report_mitigation',
  causeFindings: 'report_cause_findings',
  remedialMeasures: 'report_remedial_measures',
} as const;
type ReportField = keyof typeof REPORT_FIELDS;

export const BREACH_AUDIT_ACTIONS = {
  recorded: 'grantex.dpdp.breach_recorded',
  updated: 'grantex.dpdp.breach_updated',
  principalsIntimated: 'grantex.dpdp.breach_principals_intimated',
  deadlineAlerted: 'grantex.dpdp.breach_deadline_alerted',
} as const;

// ── Input ──────────────────────────────────────────────────────────────────

function requirePastDate(value: unknown, field: string, now: number): Date {
  const date = requireDate(value, field);
  if (date.getTime() > now + FUTURE_SKEW_MS) throw new InputError(`${field} must not be in the future`);
  return date;
}

function principalIds(value: unknown, field: string, options: { required: boolean }): string[] | undefined {
  if (value === undefined || value === null) {
    if (options.required) throw new InputError(`${field} must be a non-empty array of data principal ids`);
    return undefined;
  }
  if (!Array.isArray(value)) throw new InputError(`${field} must be an array of data principal ids`);
  if (options.required && value.length === 0) throw new InputError(`${field} must be a non-empty array of data principal ids`);
  if (value.length > MAX_PRINCIPALS) throw new InputError(`${field} must have at most ${MAX_PRINCIPALS} entries`);
  return [...new Set(value.map((id, index) => requireString(id, `${field}[${index}]`, MAX_ID)))];
}

function optionalCount(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new InputError(`${field} must be a non-negative integer`);
  }
  return value;
}

function computedDueAt(awareAt: Date, extension: { granted: boolean | null; dueAt: Date | null }): Date {
  if (extension.granted === true && extension.dueAt) return extension.dueAt;
  return new Date(awareAt.getTime() + BOARD_REPORT_HOURS * HOUR_MS);
}

// ── Responses ──────────────────────────────────────────────────────────────

interface IntimationSummary { intimatedCount: number; pendingCount: number | null; lastIntimatedAt: string | null }

async function intimationSummary(sql: TxSql, breach: Record<string, unknown>): Promise<IntimationSummary> {
  const [row] = await sql`
    SELECT
      (SELECT COUNT(DISTINCT p)::int FROM dpdp_breach_principal_intimations i, unnest(i.data_principal_ids) AS p
        WHERE i.breach_id = ${breach['id'] as string}) AS intimated,
      (SELECT COUNT(*)::int FROM unnest(${breach['affected_data_principal_ids'] as string[]}::text[]) AS a
        WHERE NOT EXISTS (SELECT 1 FROM dpdp_breach_principal_intimations i
                          WHERE i.breach_id = ${breach['id'] as string} AND a = ANY(i.data_principal_ids))) AS pending,
      (SELECT MAX(intimated_at) FROM dpdp_breach_principal_intimations WHERE breach_id = ${breach['id'] as string}) AS last_at
  `;
  const listed = (breach['affected_data_principal_ids'] as string[]).length > 0;
  return {
    intimatedCount: Number(row?.['intimated'] ?? 0),
    // Without a list of affected principals, what is pending is not known.
    pendingCount: listed ? Number(row?.['pending'] ?? 0) : null,
    lastIntimatedAt: iso(row?.['last_at']),
  };
}

function missingContent(included: readonly string[]): IntimationContent[] {
  return INTIMATION_CONTENT.filter((item) => !included.includes(item));
}

function intimationResponse(row: Record<string, unknown>) {
  const included = row['content_included'] as string[];
  return {
    intimationId: row['id'],
    channel: row['channel'],
    intimatedAt: iso(row['intimated_at']),
    principalCount: (row['data_principal_ids'] as string[]).length,
    contentIncluded: included,
    contentMissing: missingContent(included),
    createdAt: iso(row['created_at']),
  };
}

export function breachResponse(
  b: Record<string, unknown>,
  options: { detail: boolean; summary?: IntimationSummary; intimations?: Record<string, unknown>[]; now?: number },
) {
  const now = options.now ?? Date.now();
  const dueAt = new Date(b['board_report_due_at'] as string);
  const reportSentAt = b['board_detailed_report_sent_at'] ? new Date(b['board_detailed_report_sent_at'] as string) : null;
  const ids = b['affected_data_principal_ids'] as string[];
  return {
    breachId: b['id'],
    status: b['status'],
    description: b['description'],
    nature: b['nature'],
    extent: b['extent'],
    occurredAt: iso(b['occurred_at']),
    awareAt: iso(b['aware_at']),
    location: b['location'] ?? null,
    likelyImpact: b['likely_impact'] ?? null,
    affectedCount: b['affected_count'] ?? ids.length,
    ...(options.detail ? { affectedDataPrincipalIds: ids } : {}),
    mitigation: b['mitigation'] ?? null,
    detailedReport: Object.fromEntries(
      (Object.keys(REPORT_FIELDS) as ReportField[]).map((field) => [field, b[REPORT_FIELDS[field]] ?? null]),
    ),
    // To the Board: an initial intimation without delay (r.7(2)) and a
    // detailed report within 72 hours of awareness (r.7(2)(b)).
    boardInitialIntimationRequired: true,
    boardInitialIntimationSentAt: iso(b['board_initial_intimation_sent_at']),
    boardDetailedReportDueAt: dueAt.toISOString(),
    boardDetailedReportSentAt: reportSentAt ? reportSentAt.toISOString() : null,
    boardDetailedReportOverdue: reportSentAt === null && now > dueAt.getTime(),
    boardDetailedReportLate: reportSentAt !== null && reportSentAt.getTime() > dueAt.getTime(),
    extension: b['extension_requested_at'] || b['extension_granted'] !== null
      ? {
          requestedAt: iso(b['extension_requested_at']),
          granted: b['extension_granted'] ?? null,
          newDueAt: iso(b['extension_due_at']),
        }
      : null,
    // To each affected Data Principal: without delay (r.7(1)).
    principalIntimationRequired: true,
    ...(options.summary ? { principalIntimation: { due: 'without_delay', ...options.summary } } : {}),
    ...(options.intimations ? { principalIntimations: options.intimations.map(intimationResponse) } : {}),
    createdAt: iso(b['created_at']),
    updatedAt: iso(b['updated_at']),
    closedAt: iso(b['closed_at']),
  };
}

/** Query-only use of the pool or a transaction; both run the same fragments. */
const asTx = (sql: ReturnType<typeof getSql>) => sql as unknown as TxSql;

const BREACH_COLUMNS = (sql: TxSql) => sql`
  id, status, description, nature, extent, occurred_at, aware_at, location, likely_impact,
  affected_data_principal_ids, affected_count, mitigation,
  report_updated_details, report_facts_circumstances_reasons, report_mitigation,
  report_cause_findings, report_remedial_measures, board_initial_intimation_sent_at,
  board_detailed_report_sent_at, extension_requested_at, extension_granted, extension_due_at,
  board_report_due_at, created_at, updated_at, closed_at, created_at::text AS created_at_cursor, due_alert_sent_at, overdue_alert_sent_at`;

// ── Routes ─────────────────────────────────────────────────────────────────

export async function dpdpBreachRoutes(app: FastifyInstance): Promise<void> {
  // POST /v1/dpdp/breaches — Record a personal data breach
  app.post('/v1/dpdp/breaches', async (request, reply) => {
    const developerId = request.developer.id;
    const now = Date.now();
    const input = parseOr400(reply, request, () => {
      const body = requireBody(request.body);
      const awareAt = body['awareAt'] === undefined || body['awareAt'] === null
        ? new Date(now)
        : requirePastDate(body['awareAt'], 'awareAt', now);
      const occurredAt = body['occurredAt'] === undefined || body['occurredAt'] === null
        ? null
        : requirePastDate(body['occurredAt'], 'occurredAt', now);
      if (occurredAt && occurredAt.getTime() > awareAt.getTime()) {
        throw new InputError('occurredAt must not be after awareAt');
      }
      const ids = principalIds(body['affectedDataPrincipalIds'], 'affectedDataPrincipalIds', { required: false });
      const count = optionalCount(body['affectedCount'], 'affectedCount');
      if (ids === undefined && count === undefined) {
        throw new InputError('affectedDataPrincipalIds or affectedCount is required');
      }
      if (ids !== undefined && count !== undefined && count < ids.length) {
        throw new InputError('affectedCount must be at least the number of affectedDataPrincipalIds');
      }
      return {
        description: requireString(body['description'], 'description', MAX_LONG_TEXT),
        nature: requireString(body['nature'], 'nature', MAX_SHORT_TEXT),
        extent: requireString(body['extent'], 'extent', MAX_LONG_TEXT),
        occurredAt,
        awareAt,
        location: optionalString(body['location'], 'location', MAX_SHORT_TEXT) ?? null,
        likelyImpact: optionalString(body['likelyImpact'], 'likelyImpact', MAX_LONG_TEXT) ?? null,
        mitigation: optionalString(body['mitigation'], 'mitigation', MAX_LONG_TEXT) ?? null,
        ids: ids ?? [],
        count: count ?? ids!.length,
      };
    });
    if (!input) return reply;

    const sql = getSql();
    const id = newBreachId();
    const dueAt = computedDueAt(input.awareAt, { granted: null, dueAt: null });
    let row: Record<string, unknown> | undefined;
    await sql.begin(async (_tx) => {
      const tx = _tx as unknown as TxSql;
      const rows = await tx`
        INSERT INTO dpdp_breaches (
          id, developer_id, description, nature, extent, occurred_at, aware_at, location,
          likely_impact, affected_data_principal_ids, affected_count, mitigation, board_report_due_at
        )
        VALUES (
          ${id}, ${developerId}, ${input.description}, ${input.nature}, ${input.extent}, ${input.occurredAt},
          ${input.awareAt}, ${input.location}, ${input.likelyImpact}, ${input.ids}::text[], ${input.count},
          ${input.mitigation}, ${dueAt}
        )
        RETURNING ${BREACH_COLUMNS(tx)}
      `;
      row = rows[0];
      await appendDpdpAudit(tx, developerId, [{
        action: BREACH_AUDIT_ACTIONS.recorded,
        metadata: {
          breach_id: id, affected_count: input.count,
          aware_at: input.awareAt.toISOString(), board_report_due_at: dueAt.toISOString(),
        },
      }]);
    });

    const body = breachResponse(row!, {
      detail: true,
      summary: { intimatedCount: 0, pendingCount: input.ids.length > 0 ? input.ids.length : null, lastIntimatedAt: null },
      intimations: [],
      now,
    });
    emitEvent(developerId, 'dpdp.breach.recorded', {
      breachId: id,
      status: 'open',
      awareAt: body.awareAt,
      affectedCount: input.count,
      boardDetailedReportDueAt: body.boardDetailedReportDueAt,
    }).catch(() => {});
    emitEvent(developerId, 'dpdp.breach.principal_intimation_due', {
      breachId: id,
      awareAt: body.awareAt,
      affectedCount: input.count,
      due: 'without_delay',
    }).catch(() => {});

    return reply.status(201).send(body);
  });

  // GET /v1/dpdp/breaches — List breaches, newest first
  app.get<{ Querystring: Record<string, unknown> }>('/v1/dpdp/breaches', async (request, reply) => {
    const developerId = request.developer.id;
    const input = parseOr400(reply, request, () => {
      const status = request.query['status'];
      if (status !== undefined && !BREACH_STATUSES.includes(status as BreachStatus)) {
        throw new InputError(`status must be one of: ${BREACH_STATUSES.join(', ')}`);
      }
      return { page: parsePage(request.query), status: status as BreachStatus | undefined };
    });
    if (!input) return reply;
    const { page } = input;
    const sql = getSql();
    const rows = await sql`
      SELECT ${BREACH_COLUMNS(asTx(sql))}
      FROM dpdp_breaches
      WHERE developer_id = ${developerId}
        ${input.status ? sql`AND status = ${input.status}` : sql``}
        ${page.cursor ? sql`AND (created_at, id) < (${page.cursor.t}::timestamptz, ${page.cursor.id})` : sql``}
      ORDER BY created_at DESC, id DESC
      LIMIT ${page.limit + 1}
    `;
    const now = Date.now();
    return reply.send({
      breaches: rows.slice(0, page.limit).map((b) => breachResponse(b, { detail: false, now })),
      nextCursor: nextCursor(rows, page.limit),
    });
  });

  // GET /v1/dpdp/breaches/:breachId — One breach, with its intimations
  app.get<{ Params: { breachId: string } }>('/v1/dpdp/breaches/:breachId', async (request, reply) => {
    const developerId = request.developer.id;
    const sql = getSql();
    const rows = await sql`
      SELECT ${BREACH_COLUMNS(asTx(sql))} FROM dpdp_breaches
      WHERE id = ${request.params.breachId} AND developer_id = ${developerId}
    `;
    const breach = rows[0];
    if (!breach) return sendError(reply, request, 404, 'NOT_FOUND', 'Breach not found');
    const summary = await intimationSummary(asTx(sql), breach);
    const intimations = await sql`
      SELECT id, channel, intimated_at, data_principal_ids, content_included, created_at
      FROM dpdp_breach_principal_intimations
      WHERE breach_id = ${breach['id'] as string}
      ORDER BY intimated_at DESC, id DESC
      LIMIT ${INTIMATIONS_SHOWN}
    `;
    return reply.send(breachResponse(breach, { detail: true, summary, intimations: [...intimations] }));
  });

  // PATCH /v1/dpdp/breaches/:breachId — Detailed report, Board times, extension, status
  app.patch<{ Params: { breachId: string } }>('/v1/dpdp/breaches/:breachId', async (request, reply) => {
    const developerId = request.developer.id;
    const { breachId } = request.params;
    const now = Date.now();
    const input = parseOr400(reply, request, () => {
      const body = requireBody(request.body);
      const status = body['status'];
      if (status !== undefined && status !== 'initial_intimated' && status !== 'reported' && status !== 'closed') {
        throw new InputError('status must be one of: initial_intimated, reported, closed');
      }
      const report: Partial<Record<ReportField, string>> = {};
      if (body['detailedReport'] !== undefined) {
        const raw = body['detailedReport'];
        if (!isPlainObject(raw)) throw new InputError('detailedReport must be an object');
        for (const key of Object.keys(raw)) {
          if (!(key in REPORT_FIELDS)) throw new InputError(`detailedReport.${key} is not a detailed report field`);
          report[key as ReportField] = requireString(raw[key], `detailedReport.${key}`, MAX_LONG_TEXT);
        }
      }
      let extension: { requestedAt: Date | null; granted: boolean | null | undefined; newDueAt: Date | null } | undefined;
      if (body['extension'] !== undefined) {
        const raw = body['extension'];
        if (!isPlainObject(raw)) throw new InputError('extension must be an object { requestedAt?, granted?, newDueAt? }');
        const granted = raw['granted'];
        if (granted !== undefined && granted !== null && typeof granted !== 'boolean') {
          throw new InputError('extension.granted must be a boolean or null');
        }
        extension = {
          requestedAt: raw['requestedAt'] === undefined || raw['requestedAt'] === null
            ? null : requirePastDate(raw['requestedAt'], 'extension.requestedAt', now),
          granted: granted as boolean | null | undefined,
          newDueAt: raw['newDueAt'] === undefined || raw['newDueAt'] === null ? null : requireDate(raw['newDueAt'], 'extension.newDueAt'),
        };
        if (extension.granted === true && extension.newDueAt === null) {
          throw new InputError('extension.newDueAt is required when extension.granted is true');
        }
      }
      const initialAt = body['boardInitialIntimationSentAt'] === undefined || body['boardInitialIntimationSentAt'] === null
        ? null : requirePastDate(body['boardInitialIntimationSentAt'], 'boardInitialIntimationSentAt', now);
      const reportAt = body['boardDetailedReportSentAt'] === undefined || body['boardDetailedReportSentAt'] === null
        ? null : requirePastDate(body['boardDetailedReportSentAt'], 'boardDetailedReportSentAt', now);
      if (status === undefined && Object.keys(report).length === 0 && extension === undefined && !initialAt && !reportAt) {
        throw new InputError('Nothing to update: pass status, detailedReport, extension, boardInitialIntimationSentAt or boardDetailedReportSentAt');
      }
      return { status: status as Exclude<BreachStatus, 'open'> | undefined, report, extension, initialAt, reportAt };
    });
    if (!input) return reply;

    const sql = getSql();
    let outcome: { code: number; error: string; message: string } | null = null;
    let updated: Record<string, unknown> | undefined;
    let previousStatus = '';
    await sql.begin(async (_tx) => {
      const tx = _tx as unknown as TxSql;
      const rows = await tx`
        SELECT ${BREACH_COLUMNS(tx)} FROM dpdp_breaches
        WHERE id = ${breachId} AND developer_id = ${developerId}
        FOR UPDATE
      `;
      const current = rows[0];
      if (!current) {
        outcome = { code: 404, error: 'NOT_FOUND', message: 'Breach not found' };
        return;
      }
      previousStatus = current['status'] as string;
      if (previousStatus === 'closed') {
        outcome = { code: 409, error: 'BREACH_CLOSED', message: 'A closed breach cannot be changed' };
        return;
      }
      if (input.status && BREACH_TRANSITIONS[input.status] !== previousStatus) {
        outcome = { code: 409, error: 'INVALID_TRANSITION', message: `A breach cannot move from ${previousStatus} to ${input.status}` };
        return;
      }
      const awareAt = new Date(current['aware_at'] as string);
      for (const [field, value] of [['boardInitialIntimationSentAt', input.initialAt], ['boardDetailedReportSentAt', input.reportAt]] as const) {
        if (value && value.getTime() < awareAt.getTime()) {
          outcome = { code: 400, error: 'BAD_REQUEST', message: `${field} must not be before awareAt` };
          return;
        }
      }
      if (input.extension?.newDueAt && input.extension.newDueAt.getTime() <= awareAt.getTime()) {
        outcome = { code: 400, error: 'BAD_REQUEST', message: 'extension.newDueAt must be after awareAt' };
        return;
      }

      const report = Object.fromEntries((Object.keys(REPORT_FIELDS) as ReportField[]).map((field) => [
        field, input.report[field] ?? (current[REPORT_FIELDS[field]] as string | null),
      ])) as Record<ReportField, string | null>;
      let initialAt = input.initialAt ?? (current['board_initial_intimation_sent_at'] as Date | null);
      let reportAt = input.reportAt ?? (current['board_detailed_report_sent_at'] as Date | null);
      if (input.status === 'initial_intimated' && !initialAt) initialAt = new Date(now);
      if (input.status === 'reported') {
        const missing = (Object.keys(REPORT_FIELDS) as ReportField[]).filter((field) => !report[field]);
        if (missing.length > 0) {
          outcome = {
            code: 400, error: 'REPORT_INCOMPLETE',
            message: `The detailed report (DPDP Rules 2025 r.7(2)(b)) is missing: ${missing.map((f) => `detailedReport.${f}`).join(', ')}`,
          };
          return;
        }
        if (!reportAt) reportAt = new Date(now);
      }

      const extRequestedAt = input.extension
        ? (input.extension.requestedAt ?? (current['extension_requested_at'] as Date | null) ?? new Date(now))
        : (current['extension_requested_at'] as Date | null);
      const extGranted = input.extension && input.extension.granted !== undefined
        ? input.extension.granted
        : (current['extension_granted'] as boolean | null);
      const extDueAt = input.extension?.newDueAt ?? (current['extension_due_at'] as Date | null);
      if (extGranted === true && !extDueAt) {
        outcome = { code: 400, error: 'BAD_REQUEST', message: 'extension.newDueAt is required when extension.granted is true' };
        return;
      }
      const dueAt = computedDueAt(awareAt, { granted: extGranted, dueAt: extDueAt ? new Date(extDueAt) : null });
      const dueChanged = dueAt.getTime() !== new Date(current['board_report_due_at'] as string).getTime();
      const status = input.status ?? previousStatus;

      const result = await tx`
        UPDATE dpdp_breaches SET
          status = ${status},
          report_updated_details = ${report.updatedDetails},
          report_facts_circumstances_reasons = ${report.factsCircumstancesReasons},
          report_mitigation = ${report.mitigation},
          report_cause_findings = ${report.causeFindings},
          report_remedial_measures = ${report.remedialMeasures},
          board_initial_intimation_sent_at = ${initialAt},
          board_detailed_report_sent_at = ${reportAt},
          extension_requested_at = ${extRequestedAt},
          extension_granted = ${extGranted},
          extension_due_at = ${extDueAt},
          board_report_due_at = ${dueAt},
          -- A moved deadline is alerted afresh.
          due_alert_sent_at = ${dueChanged ? null : (current['due_alert_sent_at'] as Date | null) ?? null},
          overdue_alert_sent_at = ${dueChanged ? null : (current['overdue_alert_sent_at'] as Date | null) ?? null},
          updated_at = NOW(),
          closed_at = ${status === 'closed' ? new Date(now) : (current['closed_at'] as Date | null)}
        WHERE id = ${breachId} AND developer_id = ${developerId}
        RETURNING ${BREACH_COLUMNS(tx)}
      `;
      updated = result[0];
      await appendDpdpAudit(tx, developerId, [{
        action: BREACH_AUDIT_ACTIONS.updated,
        metadata: {
          breach_id: breachId,
          previous_status: previousStatus,
          status,
          report_fields: Object.keys(input.report).sort(),
          board_initial_intimation_sent_at: initialAt ? new Date(initialAt).toISOString() : null,
          board_detailed_report_sent_at: reportAt ? new Date(reportAt).toISOString() : null,
          extension_granted: extGranted,
          board_report_due_at: dueAt.toISOString(),
        },
      }]);
    });

    const refused = outcome as { code: number; error: string; message: string } | null;
    if (refused) return sendError(reply, request, refused.code, refused.error, refused.message);
    const summary = await intimationSummary(asTx(sql), updated!);
    return reply.send(breachResponse(updated!, { detail: true, summary, now }));
  });

  // POST /v1/dpdp/breaches/:breachId/principal-intimations — Record that principals were told
  app.post<{ Params: { breachId: string } }>(
    '/v1/dpdp/breaches/:breachId/principal-intimations',
    async (request, reply) => {
      const developerId = request.developer.id;
      const { breachId } = request.params;
      const now = Date.now();
      const input = parseOr400(reply, request, () => {
        const body = requireBody(request.body);
        const content = body['contentIncluded'];
        if (!Array.isArray(content) || content.length === 0) {
          throw new InputError(`contentIncluded must be a non-empty array of: ${INTIMATION_CONTENT.join(', ')}`);
        }
        for (const item of content) {
          if (!INTIMATION_CONTENT.includes(item as IntimationContent)) {
            throw new InputError(`contentIncluded entries must be among: ${INTIMATION_CONTENT.join(', ')}`);
          }
        }
        return {
          ids: principalIds(body['dataPrincipalIds'], 'dataPrincipalIds', { required: true })!,
          channel: requireString(body['channel'], 'channel', MAX_CODE),
          intimatedAt: body['intimatedAt'] === undefined || body['intimatedAt'] === null
            ? new Date(now) : requirePastDate(body['intimatedAt'], 'intimatedAt', now),
          // Stored in the canonical order.
          content: INTIMATION_CONTENT.filter((item) => content.includes(item)),
        };
      });
      if (!input) return reply;

      const sql = getSql();
      const id = newBreachIntimationId();
      let outcome: { code: number; error: string; message: string } | null = null;
      let row: Record<string, unknown> | undefined;
      let summary: IntimationSummary | undefined;
      await sql.begin(async (_tx) => {
        const tx = _tx as unknown as TxSql;
        const rows = await tx`
          SELECT id, aware_at, affected_data_principal_ids FROM dpdp_breaches
          WHERE id = ${breachId} AND developer_id = ${developerId}
          FOR UPDATE
        `;
        const breach = rows[0];
        if (!breach) {
          outcome = { code: 404, error: 'NOT_FOUND', message: 'Breach not found' };
          return;
        }
        if (input.intimatedAt.getTime() < new Date(breach['aware_at'] as string).getTime()) {
          outcome = { code: 400, error: 'BAD_REQUEST', message: 'intimatedAt must not be before the breach awareAt' };
          return;
        }
        const listed = breach['affected_data_principal_ids'] as string[];
        if (listed.length > 0) {
          const known = new Set(listed);
          const unknown = input.ids.filter((pid) => !known.has(pid)).length;
          if (unknown > 0) {
            outcome = {
              code: 400, error: 'BAD_REQUEST',
              message: `${unknown} of dataPrincipalIds are not among the breach's affectedDataPrincipalIds`,
            };
            return;
          }
        }
        const inserted = await tx`
          INSERT INTO dpdp_breach_principal_intimations (
            id, breach_id, developer_id, data_principal_ids, channel, intimated_at, content_included
          )
          VALUES (${id}, ${breachId}, ${developerId}, ${input.ids}::text[], ${input.channel},
                  ${input.intimatedAt}, ${input.content}::text[])
          RETURNING id, channel, intimated_at, data_principal_ids, content_included, created_at
        `;
        row = inserted[0];
        summary = await intimationSummary(tx, breach);
        await appendDpdpAudit(tx, developerId, [{
          action: BREACH_AUDIT_ACTIONS.principalsIntimated,
          metadata: {
            breach_id: breachId, intimation_id: id, channel: input.channel,
            principal_count: input.ids.length, content_included: input.content,
            intimated_at: input.intimatedAt.toISOString(),
          },
        }]);
      });

      const refused = outcome as { code: number; error: string; message: string } | null;
      if (refused) return sendError(reply, request, refused.code, refused.error, refused.message);
      return reply.status(201).send({
        breachId,
        ...intimationResponse(row!),
        principalIntimation: { due: 'without_delay', ...summary! },
      });
    },
  );
}
