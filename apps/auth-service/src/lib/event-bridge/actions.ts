/**
 * Acting on verified events (PRD G-6): resolve each matched rule's target to
 * grants of the same developer, then suspend, revoke or ask the relying
 * platform to re-evaluate.
 *
 * Every resolution query is scoped by `developer_id`. A rule that names a
 * grant, principal or agent of another developer resolves to nothing: the
 * delivery records `no_target` and no grant anywhere changes.
 */
import type postgres from 'postgres';
import type { AppLogger } from '../logger.js';
import { cascadeGrantAction, AUDIT_ACTIONS } from '../revocation/cascade.js';
import { revocationPropagationSeconds } from '../revocation/metrics.js';
import { appendPlatformAuditEntries, lockAuditChain } from '../audit-chain.js';
import { emitEvent } from '../events.js';
import {
  eventBridgeActionsTotal,
  eventBridgeRuleMatchesTotal,
} from './metrics.js';
import { ruleMatchesEvent, targetValues, type MappingRule, type RuleTarget } from './mapping.js';
import type { NormalizedEvent } from './normalize.js';
import type { EventProcessor, ProcessOutcome } from './receipts.js';
import { activeMappingRules } from './rules-store.js';

type Sql = ReturnType<typeof postgres>;

/** Grants named in one re-evaluation event; more than this and the event says so. */
const MAX_EVENT_GRANT_IDS = 1_000;

export type ActionOutcome = 'applied' | 'observed' | 'no_target' | 'target_invalid';

export interface RuleOutcome {
  ruleId: string;
  action: string;
  mode: string;
  outcome: ActionOutcome;
  grants: number;
}

/** Grants of this developer the target resolves to. Other developers' grants can never appear. */
export async function resolveTargetGrants(
  sql: Sql,
  developerId: string,
  target: RuleTarget,
  values: readonly string[],
): Promise<string[]> {
  const live = ['active', 'suspended'];
  if (target.by === 'grant_id') {
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM grants
       WHERE developer_id = ${developerId} AND id = ANY(${values as string[]}) AND status = ANY(${live})`;
    return rows.map((row) => row.id);
  }
  if (target.by === 'principal_id') {
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM grants
       WHERE developer_id = ${developerId} AND principal_id = ANY(${values as string[]}) AND status = ANY(${live})`;
    return rows.map((row) => row.id);
  }
  if (target.by === 'agent_id') {
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM grants
       WHERE developer_id = ${developerId} AND agent_id = ANY(${values as string[]}) AND status = ANY(${live})`;
    return rows.map((row) => row.id);
  }
  const rows = await sql<{ id: string }[]>`
    SELECT g.id FROM grant_subject_refs r
      JOIN grants g ON g.id = r.grant_id AND g.developer_id = r.developer_id
     WHERE r.developer_id = ${developerId} AND r.kind = ${target.kind ?? ''}
       AND r.value = ANY(${values as string[]}) AND g.status = ANY(${live})`;
  return rows.map((row) => row.id);
}

/**
 * Tell the relying platform to look at these grants again: an audit entry per
 * grant and one event per rule match. Nothing about the grants changes.
 */
export async function requestReEvaluation(
  sql: Sql,
  developerId: string,
  grantIds: readonly string[],
  context: Record<string, unknown>,
): Promise<void> {
  if (grantIds.length === 0) return;
  await sql.begin(async (raw) => {
    const tx = raw as unknown as Sql;
    const head = await lockAuditChain(tx, developerId);
    await appendPlatformAuditEntries(tx, developerId, head, grantIds.map((grantId) => ({
      action: AUDIT_ACTIONS.reEvaluate,
      grantId,
      metadata: { grant_id: grantId, ...context },
    })));
  });
  await emitEvent(developerId, 'grant.re_evaluation_requested', {
    grantIds: grantIds.slice(0, MAX_EVENT_GRANT_IDS),
    grantCount: grantIds.length,
    truncated: grantIds.length > MAX_EVENT_GRANT_IDS,
    ...context,
  }).catch(() => { /* best effort, like every other event emission */ });
}

export interface MappingProcessorOptions {
  developerId: string;
  sourceId: string;
  /** When the delivery arrived, for the propagation histogram. */
  receivedAt: number;
}

/**
 * The processor the ingestion route runs on a verified delivery: evaluate the
 * developer's rules, apply what they say, and report what happened so the
 * receipt records it.
 */
export function mappingProcessor(sql: Sql, log: AppLogger, options: MappingProcessorOptions): EventProcessor {
  return async (events: NormalizedEvent[]): Promise<ProcessOutcome> => {
    const { developerId, sourceId } = options;
    const rules = await activeMappingRules(sql, developerId, sourceId);
    const perEvent: Array<{ type: string; rules: RuleOutcome[] }> = [];
    const toRevoke = new Set<string>();
    const toSuspend = new Set<string>();
    const toReEvaluate = new Map<string, { rule: MappingRule; event: NormalizedEvent; grantIds: Set<string> }>();
    let matched = 0;
    // Enforce-mode rules that matched, whatever they resolved to: a rule that
    // matched and found no grant still ran, so the delivery is not "observed".
    let enforced = 0;
    let acted = 0;

    for (const event of events) {
      const outcomes: RuleOutcome[] = [];
      for (const rule of rules) {
        if (!ruleMatchesEvent(rule, event)) continue;
        matched += 1;
        eventBridgeRuleMatchesTotal.inc({ action: rule.action, mode: rule.mode });
        if (rule.mode === 'enforce') enforced += 1;
        const values = targetValues(rule, event);
        if (values === null) {
          log.warn(
            { event_bridge: 'target_invalid', ruleId: rule.id, sourceId, eventId: event.eventId, eventType: event.type },
            'mapping rule matched but the event carries no usable identifier at its target path',
          );
          outcomes.push({ ruleId: rule.id, action: rule.action, mode: rule.mode, outcome: 'target_invalid', grants: 0 });
          eventBridgeActionsTotal.inc({ action: rule.action, outcome: 'target_invalid' });
          continue;
        }
        const grantIds = await resolveTargetGrants(sql, developerId, rule.target, values);
        if (grantIds.length === 0) {
          log.info(
            { event_bridge: 'no_target', ruleId: rule.id, sourceId, eventId: event.eventId, eventType: event.type },
            'mapping rule matched but resolved no grant of this developer',
          );
          outcomes.push({ ruleId: rule.id, action: rule.action, mode: rule.mode, outcome: 'no_target', grants: 0 });
          eventBridgeActionsTotal.inc({ action: rule.action, outcome: 'no_target' });
          continue;
        }
        if (rule.mode === 'observe') {
          log.info(
            { event_bridge: 'observed', ruleId: rule.id, action: rule.action, grants: grantIds.length, eventId: event.eventId },
            'mapping rule matched in observe mode; no action taken',
          );
          outcomes.push({ ruleId: rule.id, action: rule.action, mode: rule.mode, outcome: 'observed', grants: grantIds.length });
          eventBridgeActionsTotal.inc({ action: rule.action, outcome: 'observed' });
          continue;
        }
        acted += 1;
        if (rule.action === 'revoke') {
          for (const id of grantIds) toRevoke.add(id);
        } else if (rule.action === 'suspend') {
          for (const id of grantIds) toSuspend.add(id);
        } else {
          const entry = toReEvaluate.get(rule.id) ?? { rule, event, grantIds: new Set<string>() };
          for (const id of grantIds) entry.grantIds.add(id);
          toReEvaluate.set(rule.id, entry);
        }
        outcomes.push({ ruleId: rule.id, action: rule.action, mode: rule.mode, outcome: 'applied', grants: grantIds.length });
        eventBridgeActionsTotal.inc({ action: rule.action, outcome: 'applied' });
      }
      perEvent.push({ type: event.type, rules: outcomes });
    }

    if (matched === 0) {
      for (const event of events) {
        log.info(
          { event_bridge: 'unmapped', sourceId, eventId: event.eventId, eventType: event.type },
          'event bridge event matched no mapping rule and was ignored',
        );
      }
      return { status: 'unmapped', result: { events: perEvent.map((entry) => ({ type: entry.type, outcome: 'unmapped' })) } };
    }

    const first = events[0]!;
    const context = {
      event_id: first.eventId,
      event_type: first.type,
      source_id: sourceId,
    };

    let revoked = 0;
    let suspended = 0;
    if (toRevoke.size > 0) {
      const outcome = await cascadeGrantAction(sql, {
        developerId,
        rootGrantIds: [...toRevoke],
        action: 'revoke',
        cause: 'event',
        context,
      });
      revoked = outcome.affected.length;
    }
    if (toSuspend.size > 0) {
      // A grant this delivery revokes is not also suspended.
      const roots = [...toSuspend].filter((id) => !toRevoke.has(id));
      if (roots.length > 0) {
        const outcome = await cascadeGrantAction(sql, {
          developerId,
          rootGrantIds: roots,
          action: 'suspend',
          cause: 'event',
          context,
        });
        suspended = outcome.affected.length;
      }
    }
    let reEvaluated = 0;
    for (const entry of toReEvaluate.values()) {
      const grantIds = [...entry.grantIds];
      await requestReEvaluation(sql, developerId, grantIds, {
        ...context,
        rule_id: entry.rule.id,
        subject: entry.event.subject,
      });
      reEvaluated += grantIds.length;
    }

    if (acted > 0 && (revoked > 0 || suspended > 0)) {
      revocationPropagationSeconds.observe({ stage: 'event_to_commit' }, (Date.now() - options.receivedAt) / 1000);
    }

    return {
      status: enforced > 0 ? 'applied' : 'observed',
      result: {
        events: perEvent,
        revoked,
        suspended,
        re_evaluated: reEvaluated,
      },
    };
  };
}
