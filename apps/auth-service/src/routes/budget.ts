import type { FastifyInstance } from 'fastify';
import { getSql } from '../db/client.js';
import {
  createBudgetAllocation,
  debitBudget,
  getBudgetBalance,
  listBudgetAllocations,
  listBudgetTransactions,
  InsufficientBudgetError,
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

export async function budgetRoutes(app: FastifyInstance): Promise<void> {
  // GET /v1/budget/allocations — list all budget allocations for the developer
  app.get('/v1/budget/allocations', async (request, reply) => {
    const sql = getSql();
    const allocations = await listBudgetAllocations(sql, request.developer.id);
    return reply.send({ allocations });
  });

  // POST /v1/budget/allocate — create a budget allocation for a grant
  app.post<{ Body: AllocateBody }>('/v1/budget/allocate', async (request, reply) => {
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

    // Verify grant belongs to developer
    const grantRows = await sql`
      SELECT id FROM grants WHERE id = ${grantId} AND developer_id = ${developerId}
    `;
    if (!grantRows[0]) {
      return reply.status(404).send({ message: 'Grant not found', code: 'NOT_FOUND', requestId: request.id });
    }

    try {
      const allocation = await createBudgetAllocation(sql, grantId, developerId, initialBudget, currency);
      return reply.status(201).send(allocation);
    } catch (err) {
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
  app.post<{ Body: DebitBody }>('/v1/budget/debit', async (request, reply) => {
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
    const page = parseInt((request.query as Record<string, string>)['page'] ?? '1', 10);
    const pageSize = parseInt((request.query as Record<string, string>)['pageSize'] ?? '50', 10);

    const result = await listBudgetTransactions(sql, request.params.grantId, developerId, page, pageSize);
    return reply.send(result);
  });
}
