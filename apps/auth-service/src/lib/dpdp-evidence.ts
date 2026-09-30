/**
 * Structured compliance exports built from what Grantex records.
 *
 * `euAiActSections` maps a developer's records for a period to Regulation
 * (EU) 2024/1689, as amended by Regulation (EU) 2026/1744: Art. 12 record
 * keeping (the audit hash chain), Art. 14 human oversight, Art. 26 deployer
 * obligations, Art. 50 transparency and Art. 73 serious incidents. Each
 * section names its data source and says whether it was truncated. The pack
 * is evidence for the operator's own assessment; it is not a conformity
 * assessment and says so.
 *
 * `gdprArticle15` builds the GDPR Art. 15 information for one data subject:
 * the purposes, the recipients, the retention and the source, as far as the
 * records Grantex holds allow.
 */
import type { getSql } from '../db/client.js';
import { toAuditEntryResponse } from './audit-entry.js';
import { verifyChain, type ChainIntegrity } from '../routes/compliance.js';

type Sql = ReturnType<typeof getSql>;
type Row = Record<string, unknown>;

/** Events listed in the Art. 12 section; eventCount is exact. */
export const EVIDENCE_EVENT_LIMIT = 1_000;
/** Entries the chain check reads; beyond it the check covers the oldest ones only. */
export const EVIDENCE_CHAIN_VERIFY_LIMIT = 50_000;
/** Rows listed in the other sections. */
export const EVIDENCE_ITEM_LIMIT = 500;
/** Consent records the Art. 15 block covers. */
export const ARTICLE15_RECORD_LIMIT = 1_000;

export const EU_AI_ACT_APPLICABILITY = {
  regulation: 'Regulation (EU) 2024/1689 (Artificial Intelligence Act), as amended by Regulation (EU) 2026/1744',
  art50TransparencyFrom: '2026-08-02',
  highRiskAnnexIIIFrom: '2027-12-02',
  highRiskAnnexIFrom: '2028-08-02',
  note: 'Which obligations apply depends on the operator\'s role (provider or deployer) and on how its AI system is '
    + 'classified. An authorisation layer is not itself a high-risk AI system; an agent doing work listed in Annex III '
    + 'may be.',
} as const;

export const EU_AI_ACT_DISCLAIMER = 'This pack is evidence drawn from Grantex records to support the operator\'s own '
  + 'assessment under Regulation (EU) 2024/1689. It is not a conformity assessment, a certification or a statement '
  + 'that any AI system complies with the Regulation, and it covers only what Grantex records.';

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value as string).toISOString();
}

function counts(rows: Row[], key: string): Record<string, number> {
  return Object.fromEntries(rows.map((row) => [String(row[key]), Number(row['n'])]));
}

async function art12RecordKeeping(sql: Sql, developerId: string, from: Date, to: Date) {
  const [stats] = await sql`
    SELECT COUNT(*)::int AS n, MIN(timestamp) AS first_at, MAX(timestamp) AS last_at
    FROM audit_entries
    WHERE developer_id = ${developerId} AND timestamp >= ${from} AND timestamp <= ${to}
  `;
  const [oldest] = await sql`SELECT MIN(timestamp) AS oldest FROM audit_entries WHERE developer_id = ${developerId}`;
  const eventCount = Number(stats?.['n'] ?? 0);
  // Chain order, as the chain builder and the compliance evidence pack read it.
  const chainRows = await sql`
    SELECT id, agent_id, agent_did, grant_id, principal_id, developer_id,
           action, metadata, hash, previous_hash, timestamp, status
    FROM audit_entries
    WHERE developer_id = ${developerId} AND timestamp >= ${from} AND timestamp <= ${to}
    ORDER BY timestamp ASC, id ASC
    LIMIT ${EVIDENCE_CHAIN_VERIFY_LIMIT}
  `;
  const integrity: ChainIntegrity = verifyChain(chainRows as unknown as Row[]);
  const chainComplete = chainRows.length === eventCount;
  const actions = await sql`
    SELECT action, COUNT(*)::int AS n FROM audit_entries
    WHERE developer_id = ${developerId} AND timestamp >= ${from} AND timestamp <= ${to}
    GROUP BY action ORDER BY n DESC, action LIMIT 100
  `;
  const events = await sql`
    SELECT id, agent_id, agent_did, grant_id, principal_id, developer_id,
           action, metadata, hash, previous_hash, timestamp, status
    FROM audit_entries
    WHERE developer_id = ${developerId} AND timestamp >= ${from} AND timestamp <= ${to}
    ORDER BY timestamp DESC, id DESC
    LIMIT ${EVIDENCE_EVENT_LIMIT}
  `;
  const oldestAt = iso(oldest?.['oldest']);
  return {
    article: 'Art. 12 (record-keeping); Arts. 19(1) and 26(6) (keeping the logs)',
    source: 'audit_entries: the developer\'s hash-chained audit log (agent actions and platform records)',
    eventCount,
    firstEventAt: iso(stats?.['first_at']),
    lastEventAt: iso(stats?.['last_at']),
    chainIntegrity: {
      ...integrity,
      complete: chainComplete,
      verifiedLimit: EVIDENCE_CHAIN_VERIFY_LIMIT,
      method: 'Each entry\'s hash is recomputed from its fields and linked to the previous entry\'s hash, from the '
        + 'first entry in the period.',
    },
    actions: counts([...actions], 'action'),
    events: events.map(toAuditEntryResponse),
    eventsLimit: EVIDENCE_EVENT_LIMIT,
    retention: {
      oldestRetainedEventAt: oldestAt,
      retainedDays: oldestAt ? Math.floor((Date.now() - new Date(oldestAt).getTime()) / 86_400_000) : 0,
      statement: 'Regulation (EU) 2024/1689 Art. 19(1) (providers) and Art. 26(6) (deployers) require automatically '
        + 'generated logs to be kept for at least six months; six months is a minimum, not a maximum. Grantex does '
        + 'not delete or rewrite audit entries: how long they are kept is the operator\'s database retention.',
    },
    truncated: events.length < eventCount || !chainComplete,
  };
}

async function art14HumanOversight(sql: Sql, developerId: string, from: Date, to: Date) {
  const [developer] = await sql`SELECT mode FROM developers WHERE id = ${developerId}`;
  const authRequests = await sql`
    SELECT status, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE fido_verified)::int AS fido
    FROM auth_requests
    WHERE developer_id = ${developerId} AND created_at >= ${from} AND created_at <= ${to}
    GROUP BY status
  `;
  const decisionRequests = await sql`
    SELECT status, COUNT(*)::int AS n FROM decision_requests
    WHERE developer_id = ${developerId} AND created_at >= ${from} AND created_at <= ${to}
    GROUP BY status
  `;
  const [decisionGrants] = await sql`
    SELECT COUNT(*)::int AS issued,
           COUNT(*) FILTER (WHERE consumed_at IS NOT NULL)::int AS consumed,
           COUNT(*) FILTER (WHERE revoked_at IS NOT NULL)::int AS revoked,
           COUNT(*) FILTER (WHERE approval_position = 2)::int AS second_approvals
    FROM decision_grants
    WHERE developer_id = ${developerId} AND issued_at >= ${from} AND issued_at <= ${to}
  `;
  const paymentApprovals = await sql`
    SELECT status, COUNT(*)::int AS n FROM wallet_payment_approval_requests
    WHERE developer_id = ${developerId} AND decided_at >= ${from} AND decided_at <= ${to}
    GROUP BY status
  `;
  const [revoked] = await sql`
    SELECT COUNT(*)::int AS n FROM grants
    WHERE developer_id = ${developerId} AND revoked_at >= ${from} AND revoked_at <= ${to}
  `;
  const revocationEvents = await sql`
    SELECT action, COUNT(*)::int AS n FROM grant_revocation_events
    WHERE developer_id = ${developerId} AND created_at >= ${from} AND created_at <= ${to}
    GROUP BY action
  `;
  const stops = await sql`
    SELECT id, scope_type, dry_run, status, grants_matched, grants_revoked, started_at, completed_at
    FROM emergency_stops
    WHERE developer_id = ${developerId} AND started_at >= ${from} AND started_at <= ${to}
    ORDER BY started_at DESC, id DESC
    LIMIT ${EVIDENCE_ITEM_LIMIT + 1}
  `;
  const [stopCount] = await sql`
    SELECT COUNT(*)::int AS n FROM emergency_stops
    WHERE developer_id = ${developerId} AND started_at >= ${from} AND started_at <= ${to}
  `;
  const [withdrawals] = await sql`
    SELECT COUNT(*)::int AS n FROM dpdp_consent_records
    WHERE developer_id = ${developerId} AND withdrawn_at >= ${from} AND withdrawn_at <= ${to}
  `;
  const stopsTruncated = stops.length > EVIDENCE_ITEM_LIMIT;
  const sandbox = developer?.['mode'] === 'sandbox';
  return {
    article: 'Art. 14 (human oversight); Art. 26 (deployers assign human oversight)',
    sources: [
      'auth_requests', 'decision_requests', 'decision_grants', 'wallet_payment_approval_requests',
      'grants', 'grant_revocation_events', 'emergency_stops', 'dpdp_consent_records',
    ],
    consentDecisions: {
      source: 'auth_requests: authorisation requests created in the period, by status',
      byStatus: counts([...authRequests], 'status'),
      fidoVerified: authRequests.reduce((sum, row) => sum + Number(row['fido']), 0),
      note: sandbox
        ? 'This developer is in sandbox mode, where authorisation requests are approved automatically unless FIDO is '
          + 'required; those approvals are not human decisions.'
        : 'Approved requests were approved by the principal on the consent page, or by the developer where it '
          + 'approves on the principal\'s behalf.',
    },
    decisionApprovals: {
      source: 'decision_requests and decision_grants: human approvals of individual agent actions',
      requestsByStatus: counts([...decisionRequests], 'status'),
      approvalsIssued: Number(decisionGrants?.['issued'] ?? 0),
      approvalsConsumed: Number(decisionGrants?.['consumed'] ?? 0),
      approvalsRevoked: Number(decisionGrants?.['revoked'] ?? 0),
      secondApprovals: Number(decisionGrants?.['second_approvals'] ?? 0),
    },
    paymentApprovals: {
      source: 'wallet_payment_approval_requests: payment approvals decided in the period',
      byStatus: counts([...paymentApprovals], 'status'),
    },
    revocations: {
      source: 'grants.revoked_at and grant_revocation_events',
      grantsRevoked: Number(revoked?.['n'] ?? 0),
      eventsByAction: counts([...revocationEvents], 'action'),
    },
    emergencyStops: {
      source: 'emergency_stops: operator overrides that stop agents or grants',
      count: Number(stopCount?.['n'] ?? 0),
      items: stops.slice(0, EVIDENCE_ITEM_LIMIT).map((row) => ({
        stopId: row['id'],
        scopeType: row['scope_type'],
        dryRun: row['dry_run'],
        status: row['status'],
        grantsMatched: row['grants_matched'],
        grantsRevoked: row['grants_revoked'],
        startedAt: iso(row['started_at']),
        completedAt: iso(row['completed_at']),
      })),
      truncated: stopsTruncated,
    },
    consentWithdrawals: {
      source: 'dpdp_consent_records.withdrawn_at',
      count: Number(withdrawals?.['n'] ?? 0),
    },
    truncated: stopsTruncated,
  };
}

async function art26Deployer(sql: Sql, developerId: string, from: Date, to: Date) {
  const agents = await sql`
    SELECT g.agent_id, a.name AS agent_name, a.did AS agent_did,
           COUNT(*)::int AS issued,
           COUNT(*) FILTER (WHERE g.status = 'active' AND g.expires_at > NOW())::int AS active,
           COUNT(*) FILTER (WHERE g.status = 'revoked')::int AS revoked,
           COALESCE((SELECT array_agg(DISTINCT s ORDER BY s) FROM grants g2, unnest(g2.scopes) AS s
                     WHERE g2.developer_id = ${developerId} AND g2.agent_id = g.agent_id
                       AND g2.issued_at >= ${from} AND g2.issued_at <= ${to}), '{}') AS scopes
    FROM grants g
    LEFT JOIN agents a ON a.id = g.agent_id
    WHERE g.developer_id = ${developerId} AND g.issued_at >= ${from} AND g.issued_at <= ${to}
    GROUP BY g.agent_id, a.name, a.did
    ORDER BY issued DESC, g.agent_id
    LIMIT ${EVIDENCE_ITEM_LIMIT + 1}
  `;
  const [total] = await sql`
    SELECT COUNT(DISTINCT agent_id)::int AS agents, COUNT(*)::int AS grants FROM grants
    WHERE developer_id = ${developerId} AND issued_at >= ${from} AND issued_at <= ${to}
  `;
  const truncated = agents.length > EVIDENCE_ITEM_LIMIT;
  return {
    article: 'Art. 26 (obligations of deployers of high-risk AI systems)',
    source: 'grants and agents: the authority each agent was given in the period, and its revocation',
    agentCount: Number(total?.['agents'] ?? 0),
    grantCount: Number(total?.['grants'] ?? 0),
    agents: agents.slice(0, EVIDENCE_ITEM_LIMIT).map((row) => ({
      agentId: row['agent_id'],
      agentName: row['agent_name'] ?? null,
      agentDid: row['agent_did'] ?? null,
      grantsIssued: row['issued'],
      activeGrants: row['active'],
      revokedGrants: row['revoked'],
      scopes: row['scopes'],
    })),
    truncated,
  };
}

function art50Transparency() {
  return {
    article: 'Art. 50 (transparency obligations for providers and deployers of certain AI systems)',
    applicableFrom: EU_AI_ACT_APPLICABILITY.art50TransparencyFrom,
    source: 'none: no Grantex record captures Art. 50 disclosures',
    recorded: false,
    statement: 'Not recorded: Grantex records authorisation, consent and audit events, not whether people were told '
      + 'that they were interacting with an AI system (Art. 50(1)), whether generated content was marked (Art. 50(2)), '
      + 'or other Art. 50 disclosures. Evidence of these must come from the operator\'s own systems.',
    truncated: false,
  };
}

async function art73Incidents(sql: Sql, developerId: string, from: Date, to: Date) {
  const rows = await sql`
    SELECT id, status, nature, occurred_at, aware_at, affected_count, affected_data_principal_ids,
           board_report_due_at, board_detailed_report_sent_at
    FROM dpdp_breaches
    WHERE developer_id = ${developerId} AND aware_at >= ${from} AND aware_at <= ${to}
    ORDER BY aware_at DESC, id DESC
    LIMIT ${EVIDENCE_ITEM_LIMIT + 1}
  `;
  const [count] = await sql`
    SELECT COUNT(*)::int AS n FROM dpdp_breaches
    WHERE developer_id = ${developerId} AND aware_at >= ${from} AND aware_at <= ${to}
  `;
  const truncated = rows.length > EVIDENCE_ITEM_LIMIT;
  return {
    article: 'Art. 73 (reporting of serious incidents)',
    source: 'dpdp_breaches: the personal data breach register (POST /v1/dpdp/breaches), by awareAt',
    count: Number(count?.['n'] ?? 0),
    items: rows.slice(0, EVIDENCE_ITEM_LIMIT).map((row) => ({
      breachId: row['id'],
      status: row['status'],
      nature: row['nature'],
      occurredAt: iso(row['occurred_at']),
      awareAt: iso(row['aware_at']),
      affectedCount: row['affected_count'] ?? (row['affected_data_principal_ids'] as string[]).length,
      boardDetailedReportDueAt: iso(row['board_report_due_at']),
      boardDetailedReportSentAt: iso(row['board_detailed_report_sent_at']),
    })),
    note: 'These are personal data breaches recorded under DPDP Act 2023 s.8(6). Whether any is a serious incident '
      + 'under Art. 73 is for the operator to decide; a serious incident is reported not later than 15 days after '
      + 'awareness (2 days for a widespread infringement or one affecting critical infrastructure, 10 days in the '
      + 'event of a death). Grantex does not classify or report incidents.',
    truncated,
  };
}

export interface EuAiActSections {
  applicability: typeof EU_AI_ACT_APPLICABILITY;
  disclaimer: string;
  art12RecordKeeping: Awaited<ReturnType<typeof art12RecordKeeping>>;
  art14HumanOversight: Awaited<ReturnType<typeof art14HumanOversight>>;
  art26Deployer: Awaited<ReturnType<typeof art26Deployer>>;
  art50Transparency: ReturnType<typeof art50Transparency>;
  art73Incidents: Awaited<ReturnType<typeof art73Incidents>>;
}

export async function euAiActSections(sql: Sql, developerId: string, from: Date, to: Date): Promise<EuAiActSections> {
  return {
    applicability: EU_AI_ACT_APPLICABILITY,
    disclaimer: EU_AI_ACT_DISCLAIMER,
    art12RecordKeeping: await art12RecordKeeping(sql, developerId, from, to),
    art14HumanOversight: await art14HumanOversight(sql, developerId, from, to),
    art26Deployer: await art26Deployer(sql, developerId, from, to),
    art50Transparency: art50Transparency(),
    art73Incidents: await art73Incidents(sql, developerId, from, to),
  };
}

/** Whether any section left rows out, and how many rows the sections list. */
export function sectionsSummary(sections: EuAiActSections): { truncated: boolean; itemCount: number } {
  return {
    truncated: sections.art12RecordKeeping.truncated || sections.art14HumanOversight.truncated
      || sections.art26Deployer.truncated || sections.art73Incidents.truncated,
    itemCount: sections.art12RecordKeeping.events.length + sections.art14HumanOversight.emergencyStops.items.length
      + sections.art26Deployer.agents.length + sections.art73Incidents.items.length,
  };
}

/**
 * GDPR Art. 15(1): the purposes, the recipients, the retention period and
 * the source, for one data subject, from the consent records Grantex holds
 * for this developer (all of them, not only those in the export's period:
 * Art. 15 is about the processing as it stands).
 */
export async function gdprArticle15(sql: Sql, developerId: string, dataPrincipalId: string) {
  const records = await sql`
    SELECT id, grant_id, purposes, status, consent_notice_id, consent_notice_version, consent_notice_language,
           consent_given_at, processing_expires_at, retention_until, withdrawn_at, erased_at
    FROM dpdp_consent_records
    WHERE developer_id = ${developerId} AND data_principal_id = ${dataPrincipalId}
    ORDER BY created_at DESC, id DESC
    LIMIT ${ARTICLE15_RECORD_LIMIT + 1}
  `;
  const truncated = records.length > ARTICLE15_RECORD_LIMIT;
  const kept = records.slice(0, ARTICLE15_RECORD_LIMIT);
  const recordGrantIds = [...new Set(kept.map((r) => r['grant_id'] as string).filter(Boolean))];
  // The grants the subject's consent covers, and grants issued to the
  // subject directly (the grant principal).
  const grants = await sql`
    SELECT g.id, g.agent_id, g.scopes, g.audience, g.purpose, g.status, a.name AS agent_name, a.did AS agent_did
    FROM grants g
    LEFT JOIN agents a ON a.id = g.agent_id
    WHERE g.developer_id = ${developerId}
      AND (g.id = ANY(${recordGrantIds}::text[]) OR g.principal_id = ${dataPrincipalId})
    ORDER BY g.id
    LIMIT ${ARTICLE15_RECORD_LIMIT + 1}
  `;
  const grantsTruncated = grants.length > ARTICLE15_RECORD_LIMIT;

  const purposes = new Map<string, { code: string; description: string; recordIds: string[] }>();
  for (const record of kept) {
    for (const purpose of (record['purposes'] as Array<{ code: string; description: string }> | null) ?? []) {
      const entry = purposes.get(purpose.code) ?? { code: purpose.code, description: purpose.description, recordIds: [] };
      entry.recordIds.push(record['id'] as string);
      purposes.set(purpose.code, entry);
    }
  }
  const grantPurposes = [...new Set(grants.map((g) => g['purpose'] as string | null).filter((p): p is string => Boolean(p)))];

  const recipients = new Map<string, {
    type: 'agent'; agentId: string; agentName: string | null; agentDid: string | null;
    grantIds: string[]; scopes: string[]; audiences: string[];
  }>();
  for (const grant of grants.slice(0, ARTICLE15_RECORD_LIMIT)) {
    const agentId = grant['agent_id'] as string;
    const entry = recipients.get(agentId) ?? {
      type: 'agent' as const, agentId, agentName: (grant['agent_name'] as string | null) ?? null,
      agentDid: (grant['agent_did'] as string | null) ?? null, grantIds: [], scopes: [], audiences: [],
    };
    entry.grantIds.push(grant['id'] as string);
    for (const scope of grant['scopes'] as string[]) if (!entry.scopes.includes(scope)) entry.scopes.push(scope);
    const audience = grant['audience'] as string | null;
    if (audience && !entry.audiences.includes(audience)) entry.audiences.push(audience);
    recipients.set(agentId, entry);
  }
  for (const entry of recipients.values()) entry.scopes.sort();

  return {
    basis: 'GDPR Art. 15',
    dataPrincipalId,
    scope: 'What Grantex holds about the data subject for this controller: consent records, the grants they cover, '
      + 'audit entries and grievances (the copy is in consentRecords, auditLog and grievances). Personal data the '
      + 'controller processes in its own systems is not held by Grantex.',
    purposes: [...purposes.values()],
    grantPurposes,
    recipients: [...recipients.values()],
    recipientsNote: 'Recipients are the agents the data subject authorised through grants, with the resource servers '
      + '(audiences) those grants name. Onward recipients in the controller\'s own systems are not recorded.',
    retention: {
      records: kept.map((r) => ({
        recordId: r['id'],
        status: r['status'],
        processingExpiresAt: iso(r['processing_expires_at']),
        retentionUntil: iso(r['retention_until']),
        withdrawnAt: iso(r['withdrawn_at']),
        erasedAt: iso(r['erased_at']),
      })),
      statement: 'Consent records are kept until retentionUntil; audit entries are kept and not rewritten, as they '
        + 'form a tamper-evident chain (DPDP Rules 2025 r.8(3) require processing logs to be kept for at least one year).',
    },
    source: {
      records: kept.map((r) => ({
        recordId: r['id'],
        consentNoticeId: r['consent_notice_id'],
        consentNoticeVersion: r['consent_notice_version'] ?? null,
        consentNoticeLanguage: r['consent_notice_language'] ?? null,
        consentGivenAt: iso(r['consent_given_at']),
      })),
      statement: 'The consent records were created by the controller through the Grantex API when the data subject '
        + 'gave consent against the notice named. Grantex does not collect personal data from other sources.',
    },
    automatedDecisionMaking: {
      recorded: false,
      statement: 'Not recorded: Grantex does not record whether the controller makes decisions based solely on '
        + 'automated processing (GDPR Art. 22); that information must come from the controller.',
    },
    truncated: truncated || grantsTruncated,
  };
}
