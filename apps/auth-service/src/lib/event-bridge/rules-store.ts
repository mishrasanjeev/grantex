/**
 * Storage for mapping rules. A rule is only ever read for the developer that
 * owns it, and a rule may only name an event source of the same developer.
 */
import type postgres from 'postgres';
import { ulid } from 'ulid';
import {
  MAX_RULES_PER_DEVELOPER,
  RuleValidationError,
  parseRuleInput,
  type MappingRule,
} from './mapping.js';

type Sql = ReturnType<typeof postgres>;

export interface MappingRuleRow {
  id: string;
  developer_id: string;
  name: string;
  source_id: string | null;
  event_type: string;
  conditions: unknown;
  target: unknown;
  action: string;
  mode: string;
  status: string;
  created_at: Date | string;
  updated_at: Date | string;
}

export const newMappingRuleId = (): string => `evmap_${ulid()}`;

export function toRule(row: MappingRuleRow): MappingRule {
  return {
    id: row.id,
    developerId: row.developer_id,
    name: row.name,
    sourceId: row.source_id,
    eventType: row.event_type,
    conditions: (Array.isArray(row.conditions) ? row.conditions : []) as MappingRule['conditions'],
    target: row.target as MappingRule['target'],
    action: row.action as MappingRule['action'],
    mode: row.mode as MappingRule['mode'],
    status: row.status as MappingRule['status'],
  };
}

export function toRuleResponse(row: MappingRuleRow): Record<string, unknown> {
  const rule = toRule(row);
  return {
    id: rule.id,
    name: rule.name,
    sourceId: rule.sourceId,
    eventType: rule.eventType,
    conditions: rule.conditions,
    target: rule.target,
    action: rule.action,
    mode: rule.mode,
    status: rule.status,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

async function assertSourceBelongsToDeveloper(sql: Sql, developerId: string, sourceId: string | null): Promise<void> {
  if (sourceId === null) return;
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM event_bridge_sources WHERE id = ${sourceId} AND developer_id = ${developerId}`;
  if (!rows[0]) {
    throw new RuleValidationError({ sourceId: 'no such event source for this developer' });
  }
}

export async function createMappingRule(sql: Sql, developerId: string, body: unknown): Promise<MappingRuleRow> {
  const input = parseRuleInput(body);
  await assertSourceBelongsToDeveloper(sql, developerId, input.sourceId);
  const id = newMappingRuleId();
  const rows = await sql<MappingRuleRow[]>`
    INSERT INTO event_mapping_rules (id, developer_id, name, source_id, event_type, conditions, target, action, mode, status)
    SELECT ${id}, ${developerId}, ${input.name}, ${input.sourceId}, ${input.eventType},
           ${sql.json(input.conditions as unknown as postgres.JSONValue)}, ${sql.json(input.target as unknown as postgres.JSONValue)},
           ${input.action}, ${input.mode}, ${input.status}
    WHERE (SELECT COUNT(*) FROM event_mapping_rules WHERE developer_id = ${developerId}) < ${MAX_RULES_PER_DEVELOPER}
    RETURNING *`;
  if (!rows[0]) {
    throw new RuleValidationError({ body: `at most ${MAX_RULES_PER_DEVELOPER} mapping rules per developer` });
  }
  return rows[0];
}

export async function listMappingRules(sql: Sql, developerId: string): Promise<MappingRuleRow[]> {
  return sql<MappingRuleRow[]>`
    SELECT * FROM event_mapping_rules WHERE developer_id = ${developerId} ORDER BY created_at DESC, id DESC`;
}

export async function getMappingRule(sql: Sql, developerId: string, id: string): Promise<MappingRuleRow | null> {
  const rows = await sql<MappingRuleRow[]>`
    SELECT * FROM event_mapping_rules WHERE id = ${id} AND developer_id = ${developerId}`;
  return rows[0] ?? null;
}

export async function updateMappingRule(
  sql: Sql,
  developerId: string,
  id: string,
  body: unknown,
): Promise<MappingRuleRow | null> {
  const existing = await getMappingRule(sql, developerId, id);
  if (!existing) return null;
  const input = parseRuleInput(body, toRule(existing));
  await assertSourceBelongsToDeveloper(sql, developerId, input.sourceId);
  const rows = await sql<MappingRuleRow[]>`
    UPDATE event_mapping_rules SET
      name = ${input.name},
      source_id = ${input.sourceId},
      event_type = ${input.eventType},
      conditions = ${sql.json(input.conditions as unknown as postgres.JSONValue)},
      target = ${sql.json(input.target as unknown as postgres.JSONValue)},
      action = ${input.action},
      mode = ${input.mode},
      status = ${input.status},
      updated_at = NOW()
    WHERE id = ${id} AND developer_id = ${developerId}
    RETURNING *`;
  return rows[0] ?? null;
}

/** Active rules that could match a delivery from this source. */
export async function activeMappingRules(sql: Sql, developerId: string, sourceId: string): Promise<MappingRule[]> {
  const rows = await sql<MappingRuleRow[]>`
    SELECT * FROM event_mapping_rules
     WHERE developer_id = ${developerId} AND status = 'active'
       AND (source_id IS NULL OR source_id = ${sourceId})
     ORDER BY created_at, id`;
  return rows.map(toRule);
}
