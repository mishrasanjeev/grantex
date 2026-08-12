import type { FastifyInstance } from 'fastify';
import { getSql } from '../db/client.js';
import {
  createBudgetAllocation,
  debitBudget,
  getBudgetBalance,
  listBudgetAllocations,
  listBudgetTransactions,
  InsufficientBudgetError,
  GrantInactiveError,
  GrantNotFoundError,
} from '../lib/budget.js';

interface AllocateBody {
  grantId: string;
  initialBudget: number;
  currency?: string;
}

interface DebitBody {
  grantId: string;
  amount: number;
  description?: string;
  metadata?: Record<string, unknown>;
}

const MAX_PAGE_SIZE = 200;

/** Returns null for anything that is not a whole number >= 1. */
function parsePositiveInt(value: string | undefined, fallback: number): number | null {
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return null;
  return parsed;
}

export async function budgetRoutes(app: FastifyInstance): Promise<void> {
  // GET /v1/budget/allocations — list all budget allocations for the developer
  app.get('/v1/budget/allocations', async (request, reply) => {
    const sql = getSql();
    const allocations = await listBudgetAllocations(sql, request.developer.id);
    return reply.send({ allocations });
  });

  // POST /v1/budget/allocate — create a budget allocation for a grant
  app.post<{ Body: AllocateBody }>('/v1/budget/allocate', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { grantId, initialBudget, currency } = request.body;

    if (!grantId || initialBudget == null || initialBudget <= 0) {
      return reply.status(400).send({
        message: 'grantId and positive initialBudget are required',
        code: 'BAD_REQUEST',
        requestId: request.id,
      });
    }

    const sql = getSql();
    const developerId = request.developer.id;

    try {
      const allocation = await createBudgetAllocation(sql, grantId, developerId, initialBudget, currency);
      return reply.status(201).send(allocation);
    } catch (err) {
      if (err instanceof GrantNotFoundError) {
        return reply.status(404).send({ message: 'Grant not found', code: 'NOT_FOUND', requestId: request.id });
      }
      if (err instanceof GrantInactiveError) {
        return reply.status(409).send({
          message: 'Grant is not active (revoked or expired)',
          code: 'GRANT_INACTIVE',
          requestId: request.id,
        });
      }
      if (err instanceof Error && err.message.includes('unique')) {
        return reply.status(409).send({
          message: 'Budget allocation already exists for this grant',
          code: 'CONFLICT',
          requestId: request.id,
        });
      }
      throw err;
    }
  });

  // POST /v1/budget/debit — debit an amount from a grant's budget
  app.post<{ Body: DebitBody }>('/v1/budget/debit', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { grantId, amount, description, metadata } = request.body;

    if (!grantId || amount == null || amount <= 0) {
      return reply.status(400).send({
        message: 'grantId and positive amount are required',
        code: 'BAD_REQUEST',
        requestId: request.id,
      });
    }

    const sql = getSql();
    const developerId = request.developer.id;

    try {
      const result = await debitBudget(sql, grantId, developerId, amount, description, metadata);
      return reply.send({
        remaining: result.remaining,
        transactionId: result.transactionId,
        grantId,
      });
    } catch (err) {
      if (err instanceof InsufficientBudgetError) {
        return reply.status(402).send({
          message: err.message,
          code: 'INSUFFICIENT_BUDGET',
          requestId: request.id,
        });
      }
      if (err instanceof GrantNotFoundError) {
        return reply.status(404).send({
          message: err.message,
          code: 'NOT_FOUND',
          requestId: request.id,
        });
      }
      if (err instanceof GrantInactiveError) {
        return reply.status(409).send({
          message: err.message,
          code: 'GRANT_INACTIVE',
          requestId: request.id,
        });
      }
      throw err;
    }
  });

  // GET /v1/budget/balance/:grantId — current balance
  app.get<{ Params: { grantId: string } }>('/v1/budget/balance/:grantId', async (request, reply) => {
    const sql = getSql();
    const developerId = request.developer.id;

    const allocation = await getBudgetBalance(sql, request.params.grantId, developerId);
    if (!allocation) {
      return reply.status(404).send({
        message: 'No budget allocation found for this grant',
        code: 'NOT_FOUND',
        requestId: request.id,
      });
    }

    return reply.send(allocation);
  });

  // GET /v1/budget/transactions/:grantId — paginated transaction history
  app.get<{ Params: { grantId: string }; Querystring: { page?: string; pageSize?: string } }>('/v1/budget/transactions/:grantId', async (request, reply) => {
    const sql = getSql();
    const developerId = request.developer.id;
    const query = request.query as Record<string, string | undefined>;

    // These values reach LIMIT/OFFSET directly. Unvalidated, `page=0` produces a
    // negative OFFSET and `page=abc` a NaN one — both are hard Postgres errors
    // surfacing as a 500 — and an unbounded pageSize is a cheap way to ask for
    // the entire table in one request.
    const page = parsePositiveInt(query['page'], 1);
    const pageSize = parsePositiveInt(query['pageSize'], 50);
    if (page === null || pageSize === null || pageSize > MAX_PAGE_SIZE) {
      return reply.status(400).send({
        message: `page must be an integer >= 1 and pageSize an integer between 1 and ${MAX_PAGE_SIZE}`,
        code: 'BAD_REQUEST',
        requestId: request.id,
      });
    }

    const result = await listBudgetTransactions(sql, request.params.grantId, developerId, page, pageSize);
    return reply.send(result);
  });
}
